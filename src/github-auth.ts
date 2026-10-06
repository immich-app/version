import { createAppAuth } from '@octokit/auth-app';
import { REQUEST_TIMEOUT_MS, SourceAuthError, withDeadline } from './sources.js';

const isTimeout = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError';

interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: number;
}

export async function createInstallationToken(config: GitHubAppConfig): Promise<string> {
  const auth = createAppAuth({
    appId: config.appId,
    privateKey: formatPrivateKey(config.privateKey),
    installationId: config.installationId,
  });

  const { token } = await auth({ type: 'installation' });
  return token;
}

// What a GitHub source reads a repository with.
export interface GitHubCredentials {
  // Requests with the same key share a rate limit (see ReleaseSource).
  rateLimitKey: string;
  // The token to send, or undefined to read unauthenticated.
  token(): Promise<string | undefined>;
}

type GitHubAppBindings = Pick<Env, 'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY' | 'GITHUB_APP_INSTALLATION_ID'>;

/**
 * GitHub credentials for one cron run. Every repository is read through the
 * one installation in the GITHUB_APP_* bindings, so they share its token and
 * its rate limit. The token is minted on first use, inside the sync of the
 * project that needs it, so a failure to mint fails that project, not the run.
 * Without the bindings, repositories are read unauthenticated.
 */
export class GitHubTokens {
  private minted?: Promise<string | undefined>;

  constructor(
    private env: GitHubAppBindings,
    private timeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  // Takes the repository so that each owner can get its own installation later;
  // for now they all share one.
  forRepository(_repo: string): GitHubCredentials {
    const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID } = this.env;
    const configured = Boolean(GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY && GITHUB_APP_INSTALLATION_ID);
    return {
      rateLimitKey: configured ? `github-installation:${GITHUB_APP_INSTALLATION_ID}` : 'github-anonymous',
      token: () => (configured ? (this.minted ??= this.mint()) : Promise.resolve(undefined)),
    };
  }

  private async mint(): Promise<string> {
    try {
      return await withDeadline(this.timeoutMs, () =>
        createInstallationToken({
          appId: this.env.GITHUB_APP_ID!,
          privateKey: this.env.GITHUB_APP_PRIVATE_KEY!,
          installationId: Number(this.env.GITHUB_APP_INSTALLATION_ID),
        }),
      );
    } catch (error) {
      // A mint that stalls past its deadline is a timeout, not a credential problem.
      if (isTimeout(error)) {
        throw error;
      }
      throw new SourceAuthError(`GitHub App token: ${error instanceof Error ? error.message : String(error)}`);
    }
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
