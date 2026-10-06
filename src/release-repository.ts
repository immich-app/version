import { parse, SemVer } from 'semver';
import type { GitHubRelease } from './types.js';

// The releases table still has the name, url, body and created_at columns that
// only /changelog read. Writes leave them at their '' defaults.
interface ReleaseRow {
  id: number;
  tag_name: string;
  published_at: string;
}

export const releaseChannels = ['stable', 'rc'] as const;
export type ReleaseChannel = (typeof releaseChannels)[number];

export interface IReleaseRepository {
  getLatest(channel?: ReleaseChannel): Promise<GitHubRelease | null>;
  getLatestPatchPerMinor(min: SemVer): Promise<SemVer[]>;
  getCount(): Promise<number>;
  upsert(release: GitHubRelease): Promise<void>;
  bulkUpsert(releases: GitHubRelease[]): Promise<void>;
}

export class ReleaseRepository implements IReleaseRepository {
  constructor(private db: D1Database) {}

  async getLatest(channel: ReleaseChannel = 'stable'): Promise<GitHubRelease | null> {
    // The `rc` channel sees every release; `stable` only sees rows without a prerelease component.
    // Within the same major.minor.patch a stable release outranks its own pre-releases (1.0.0 > 1.0.0-rc.1),
    // so order stable (prerelease IS NULL) ahead of pre-releases before falling back to the prerelease number.
    const row = await this.db
      .prepare(
        `SELECT id, tag_name, published_at FROM releases
         WHERE ?1 = 'rc' OR prerelease IS NULL
         ORDER BY major DESC, minor DESC, patch DESC, (prerelease IS NULL) DESC, prerelease DESC
         LIMIT 1`,
      )
      .bind(channel)
      .first<ReleaseRow>();

    return row ? toGitHubRelease(row) : null;
  }

  async getCount(): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) as count FROM releases').first<{ count: number }>();
    return row?.count ?? 0;
  }

  async getLatestPatchPerMinor(min: SemVer): Promise<SemVer[]> {
    const { results } = await this.db
      .prepare(
        `SELECT major, minor, MAX(patch) AS patch FROM releases
         WHERE prerelease IS NULL
           AND (
             major > ?1
             OR (major = ?1 AND minor > ?2)
             OR (major = ?1 AND minor = ?2 AND patch >= ?3)
           )
         GROUP BY major, minor
         ORDER BY major DESC, minor DESC`,
      )
      .bind(min.major, min.minor, min.patch)
      .all<{ major: number; minor: number; patch: number }>();

    return results.map(({ major, minor, patch }) => new SemVer(`${major}.${minor}.${patch}`));
  }

  async upsert(release: GitHubRelease): Promise<void> {
    const semver = parse(release.tag_name);
    if (!semver) {
      return;
    }

    await this.db
      .prepare(
        `INSERT OR REPLACE INTO releases (id, tag_name, published_at, major, minor, patch, prerelease)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        release.id,
        release.tag_name,
        release.published_at,
        semver.major,
        semver.minor,
        semver.patch,
        semver.prerelease[1] ?? null,
      )
      .run();
  }

  async bulkUpsert(releases: GitHubRelease[]): Promise<void> {
    const statements: D1PreparedStatement[] = [];

    for (const release of releases) {
      const semver = parse(release.tag_name);
      if (!semver) {
        continue;
      }

      statements.push(
        this.db
          .prepare(
            `INSERT OR REPLACE INTO releases (id, tag_name, published_at, major, minor, patch, prerelease)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          )
          .bind(
            release.id,
            release.tag_name,
            release.published_at,
            semver.major,
            semver.minor,
            semver.patch,
            semver.prerelease[1] ?? null,
          ),
      );
    }

    if (statements.length > 0) {
      await this.db.batch(statements);
    }
  }
}

function toGitHubRelease(row: ReleaseRow): GitHubRelease {
  return {
    id: row.id,
    tag_name: row.tag_name,
    published_at: row.published_at,
  };
}
