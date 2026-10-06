import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReleaseRepository } from './release-repository.js';
import type { ProjectRelease } from './types.js';

const db = env.VERSION_DB;
const repository = new ReleaseRepository(db);

const release = (tag: string, overrides: Partial<ProjectRelease> = {}): ProjectRelease => ({
  tag,
  published_at: '2025-01-01T00:00:00Z',
  // Every forge release has its own id; a fixed one would make them all one release retagged.
  source_id: `id-${tag}`,
  forge_prerelease: false,
  ...overrides,
});

const byTag = (a: ProjectRelease, b: ProjectRelease) => a.tag.localeCompare(b.tag);

// list() promises no order, so tests sort what it returns.
async function listed(project: string) {
  const releases = await repository.list(project);
  releases.sort(byTag);
  return releases;
}

async function tags(project: string) {
  const releases = await listed(project);
  return releases.map(({ tag }) => tag);
}

async function syncedAt(project: string, tag: string) {
  const row = await db
    .prepare('SELECT synced_at FROM project_releases WHERE project = ?1 AND tag = ?2')
    .bind(project, tag)
    .first<{ synced_at: string }>();
  return row?.synced_at;
}

// Passes everything through to D1, recording the SQL it prepares and the size of each batch.
function recordingDatabase() {
  const prepared: string[] = [];
  const batches: number[] = [];
  const database = {
    prepare: (sql: string) => {
      prepared.push(sql);
      return db.prepare(sql);
    },
    batch: (statements: D1PreparedStatement[]) => {
      batches.push(statements.length);
      return db.batch(statements);
    },
  } as unknown as D1Database;
  return { database, prepared, batches };
}

describe('ReleaseRepository', () => {
  beforeEach(async () => {
    await db.exec('DELETE FROM project_releases');
    await db.exec('DELETE FROM project_sync_state');
  });

  it("lists only the project's own releases", async () => {
    await repository.upsertMany('immich', [release('v1.0.0'), release('v1.1.0')]);
    await repository.upsertMany('futo-notes', [release('v1.8.0')]);

    expect(await listed('immich')).toEqual([release('v1.0.0'), release('v1.1.0')]);
    expect(await repository.list('futo-notes')).toEqual([release('v1.8.0')]);
    expect(await repository.list('unknown')).toEqual([]);
  });

  it('keeps two projects with the same tag apart', async () => {
    await repository.upsertMany('immich', [release('v1.0.0', { published_at: 'immich', source_id: '1' })]);
    await repository.upsertMany('futo-notes', [release('v1.0.0', { published_at: 'notes', source_id: 'v1.0.0' })]);
    await repository.upsertMany('immich', [release('v1.0.0', { published_at: 'immich again', source_id: '1' })]);

    expect(await repository.list('immich')).toEqual([
      release('v1.0.0', { published_at: 'immich again', source_id: '1' }),
    ]);
    expect(await repository.list('futo-notes')).toEqual([
      release('v1.0.0', { published_at: 'notes', source_id: 'v1.0.0' }),
    ]);
  });

  it('updates a stored release in place and stamps when it was written', async () => {
    await repository.upsertMany('immich', [release('v1.0.0')]);
    await db.exec("UPDATE project_releases SET synced_at = 'before'");

    const changed = release('v1.0.0', { published_at: '2025-02-01T00:00:00Z', source_id: '2', forge_prerelease: true });
    await repository.upsertMany('immich', [changed]);

    expect(await repository.list('immich')).toEqual([changed]);
    expect(await syncedAt('immich', 'v1.0.0')).not.toBe('before');
  });

  it('stores the forge prerelease flag as true, false or unknown', async () => {
    const releases = [
      release('v1.0.0', { forge_prerelease: true }),
      release('v1.1.0', { forge_prerelease: false }),
      release('v1.2.0', { forge_prerelease: null }),
    ];
    await repository.upsertMany('immich', releases);

    expect(await listed('immich')).toEqual(releases);
  });

  it('splits a large upsert into statements of at most 100 bound parameters, in one batch', async () => {
    const { database, prepared, batches } = recordingDatabase();
    const releases = Array.from({ length: 300 }, (_, index) => release(`v1.${index}.0`));

    await new ReleaseRepository(database).upsertMany('immich', releases);

    // 19 chunks of 16 rows, each a delete of retagged rows and an upsert.
    expect(batches).toEqual([38]);
    expect(prepared).toHaveLength(38);
    for (const sql of prepared) {
      expect(sql.match(/\?/g)?.length).toBeLessThanOrEqual(100);
    }
    releases.sort(byTag);
    expect(await listed('immich')).toEqual(releases);
  });

  it("replaces a release's row when the forge release is retagged", async () => {
    await repository.upsertMany('immich', [release('v2.0.0', { source_id: '42' }), release('v1.9.0')]);
    await repository.upsertMany('immich', [release('v1.0.0', { source_id: '42' })]);

    expect(await tags('immich')).toEqual(['v1.0.0', 'v1.9.0']);
  });

  it("only replaces retagged rows within the release's own project", async () => {
    await repository.upsertMany('immich', [release('v2.0.0', { source_id: '42' })]);
    await repository.upsertMany('futo-notes', [release('v1.0.0', { source_id: '42' })]);

    expect(await tags('immich')).toEqual(['v2.0.0']);
    expect(await tags('futo-notes')).toEqual(['v1.0.0']);
  });

  it('never treats releases without a source id as the same release', async () => {
    await repository.upsertMany('immich', [release('v2.0.0', { source_id: '' })]);
    await repository.upsertMany('immich', [release('v1.0.0', { source_id: '' })]);

    expect(await tags('immich')).toEqual(['v1.0.0', 'v2.0.0']);
  });

  it('writes nothing for an empty list', async () => {
    const { database, batches } = recordingDatabase();

    await new ReleaseRepository(database).upsertMany('immich', []);

    expect(batches).toEqual([]);
  });

  it('records a full sync per project', async () => {
    expect(await repository.getFullSyncedAt('immich')).toBeNull();

    await repository.markFullSynced('immich');
    const first = await repository.getFullSyncedAt('immich');
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await repository.getFullSyncedAt('futo-notes')).toBeNull();

    await db.exec("UPDATE project_sync_state SET full_synced_at = 'before'");
    await repository.markFullSynced('immich');
    expect(await repository.getFullSyncedAt('immich')).not.toBe('before');
  });
});
