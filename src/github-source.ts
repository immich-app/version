import type { GitHubCredentials } from './github-auth.js';
import {
  confirmGone,
  RateLimitError,
  REQUEST_TIMEOUT_MS,
  requestSignal,
  SourceHttpError,
  type ConfirmOptions,
  type FetchedReleases,
  type FetchOptions,
  type ReleaseSource,
} from './sources.js';
import type { GitHubRelease, ProjectRelease } from './types.js';

const MAX_PAGES = 3;
const PER_PAGE = 100;
const RECENT_PER_PAGE = 20;

// A GitHub release id, the source_id of a release read from GitHub.
const RELEASE_ID = /^\d+$/;

/**
 * A repository's GitHub releases, newest first (GitHub lists them by creation
 * date). Drafts are dropped; prereleases are kept, for the channels that serve
 * them.
 */
export class GitHubReleasesSource implements ReleaseSource {
  private readonly repo: string;
  private readonly releasesUrl: string;

  constructor(
    // Every request goes by the repository's id, which survives renames and
    // transfers: its owner/name can come to belong to another repository. The
    // name is only for logs.
    repository: { repo: string; repoId: number },
    private credentials: GitHubCredentials,
    private timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    this.repo = repository.repo;
    this.releasesUrl = `https://api.github.com/repositories/${repository.repoId}/releases`;
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
      const listed = await this.fetchPage(`${this.releasesUrl}?per_page=${PER_PAGE}&page=${page}`, signal);
      releases.push(...listed.releases);
      if (listed.length < PER_PAGE) {
        return { releases, complete: true };
      }
    }

    return { releases, complete: false };
  }

  /**
   * Asks GitHub for each candidate's release by its id. It is gone if GitHub no
   * longer has it (404), if it was turned back into a draft, or if it now has
   * another tag than the stored one; a published release under that tag stays.
   */
  async confirmRetracted(candidates: readonly ProjectRelease[], options?: ConfirmOptions): Promise<ProjectRelease[]> {
    return confirmGone(
      this.repo,
      candidates,
      async ({ tag, source_id }, signal) => {
        if (!RELEASE_ID.test(source_id)) {
          throw new TypeError(`${source_id} is not a GitHub release id`);
        }
        const response = await fetch(`${this.releasesUrl}/${source_id}`, {
          headers: await this.buildHeaders(),
          signal: requestSignal(this.timeoutMs, signal),
        });
        if (response.status === 404) {
          await response.body?.cancel();
          return true;
        }
        if (!response.ok) {
          throw await errorFromResponse(response);
        }

        const release = (await response.json()) as unknown;
        if (!isValidRelease(release)) {
          throw new TypeError(`GitHub API error: release ${source_id} is not a release`);
        }
        return release.draft === true || release.tag_name !== tag;
      },
      options,
    );
  }

  // One page of the listing: its releases, and how many items it had, drafts included.
  private async fetchPage(url: string, signal?: AbortSignal) {
    const response = await fetch(url, {
      headers: await this.buildHeaders(),
      signal: requestSignal(this.timeoutMs, signal),
    });

    if (!response.ok) {
      throw await errorFromResponse(response);
    }

    const items = (await response.json()) as unknown;
    if (!Array.isArray(items)) {
      throw new TypeError(`GitHub API error: ${url} did not list releases`);
    }
    const releases = items.flatMap((item) => {
      const release = parseRelease(item);
      return release ? [toProjectRelease(release)] : [];
    });
    return { releases, length: items.length };
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'futo-version-service',
    };

    const token = await this.credentials.token();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return headers;
  }
}

// GitHub's message for a secondary rate limit, e.g. "You have exceeded a secondary rate limit."
const SECONDARY_RATE_LIMIT = /\bsecondary rate limit\b/i;

/**
 * A rate limit is a 429, or a 403 that says to wait: with no requests left (the
 * primary limit), or with Retry-After or the message of a secondary limit, which
 * leaves requests remaining. Any other 403 is a denied request. See
 * https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#rate-limit-errors
 */
async function errorFromResponse(response: Response): Promise<Error> {
  const { status, headers } = response;
  // Only a 403's message tells a secondary rate limit from a denied request.
  let message = '';
  if (status === 403) {
    try {
      message = await response.text();
    } catch {
      // Unread, as when the connection resets, it leaves the headers to decide.
    }
  } else {
    await response.body?.cancel();
  }

  const isRateLimit =
    status === 429 ||
    (status === 403 &&
      (headers.get('X-RateLimit-Remaining') === '0' ||
        headers.has('Retry-After') ||
        SECONDARY_RATE_LIMIT.test(message)));

  if (isRateLimit) {
    const retryAfter = headers.get('Retry-After') ?? headers.get('X-RateLimit-Reset');
    console.error(`[version] GitHub rate limit exceeded. Retry-After: ${retryAfter}`);
    return new RateLimitError('GitHub API rate limit exceeded', retryAfter);
  }

  return new SourceHttpError(`GitHub API error: ${status} ${response.statusText}`, status);
}

function isValidRelease(data: unknown): data is Record<string, unknown> & { id: number; tag_name: string } {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return typeof obj.id === 'number' && typeof obj.tag_name === 'string';
}

function parseRelease(item: unknown): GitHubRelease | null {
  if (!isValidRelease(item)) {
    return null;
  }
  // Drafts are skipped, but pre-releases (rc builds) are kept to back the `rc` channel.
  if (item.draft === true) {
    return null;
  }

  return {
    id: item.id,
    tag_name: item.tag_name,
    published_at: String(item.published_at ?? ''),
    prerelease: item.prerelease === true,
  };
}

export function toProjectRelease(release: GitHubRelease): ProjectRelease {
  return {
    tag: release.tag_name,
    published_at: release.published_at,
    source_id: String(release.id),
    forge_prerelease: release.prerelease,
  };
}
