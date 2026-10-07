import { createAppAuth } from '@octokit/auth-app';
import { errorFromResponse } from './github-source.js';
import {
  RateLimitError,
  REQUEST_TIMEOUT_MS,
  requestSignal,
  SourceAuthError,
  USER_AGENT,
  withDeadline,
} from './sources.js';

const GITHUB_API = 'https://api.github.com';

const isTimeout = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError';

// What a GitHub source reads a repository with.
export interface GitHubCredentials {
  // Requests with the same key share a rate limit (see ReleaseSource).
  rateLimitKey: string;
  // The token to send, or undefined to read unauthenticated.
  token(): Promise<string | undefined>;
}

type GitHubAppBindings = Pick<Env, 'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY'>;
type AppAuth = ReturnType<typeof createAppAuth>;

/**
 * GitHub credentials for one cron run, from the version service's own GitHub
 * App (the GITHUB_APP_* bindings). The app is installed on every owner whose
 * repositories the registry reads, and a repository is read with its owner's
 * installation token. An app has one installation per owner, each with its own
 * rate limit, so the owner keys both.
 *
 * The run finds an owner's installation from the first of its repositories it
 * reads, with the app's JWT, and mints its token then, inside the sync of the
 * project that needs it: a failure fails that owner's projects, not the run.
 * Both are kept for the rest of the run. Without the bindings, repositories are
 * read unauthenticated.
 */
export class GitHubTokens {
  private app?: AppAuth;
  // Owner -> its installation's token.
  private readonly tokens = new Map<string, Promise<string>>();
  // Set once an installation lookup hits GitHub's rate limit. Every lookup goes
  // out on the app's JWT, so none is tried again this run; tokens already minted
  // for other owners keep working.
  private lookupRateLimit?: RateLimitError;

  constructor(
    private env: GitHubAppBindings,
    private timeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  // repo is owner/name.
  forRepository(repo: string): GitHubCredentials {
    if (!this.env.GITHUB_APP_ID || !this.env.GITHUB_APP_PRIVATE_KEY) {
      return { rateLimitKey: 'github-anonymous', token: () => Promise.resolve(undefined) };
    }

    // GitHub ignores the case of owner names.
    const owner = repo.split('/', 1)[0].toLowerCase();
    return {
      rateLimitKey: `github-installation:${owner}`,
      token: () => {
        let token = this.tokens.get(owner);
        if (!token) {
          // Shared by the owner's repositories once minted, but a failure is
          // this repository's (the app may be installed on selected ones only),
          // so it is dropped and the owner's next repository looks for itself.
          token = this.mint(repo);
          this.tokens.set(owner, token);
          void this.forgetOnFailure(owner, token);
        }
        return token;
      },
    };
  }

  // Drops a token that failed to mint, unless a newer one has replaced it.
  private async forgetOnFailure(owner: string, token: Promise<string>): Promise<void> {
    try {
      await token;
    } catch {
      if (this.tokens.get(owner) === token) {
        this.tokens.delete(owner);
      }
    }
  }

  private async mint(repo: string): Promise<string> {
    if (this.lookupRateLimit) {
      throw this.lookupRateLimit;
    }
    try {
      const app = (this.app ??= createAppAuth({
        appId: this.env.GITHUB_APP_ID!,
        privateKey: formatPrivateKey(this.env.GITHUB_APP_PRIVATE_KEY!),
      }));
      const installationId = await this.findInstallation(app, repo);
      const { token } = await withDeadline(this.timeoutMs, () => app({ type: 'installation', installationId }));
      return token;
    } catch (error) {
      // A mint that stalls past its deadline is a timeout, not a credential problem.
      if (isTimeout(error)) {
        throw error;
      }
      // A rate limit, so the run skips the projects that share it instead of
      // counting an auth failure.
      if (error instanceof RateLimitError) {
        this.lookupRateLimit = error;
        throw error;
      }
      throw new SourceAuthError(`GitHub App token: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // The id of the app's installation that covers the repository. It goes by
  // the registered owner/name, since an installation belongs to an owner: that
  // only picks the token, and every read still goes by the repository's id.
  private async findInstallation(app: AppAuth, repo: string): Promise<number> {
    const { token: jwt } = await app({ type: 'app' });
    const response = await fetch(`${GITHUB_API}/repos/${repo}/installation`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT, Authorization: `Bearer ${jwt}` },
      signal: requestSignal(this.timeoutMs),
    });

    if (response.status === 404) {
      await response.body?.cancel();
      throw new Error(`the app is not installed on ${repo}`);
    }
    if (!response.ok) {
      // Told apart from a denied lookup by the same rules as a release request.
      const error = await errorFromResponse(response);
      throw error instanceof RateLimitError
        ? error
        : new Error(`installation of ${repo}: ${response.status} ${response.statusText}`);
    }

    const { id } = (await response.json()) as { id?: unknown };
    if (typeof id !== 'number') {
      throw new TypeError(`installation of ${repo}: no id`);
    }
    return id;
  }
}

function formatPrivateKey(key: string): string {
  let formatted = key.trim();
  if (!formatted.includes('\n') && formatted.includes('-----BEGIN')) {
    formatted = formatted
      .replace(/-----BEGIN RSA PRIVATE KEY-----/, '-----BEGIN RSA PRIVATE KEY-----\n')
      .replace(/-----END RSA PRIVATE KEY-----/, '\n-----END RSA PRIVATE KEY-----')
      .replace(/-----BEGIN PRIVATE KEY-----/, '-----BEGIN PRIVATE KEY-----\n')
      .replace(/-----END PRIVATE KEY-----/, '\n-----END PRIVATE KEY-----');
  }
  return formatted;
}
