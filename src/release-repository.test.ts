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

// After every row these tests write, so a delete takes them all.
const LATER = '9999-12-31T00:00:00.000Z';

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

    // 15 chunks of 20 rows (synced_at is D1's clock, not a parameter), each a
    // delete of retagged rows and an upsert.
    expect(batches).toEqual([30]);
    expect(prepared).toHaveLength(30);
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

  it("deletes only the project's own releases with those tags", async () => {
    await repository.upsertMany('immich', [release('v1.0.0'), release('v1.1.0'), release('v1.2.0')]);
    await repository.upsertMany('futo-notes', [release('v1.0.0')]);

    await repository.deleteMany('immich', [release('v1.0.0'), release('v1.2.0'), release('v9.9.9')], LATER);

    expect(await listed('immich')).toEqual([release('v1.1.0')]);
    expect(await repository.list('futo-notes')).toEqual([release('v1.0.0')]);
  });

  it("stamps each write with D1's clock when it lands, in toISOString()'s format", async () => {
    const before = await repository.now();
    await repository.upsertMany('immich', [release('v1.0.0')]);

    const stamped = await syncedAt('immich', 'v1.0.0');
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(stamped! >= before).toBe(true);
  });

  it('keeps a webhook write that was built before the checks began but landed after', async () => {
    await repository.upsertMany('immich', [release('v1.0.0')]);
    await db.exec("UPDATE project_releases SET synced_at = '2000-01-01T00:00:00.000Z'");
    // The webhook builds its batch, then the cron takes its cutoff, then the batch lands.
    let cutoff = '';
    const held = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        await new Promise((wait) => setTimeout(wait, 5));
        cutoff = await repository.now();
        return db.batch(statements);
      },
    } as unknown as D1Database;
    await new ReleaseRepository(held).upsertMany('immich', [release('v1.0.0', { published_at: 'again' })]);

    expect(await repository.deleteMany('immich', [release('v1.0.0')], cutoff)).toBe(0);
    expect(await listed('immich')).toEqual([release('v1.0.0', { published_at: 'again' })]);
  });

  it('returns how many rows it deleted', async () => {
    await repository.upsertMany('immich', [release('v1.0.0'), release('v1.1.0')]);

    expect(
      await repository.deleteMany('immich', [release('v1.0.0'), release('v1.1.0'), release('v9.9.9')], LATER),
    ).toBe(2);
  });

  it('keeps a release written again, under the same tag and id, after the checks began', async () => {
    await repository.upsertMany('immich', [release('v1.0.0'), release('v1.1.0')]);
    // v1.0.0 was a draft when it was checked, and a webhook has republished it since.
    await db.exec("UPDATE project_releases SET synced_at = '2026-01-01T00:00:00.000Z'");
    await db.exec("UPDATE project_releases SET synced_at = '2026-01-01T00:05:00.000Z' WHERE tag = 'v1.0.0'");

    await repository.deleteMany('immich', [release('v1.0.0'), release('v1.1.0')], '2026-01-01T00:01:00.000Z');

    expect(await listed('immich')).toEqual([release('v1.0.0')]);
  });

  it('keeps a release that has replaced the deleted one under the same tag', async () => {
    await repository.upsertMany('immich', [release('v1.0.0', { source_id: 'new' })]);

    await repository.deleteMany('immich', [release('v1.0.0', { source_id: 'old' })], LATER);

    expect(await listed('immich')).toEqual([release('v1.0.0', { source_id: 'new' })]);
  });

  it('splits a large delete into statements of at most 100 bound parameters, in one batch', async () => {
    const releases = Array.from({ length: 250 }, (_, index) => release(`v1.${index}.0`));
    await repository.upsertMany('immich', [...releases, release('v2.0.0')]);
    const { database, prepared, batches } = recordingDatabase();

    await new ReleaseRepository(database).deleteMany('immich', releases, LATER);

    // 49 releases a statement: the project and the time, then a tag and a source id each.
    expect(batches).toEqual([6]);
    for (const sql of prepared) {
      expect(sql.match(/\?/g)?.length).toBeLessThanOrEqual(100);
    }
    expect(await repository.list('immich')).toEqual([release('v2.0.0')]);
  });

  it('deletes nothing for an empty list', async () => {
    const { database, batches } = recordingDatabase();

    await new ReleaseRepository(database).deleteMany('immich', [], LATER);

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
