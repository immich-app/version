import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { type D1Migration, migrations, replayMigrations } from './test/migrations.js';

const db = env.VERSION_DB;
const byText = (a: string, b: string) => a.localeCompare(b);

// The schema plus every row of every table, in a stable order.
const snapshot = async () => {
  const { results: objects } = await db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .all<{ type: string; name: string; sql: string }>();
  const tableNames = objects.filter((object) => object.type === 'table').map(({ name }) => name);
  const rows: Record<string, string[]> = {};
  for (const name of tableNames) {
    const { results } = await db.prepare(`SELECT * FROM "${name}"`).all();
    const serialized = results.map((row) => JSON.stringify(row));
    serialized.sort(byText);
    rows[name] = serialized;
  }
  return { objects, tableNames, rows };
};

const tables = async () => {
  const { tableNames } = await snapshot();
  return new Set(tableNames);
};

// Live databases hold data by the time a migration is replayed, so every table
// the migrations create gets a row the replay must preserve. Add new tables here.
const SEEDS: Record<string, { insert: D1PreparedStatement; remove: D1PreparedStatement }> = {
  releases: {
    insert: db
      .prepare('INSERT OR IGNORE INTO releases (id, tag_name, major, minor, patch) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(424_242, 'v9.8.7', 9, 8, 7),
    remove: db.prepare('DELETE FROM releases WHERE id = 424242'),
  },
};

const eachSeed = async (action: 'insert' | 'remove') => {
  const existing = await tables();
  for (const [table, statements] of Object.entries(SEEDS)) {
    if (existing.has(table)) {
      await statements[action].run();
    }
  }
};

// d1.tf has no ledger: every deploy that changes a migration, and every retry,
// replays every file against the live database. That must change nothing.
const expectReplaySafe = async (files: D1Migration[]) => {
  await replayMigrations(db, files);
  await eachSeed('insert');
  const before = await snapshot();

  await replayMigrations(db, files);
  await replayMigrations(db, files);

  expect(await snapshot()).toEqual(before);
};

describe('migrations', () => {
  afterEach(async () => {
    await db.prepare('DROP TABLE IF EXISTS replay_probe').run();
    await eachSeed('remove');
  });

  it('seed every table the migrations create', async () => {
    const { tableNames } = await snapshot();
    const seeded = Object.keys(SEEDS);
    tableNames.sort(byText);
    seeded.sort(byText);
    expect(tableNames).toEqual(seeded);

    // INSERT OR IGNORE succeeds without a row when a constraint rejects it.
    await eachSeed('insert');
    const { rows } = await snapshot();
    for (const table of tableNames) {
      expect(rows[table].length, `${table} must have a seed row`).toBeGreaterThan(0);
    }
  });

  it('replay over a migrated database without changing its schema or data', async () => {
    await expectReplaySafe(migrations);
  });

  it('catch a migration that adds rows on every replay', async () => {
    const files = [
      ...migrations,
      { name: 'insert.sql', queries: ['CREATE TABLE IF NOT EXISTS replay_probe (value INTEGER)'] },
      { name: 'insert-rows.sql', queries: ['INSERT INTO replay_probe VALUES (1)'] },
    ];
    await expect(expectReplaySafe(files)).rejects.toThrow();
  });

  it('catch a migration that deletes existing data', async () => {
    const files = [...migrations, { name: 'delete.sql', queries: ['DELETE FROM releases'] }];
    await expect(expectReplaySafe(files)).rejects.toThrow();
  });

  it('fail on an error d1.tf does not tolerate', async () => {
    await expect(
      replayMigrations(db, [{ name: 'broken.sql', queries: ['SELECT * FROM missing_table'] }]),
    ).rejects.toThrow('broken.sql failed');
  });
});
