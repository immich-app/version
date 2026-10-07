import type { ProjectRelease } from './types.js';

// Every request to a forge gives up after this long, so one hung connection
// can't hold a cron run until Cloudflare kills it.
export const REQUEST_TIMEOUT_MS = 10_000;

// The most releases one sync asks its source about (confirmRetracted()), a
// request each, so a listing that leaves out many can't fan out into hundreds
// of requests. The rest wait for the next full sync.
export const MAX_RETRACTION_CHECKS = 20;

// How long one sync's retraction checks may take in all (confirmGone()). The
// check still running then is given up, and it and the rest are kept for the
// next full sync, so slow answers can't run the sync past its deadline.
export const RETRACTION_CHECK_BUDGET_MS = 20_000;

export interface FetchedReleases {
  releases: ProjectRelease[];
  // False when the listing stopped at its page cap, so older releases exist
  // that it didn't reach.
  complete: boolean;
}

export interface FetchOptions {
  // Aborts every request still running, e.g. at the project's sync deadline.
  signal?: AbortSignal;
}

export interface ConfirmOptions extends FetchOptions {
  // How long the checks may take in all, RETRACTION_CHECK_BUDGET_MS unless given.
  budgetMs?: number;
}

/**
 * Where a project's releases come from (`source` in projects.json). Drafts are
 * never returned. Both listings put the newest release first.
 */
export interface ReleaseSource {
  // Sources that share a rate limit share this key, so a run stops asking them
  // once one of them hits it.
  readonly rateLimitKey: string;
  // The newest releases, prereleases included: one page of 20.
  fetchRecent(options?: FetchOptions): Promise<ProjectRelease[]>;
  // Every release up to the cap: at most 3 pages of 100.
  fetchAll(options?: FetchOptions): Promise<FetchedReleases>;
  // Of the stored releases a complete listing left out, the ones the source
  // confirms are gone, asking about each by itself. Pages are offsets, so a
  // release deleted mid-listing shifts the rest and one that still exists can
  // go unlisted: absence alone deletes nothing. See confirmGone().
  confirmRetracted(candidates: readonly ProjectRelease[], options?: ConfirmOptions): Promise<ProjectRelease[]>;
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    public retryAfter: string | null = null,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class SourceHttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'SourceHttpError';
  }
}

// The source's credentials couldn't be obtained, such as a GitHub App token.
export class SourceAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceAuthError';
  }
}

const TIMED_OUT = Symbol('timed out');

/**
 * Runs `work` with a signal that aborts after `ms`, and gives up on it then,
 * whether or not it listens to the signal: a D1 call can't be aborted, but the
 * caller stops waiting for it. Rejects with the signal's TimeoutError.
 */
export async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  // Resolves rather than rejects, so it can't go unhandled once the work has settled.
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    signal.addEventListener('abort', () => resolve(TIMED_OUT), { once: true });
  });
  const result = await Promise.race([work(signal), deadline]);
  if (result === TIMED_OUT) {
    throw signal.reason;
  }
  return result;
}

// A request signal: the request's own timeout, and the caller's signal if any.
export function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/**
 * Asks about each candidate in turn (`isGone`, one request each, on the signal
 * it is given) and returns the ones confirmed gone. Anything short of an answer
 * keeps a candidate: an unexpected status, a network error, a request that
 * times out. Once the checks have taken `budgetMs` in all, the one running is
 * given up, even one that ignores its signal, and it and the rest are kept. A rate limit is thrown, which ends the
 * checks and makes the run skip the source's other projects, and so is the
 * caller's signal once it aborts. `label` names the source in the log.
 */
const STOPPED = Symbol('stopped');

export async function confirmGone(
  label: string,
  candidates: readonly ProjectRelease[],
  isGone: (candidate: ProjectRelease, signal: AbortSignal) => Promise<boolean>,
  { signal, budgetMs = RETRACTION_CHECK_BUDGET_MS }: ConfirmOptions = {},
): Promise<ProjectRelease[]> {
  const budget = AbortSignal.timeout(budgetMs);
  const checks = signal ? AbortSignal.any([budget, signal]) : budget;
  // Settles once the checks are out of time or the caller aborts, so a check
  // that doesn't stop on its signal is still given up. It resolves rather than
  // rejects, so the checks it outlives leave no unhandled rejection behind.
  const stopped = new Promise<typeof STOPPED>((resolve) => {
    checks.addEventListener('abort', () => resolve(STOPPED), { once: true });
  });
  const gone: ProjectRelease[] = [];
  for (const [index, candidate] of candidates.entries()) {
    try {
      // The caller's abort first: an already-aborted signal never fires `stopped`.
      signal?.throwIfAborted();
      budget.throwIfAborted();
      const answer = await Promise.race([isGone(candidate, checks), stopped]);
      if (answer === STOPPED) {
        checks.throwIfAborted();
      }
      if (answer === true) {
        gone.push(candidate);
      }
    } catch (error) {
      if (error instanceof RateLimitError) {
        throw error;
      }
      // Every check is a request on the caller's signal, so this is where its abort shows.
      signal?.throwIfAborted();
      if (budget.aborted) {
        const kept = candidates.slice(index).map(({ tag }) => tag);
        console.error(`[version] ${label}: out of time to confirm releases gone, kept ${kept.join(', ')}`);
        break;
      }
      console.error(`[version] ${label}: kept ${candidate.tag}, which could not be confirmed gone:`, error);
    }
  }
  return gone;
}

export type ErrorClass = 'rate_limited' | 'auth' | 'not_found' | 'http' | 'timeout' | 'd1' | 'other';

const HTTP_ERROR_CLASSES: Partial<Record<number, ErrorClass>> = { 401: 'auth', 403: 'auth', 404: 'not_found' };

/**
 * Why a sync failed, from a fixed set, so the error can be a metric tag: a raw
 * message would make a new series per error.
 */
export function errorClass(error: unknown): ErrorClass {
  if (error instanceof RateLimitError) {
    return 'rate_limited';
  }
  if (error instanceof SourceAuthError) {
    return 'auth';
  }
  if (error instanceof SourceHttpError) {
    return HTTP_ERROR_CLASSES[error.status] ?? 'http';
  }
  const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown };
  // A timed-out signal's reason, which fetch and withDeadline reject with.
  if (name === 'TimeoutError' || name === 'AbortError') {
    return 'timeout';
  }
  // D1 prefixes its errors, e.g. "D1_ERROR: no such table".
  return typeof message === 'string' && /\bD1_[A-Z_]*ERROR\b/.test(message) ? 'd1' : 'other';
}
