// Quick smoke test: import db (triggers migrations) and list created tables.
// Run with:  npx tsx scripts/verify-db.mjs
import '../src/lib/db.ts';
import Database from 'better-sqlite3';

const sqlite = new Database('./db/app.db');
const tables = sqlite
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all();

console.log('Tables:', tables.map((t) => t.name).join(', '));
console.log(`Total: ${tables.length} tables`);
sqlite.close();
