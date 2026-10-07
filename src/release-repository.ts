import type { ProjectRelease } from './types.js';

// D1 binds at most 100 parameters per statement, so a multi-row upsert of these
// six columns writes up to 16 rows. A batch counts each statement towards the
// 1000 queries an invocation may run, so a full fetch of 300 releases costs 19.
const UPSERT_COLUMNS = ['project', 'tag', 'published_at', 'source_id', 'forge_prerelease', 'synced_at'];
// D1's clock when the statement runs, in the format toISOString() gives. A
// write is stamped when it lands, not when the worker built it, so a delete
// cut off at an earlier now() can't take a write that landed after it.
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const MAX_BOUND_PARAMETERS = 100;
// synced_at is NOW, not a bound parameter.
const UPSERT_ROWS_PER_STATEMENT = Math.floor(MAX_BOUND_PARAMETERS / (UPSERT_COLUMNS.length - 1));
// A delete binds the project, then its tags.
// The project and the time, then a tag and a source id per release.
const DELETE_RELEASES_PER_STATEMENT = Math.floor((MAX_BOUND_PARAMETERS - 2) / 2);

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
  // Deletes each release by its tag and source id, and only if its row was
  // last written before writtenBefore (a now()): a release replaced under the
  // same tag, or written again under the same id, since then survives. Returns
  // how many rows it removed.
  deleteMany(
    projectId: string,
    releases: readonly Pick<ProjectRelease, 'tag' | 'source_id'>[],
    writtenBefore: string,
  ): Promise<number>;
  // D1's clock now, the same clock writes are stamped with (synced_at).
  now(): Promise<string>;
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
      const row = `(${UPSERT_COLUMNS.map((column) => (column === 'synced_at' ? NOW : '?')).join(', ')})`;
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
            ]),
          ),
      );
    }

    if (statements.length > 0) {
      await this.db.batch(statements);
    }
  }

  async deleteMany(
    projectId: string,
    releases: readonly Pick<ProjectRelease, 'tag' | 'source_id'>[],
    writtenBefore: string,
  ): Promise<number> {
    const statements: D1PreparedStatement[] = [];

    for (let start = 0; start < releases.length; start += DELETE_RELEASES_PER_STATEMENT) {
      const chunk = releases.slice(start, start + DELETE_RELEASES_PER_STATEMENT);
      statements.push(
        this.db
          .prepare(
            `DELETE FROM project_releases WHERE project = ? AND synced_at < ? AND (${chunk.map(() => '(tag = ? AND source_id = ?)').join(' OR ')})`,
          )
          .bind(projectId, writtenBefore, ...chunk.flatMap(({ tag, source_id }) => [tag, source_id])),
      );
    }

    if (statements.length === 0) {
      return 0;
    }
    // The rows it actually removed: a candidate written again since the cutoff stays.
    const results = await this.db.batch(statements);
    return results.reduce((total, { meta }) => total + meta.changes, 0);
  }

  async now(): Promise<string> {
    const row = await this.db.prepare(`SELECT ${NOW} AS now`).first<{ now: string }>();
    return row!.now;
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
