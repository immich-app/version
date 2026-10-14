import { SourceAuthError } from './sources.js';

// What a GitLab project is read with: its read token, or none.
export interface GitLabCredentials {
  // A project access token is a bot user of its own, so it is rate limited on
  // its own. GitLab limits unauthenticated reads per IP, so every anonymous
  // read of a host shares one limit.
  rateLimitKey: string;
  // The token, or undefined to read anonymously. Throws SourceAuthError when
  // the tokens binding can't be read, so the project's sync counts as auth.
  token: () => string | undefined;
}

/**
 * The read tokens OpenTofu creates for every GitLab project in projects.json,
 * from the GITLAB_TOKENS binding: a JSON object of "host/projectId" to token. A
 * project without one is read anonymously, which only works if it is public.
 * PR stages get no tokens.
 */
export class GitLabTokens {
  private parsed?: ReadonlyMap<string, string> | SourceAuthError;

  constructor(private raw: string | undefined) {}

  forProject({ host, projectId }: { host: string; projectId: number }): GitLabCredentials {
    this.parsed ??= parseTokens(this.raw);
    const tokens = this.parsed;
    if (tokens instanceof SourceAuthError) {
      return {
        rateLimitKey: `gitlab:${host}:${projectId}`,
        token: () => {
          throw tokens;
        },
      };
    }

    const token = tokens.get(`${host}/${projectId}`);
    return token
      ? { rateLimitKey: `gitlab:${host}:${projectId}`, token: () => token }
      : { rateLimitKey: `gitlab-anonymous:${host}`, token: () => {} };
  }
}

function parseTokens(raw: string | undefined): ReadonlyMap<string, string> | SourceAuthError {
  if (!raw) {
    return new Map();
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.every(([, token]) => typeof token === 'string' && token !== '')) {
      return new Map(entries as [string, string][]);
    }
  }
  // Never the binding itself in the message: it holds the tokens.
  return new SourceAuthError('GITLAB_TOKENS is not a JSON object of "host/projectId" to token');
}
