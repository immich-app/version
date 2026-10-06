import { env } from 'cloudflare:workers';
import { replayMigrations } from './migrations.js';

// Every test file runs against the schema in migrations/, applied the way
// production applies it.
await replayMigrations(env.VERSION_DB);
