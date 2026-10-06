import { env } from 'cloudflare:workers';

export interface D1Migration {
  name: string;
  queries: string[];
}

// The errors d1.tf tolerates when it replays a file that has already run.
const ALREADY_APPLIED = /already exists|duplicate column/i;

// Read from migrations/ by vitest.config.ts and passed in as a binding.
export const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;

/**
 * Applies migrations the way d1.tf does on every deploy: every file, in order,
 * every time, with no ledger. A file stops at its first failing statement, and
 * only "already applied" errors are tolerated; anything else fails.
 */
export async function replayMigrations(db: D1Database, files: D1Migration[] = migrations) {
  for (const file of files) {
    for (const query of file.queries) {
      try {
        await db.prepare(query).run();
      } catch (error) {
        if (error instanceof Error && ALREADY_APPLIED.test(error.message)) {
          break;
        }
        if (error instanceof Error) {
          error.message = `${file.name} failed: ${error.message}`;
        }
        throw error;
      }
    }
  }
}
