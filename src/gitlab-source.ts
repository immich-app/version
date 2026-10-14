import type { GitLabCredentials } from './gitlab-auth.js';
import {
  confirmGone,
  RateLimitError,
  REQUEST_TIMEOUT_MS,
  requestSignal,
  SourceHttpError,
  USER_AGENT,
  type ConfirmOptions,
  type FetchedReleases,
  type FetchOptions,
  type ReleaseSource,
} from './sources.js';
import type { ProjectRelease } from './types.js';

const MAX_PAGES = 3;
const PER_PAGE = 100;
const RECENT_PER_PAGE = 20;
const HEADERS = { Accept: 'application/json', 'User-Agent': USER_AGENT };

/**
 * A GitLab project's releases, read by the project's id with its read token
 * (anonymously without one, which only works for a public project), newest
 * first (GitLab lists them by released_at). GitLab has no drafts, but it lists
 * a release whose released_at is still to come as upcoming; those are dropped
 * until they are out.
 */
export class GitLabReleasesSource implements ReleaseSource {
  // host/path, for logs.
  private readonly project: string;
  private readonly releasesUrl: string;

  constructor(
    // The instance's hostname (gitlab.futo.org), the project's full path
    // (group/name) and its id. It is read by its id, which survives renames
    // and transfers, so a project that takes up an old path is never read.
    { host, path, projectId }: { host: string; path: string; projectId: number },
    private credentials: GitLabCredentials,
    private timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    this.project = `${host}/${path}`;
    this.releasesUrl = `https://${host}/api/v4/projects/${projectId}/releases`;
  }

  get rateLimitKey() {
    return this.credentials.rateLimitKey;
  }

  async fetchRecent({ signal }: FetchOptions = {}): Promise<ProjectRelease[]> {
    const page = await this.fetchPage(`${this.releasesUrl}?per_page=${RECENT_PER_PAGE}`, signal);
    return page.releases;
  }

  async fetchAll({ signal }: FetchOptions = {}): Promise<FetchedReleases> {
    const releases: ProjectRelease[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${this.releasesUrl}?per_page=${PER_PAGE}&page=${page}`;
      const listed = await this.fetchPage(url, signal);
      releases.push(...listed.releases);
      const after = afterPage(url, page, listed.headers);
      if (after === 'last') {
        return { releases, complete: true };
      }
      if (after === 'unknown') {
        break;
      }
    }

    return { releases, complete: false };
  }

  /**
   * Asks GitLab for each candidate's release by its tag, which is its source
   * id. It is gone if fetchRelease() finds none. A release that is out stays.
   */
  async confirmRetracted(candidates: readonly ProjectRelease[], options?: ConfirmOptions): Promise<ProjectRelease[]> {
    return confirmGone(
      this.project,
      candidates,
      async ({ tag }, signal) => (await this.fetchRelease(tag, signal)) === null,
      options,
    );
  }

  /**
   * The release with this tag, as fetchAll() would list it, or null if GitLab
   * no longer has it (404) or it is upcoming: fetchAll() skips a release that
   * isn't out, so it would never have been stored.
   */
  async fetchRelease(tag: string, signal?: AbortSignal): Promise<ProjectRelease | null> {
    const url = `${this.releasesUrl}/${encodeURIComponent(tag)}`;
    const response = await this.get(url, signal);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      handleErrorResponse(response);
    }

    const release = (await response.json()) as { tag_name?: unknown } | null;
    if (release?.tag_name !== tag) {
      throw new TypeError(`GitLab API error: ${url} is not the release of ${tag}`);
    }
    return parseRelease(release);
  }

  /**
   * A GET from GitLab, with the project's token if it has one. A redirect is
   * never followed: a Worker's fetch would send the token on to wherever it
   * points, and the API's own URLs don't redirect, so one fails as an HTTP
   * error instead.
   */
  private get(url: string, signal?: AbortSignal): Promise<Response> {
    const token = this.credentials.token();
    return fetch(url, {
      headers: token ? { ...HEADERS, 'PRIVATE-TOKEN': token } : HEADERS,
      redirect: 'manual',
      signal: requestSignal(this.timeoutMs, signal),
    });
  }

  // One page of the listing: its releases, and the response's headers.
  private async fetchPage(url: string, signal?: AbortSignal) {
    const response = await this.get(url, signal);

    if (!response.ok) {
      await response.body?.cancel();
      handleErrorResponse(response);
    }

    const items = (await response.json()) as unknown;
    if (!Array.isArray(items)) {
      throw new TypeError(`GitLab API error: ${url} did not list releases`);
    }
    const releases = items.flatMap((item) => {
      const release = parseRelease(item);
      return release ? [release] : [];
    });
    return { releases, headers: response.headers };
  }
}

/**
 * Where the listing goes after `page`, by x-next-page: 'last' when GitLab leaves
 * it empty, 'next' when it names the page after this one, and 'unknown' for
 * anything else: a page further on, one already listed, or no page number. A
 * complete listing decides what a full sync deletes, so one that doesn't go a
 * page at a time to its end stops there, incomplete. Without the header, the
 * listing can't tell whether it is complete, so it fails rather than guess.
 */
function afterPage(url: string, page: number, headers: Headers): 'last' | 'next' | 'unknown' {
  const next = headers.get('x-next-page');
  if (next === null) {
    throw new TypeError(`GitLab API error: ${url} did not say which page is next`);
  }
  if (next === '') {
    return 'last';
  }
  return next === String(page + 1) ? 'next' : 'unknown';
}

function handleErrorResponse(response: Response): never {
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After') ?? response.headers.get('RateLimit-Reset');
    console.error(`[version] GitLab rate limit exceeded. Retry-After: ${retryAfter}`);
    throw new RateLimitError('GitLab API rate limit exceeded', retryAfter);
  }

  throw new SourceHttpError(`GitLab API error: ${response.status} ${response.statusText}`, response.status);
}

// A listed release, or null for anything else and for an upcoming release.
function parseRelease(item: unknown): ProjectRelease | null {
  if (typeof item !== 'object' || item === null) {
    return null;
  }
  const { tag_name, released_at, upcoming_release } = item as Record<string, unknown>;
  if (typeof tag_name !== 'string' || upcoming_release === true) {
    return null;
  }

  return {
    tag: tag_name,
    published_at: String(released_at ?? ''),
    // The API gives a release no id of its own: a project has one per tag.
    source_id: tag_name,
    // GitLab has no prerelease flag.
    forge_prerelease: null,
  };
}
