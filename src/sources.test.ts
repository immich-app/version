import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmGone,
  errorClass,
  RateLimitError,
  requestSignal,
  SourceAuthError,
  SourceHttpError,
  withDeadline,
  type ErrorClass,
} from './sources.js';
import type { ProjectRelease } from './types.js';

const timedOut = async () => {
  const signal = AbortSignal.timeout(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return signal.reason as unknown;
};

const d1Error = async () => {
  try {
    await env.VERSION_DB.prepare('SELECT * FROM no_such_table').all();
  } catch (error) {
    return error;
  }
  throw new Error('expected D1 to fail');
};

describe('errorClass', () => {
  it.each<[string, () => unknown, ErrorClass]>([
    ['a rate limit', () => new RateLimitError('GitHub API rate limit exceeded'), 'rate_limited'],
    ['a token that could not be minted', () => new SourceAuthError('GitHub App token: bad key'), 'auth'],
    ['a 401', () => new SourceHttpError('GitHub API error: 401', 401), 'auth'],
    ['a 403', () => new SourceHttpError('GitHub API error: 403', 403), 'auth'],
    ['a 404', () => new SourceHttpError('GitHub API error: 404', 404), 'not_found'],
    ['a 500', () => new SourceHttpError('GitHub API error: 500', 500), 'http'],
    ['a timed-out signal', timedOut, 'timeout'],
    ['an aborted request', () => new DOMException('aborted', 'AbortError'), 'timeout'],
    ['a D1 error', d1Error, 'd1'],
    ['any other error', () => new TypeError('Network connection lost'), 'other'],
    ['a thrown string', () => 'D1_ERROR', 'other'],
    ['null', () => null, 'other'],
  ])('classifies %s', async (_, error, expected) => {
    expect(errorClass(await error())).toBe(expected);
  });
});

describe('withDeadline', () => {
  it('resolves with the work when it finishes in time', async () => {
    expect(await withDeadline(1000, () => Promise.resolve('done'))).toBe('done');
  });

  it("rejects with the work's own error", async () => {
    await expect(withDeadline(1000, () => Promise.reject(new Error('failed')))).rejects.toThrow('failed');
  });

  it('leaves no rejection behind when the work fails before its deadline', async () => {
    const unhandled = vi.fn();
    addEventListener('unhandledrejection', unhandled);
    try {
      await expect(
        withDeadline(10, () => {
          throw new Error('failed at once');
        }),
      ).rejects.toThrow('failed at once');
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      removeEventListener('unhandledrejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('gives up on work that ignores its signal, and aborts the signal', async () => {
    let signal: AbortSignal | undefined;
    const work = withDeadline(20, (given) => {
      signal = given;
      return new Promise<never>(() => {});
    });

    await expect(work).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(signal?.aborted).toBe(true);
  });
});

describe('requestSignal', () => {
  it('times out on its own', async () => {
    const signal = requestSignal(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signal.reason).toMatchObject({ name: 'TimeoutError' });
  });

  it("aborts with the caller's signal", () => {
    const caller = new AbortController();
    const signal = requestSignal(60_000, caller.signal);
    caller.abort(new DOMException('deadline', 'TimeoutError'));
    expect(signal.aborted).toBe(true);
  });
});

const candidate = (tag: string): ProjectRelease => ({
  tag,
  published_at: '2025-01-01T00:00:00Z',
  source_id: tag,
  forge_prerelease: null,
});

// A check that only ends when its signal aborts, as a hung request does.
const hang = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));

describe('confirmGone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives up on the check running once the checks have taken their budget, and keeps it and the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const isGone = vi.fn(({ tag }: ProjectRelease, signal: AbortSignal) =>
      tag === 'v1' ? Promise.resolve(true) : hang(signal),
    );

    const gone = await confirmGone('futo-org/example', [candidate('v1'), candidate('v2'), candidate('v3')], isGone, {
      budgetMs: 20,
    });

    expect(gone).toEqual([candidate('v1')]);
    expect(isGone).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('[version] futo-org/example: out of time to confirm releases gone, kept v2, v3');
  });

  it('takes no answer that comes after the budget, and starts no check once it has passed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The first check ignores its signal and answers after the budget.
    const isGone = vi.fn(() => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 40)));

    const gone = await confirmGone('futo-org/example', [candidate('v1'), candidate('v2')], isGone, { budgetMs: 10 });

    expect(gone).toEqual([]);
    expect(isGone).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('[version] futo-org/example: out of time to confirm releases gone, kept v1, v2');
  });

  it('returns at its budget even when a check never settles and ignores its signal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const isGone = vi.fn(() => new Promise<boolean>(() => {}));
    const started = Date.now();

    const gone = await confirmGone('futo-org/example', [candidate('v1'), candidate('v2')], isGone, { budgetMs: 20 });

    expect(gone).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rejects an already-aborted caller without starting a check', async () => {
    const caller = new AbortController();
    caller.abort(new DOMException('deadline', 'TimeoutError'));
    // Answers yes and ignores its signal, so nothing but the abort stops it.
    const isGone = vi.fn(() => Promise.resolve(true));

    await expect(
      confirmGone('futo-org/example', [candidate('v1')], isGone, { signal: caller.signal }),
    ).rejects.toMatchObject({ name: 'TimeoutError', message: 'deadline' });
    expect(isGone).not.toHaveBeenCalled();
  });

  it("throws the caller's abort rather than keep the rest", async () => {
    const caller = new AbortController();
    const isGone = vi.fn((_: ProjectRelease, signal: AbortSignal) => hang(signal));

    const checks = confirmGone('futo-org/example', [candidate('v1'), candidate('v2')], isGone, {
      signal: caller.signal,
    });
    caller.abort(new DOMException('deadline', 'TimeoutError'));

    await expect(checks).rejects.toMatchObject({ name: 'TimeoutError', message: 'deadline' });
    expect(isGone).toHaveBeenCalledOnce();
  });
});
