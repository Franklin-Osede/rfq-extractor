/**
 * SQLite + Drizzle connection. Single source of truth for the app's `db` handle.
 *
 * - Resolves `DATABASE_URL` from env (default: ./db/app.db).
 * - Auto-creates the parent directory so a fresh `npm run dev` works.
 * - Turns on WAL journaling (better concurrent reads) and FK enforcement.
 *
 * In production this file would swap to `drizzle-orm/postgres-js` with a
 * connection pool; the app code calling `db` does not change.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as schema from '../../db/schema';

const url = process.env.DATABASE_URL ?? 'file:./db/app.db';
const dbPath = url.replace(/^file:/, '');

mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

// Apply migrations on first import. Idempotent — Drizzle skips ones already
// recorded in its internal __drizzle_migrations table. This means a fresh
// `npm run dev` on a clean machine creates the DB with no extra steps.
migrate(db, { migrationsFolder: path.resolve('./db/migrations') });

export { schema };
