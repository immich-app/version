import type { ProjectRelease } from './types.js';

// D1 binds at most 100 parameters per statement, so a multi-row upsert of these
// six columns writes up to 16 rows. A batch counts each statement towards the
// 1000 queries an invocation may run, so a full fetch of 300 releases costs 19.
const UPSERT_COLUMNS = ['project', 'tag', 'published_at', 'source_id', 'forge_prerelease', 'synced_at'];
const MAX_BOUND_PARAMETERS = 100;
const UPSERT_ROWS_PER_STATEMENT = Math.floor(MAX_BOUND_PARAMETERS / UPSERT_COLUMNS.length);

interface ProjectReleaseRow {
  tag: string;
  published_at: string;
  source_id: string;
  forge_prerelease: number | null;
}

export interface IReleaseRepository {
  // Every stored release of the project, in no particular order: versions are
  // ordered in JS by the project's scheme (src/releases.ts).
  list(projectId: string): Promise<ProjectRelease[]>;
  // Inserts the releases, or updates the stored ones with the same tag.
  upsertMany(projectId: string, releases: readonly ProjectRelease[]): Promise<void>;
  // When the project last finished a full fetch from its source, or null if it never has.
  getFullSyncedAt(projectId: string): Promise<string | null>;
  markFullSynced(projectId: string): Promise<void>;
}

export class ReleaseRepository implements IReleaseRepository {
  constructor(private db: D1Database) {}

  async list(projectId: string): Promise<ProjectRelease[]> {
    const { results } = await this.db
      .prepare('SELECT tag, published_at, source_id, forge_prerelease FROM project_releases WHERE project = ?1')
      .bind(projectId)
      .all<ProjectReleaseRow>();

    return results.map((row) => ({
      ...row,
      forge_prerelease: row.forge_prerelease === null ? null : row.forge_prerelease !== 0,
    }));
  }

  async upsertMany(projectId: string, releases: readonly ProjectRelease[]): Promise<void> {
    const syncedAt = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];

    for (let start = 0; start < releases.length; start += UPSERT_ROWS_PER_STATEMENT) {
      const chunk = releases.slice(start, start + UPSERT_ROWS_PER_STATEMENT);
      // A forge release whose tag was edited arrives with the same source id
      // under a new tag. Drop its rows under any other tag in the same batch, so
      // the old tag can't stay the latest.
      const sourced = chunk.filter((release) => release.source_id !== '');
      if (sourced.length > 0) {
        statements.push(
          this.db
            .prepare(
              `DELETE FROM project_releases WHERE project = ? AND (${sourced
                .map(() => '(source_id = ? AND tag <> ?)')
                .join(' OR ')})`,
            )
            .bind(projectId, ...sourced.flatMap((release) => [release.source_id, release.tag])),
        );
      }
      const row = `(${UPSERT_COLUMNS.map(() => '?').join(', ')})`;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO project_releases (${UPSERT_COLUMNS.join(', ')})
             VALUES ${chunk.map(() => row).join(', ')}
             ON CONFLICT (project, tag) DO UPDATE SET
               published_at = excluded.published_at,
               source_id = excluded.source_id,
               forge_prerelease = excluded.forge_prerelease,
               synced_at = excluded.synced_at`,
          )
          .bind(
            ...chunk.flatMap((release) => [
              projectId,
              release.tag,
              release.published_at,
              release.source_id,
              release.forge_prerelease === null ? null : Number(release.forge_prerelease),
              syncedAt,
            ]),
          ),
      );
    }

    if (statements.length > 0) {
      await this.db.batch(statements);
    }
  }

  async getFullSyncedAt(projectId: string): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT full_synced_at FROM project_sync_state WHERE project = ?1')
      .bind(projectId)
      .first<{ full_synced_at: string | null }>();
    return row?.full_synced_at ?? null;
  }

  async markFullSynced(projectId: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO project_sync_state (project, full_synced_at) VALUES (?1, ?2)
         ON CONFLICT (project) DO UPDATE SET full_synced_at = excluded.full_synced_at`,
      )
      .bind(projectId, new Date().toISOString())
      .run();
  }
}
