import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Opens the database and applies the schema.
 *
 * `better-sqlite3` is synchronous by design. For a single-process service that
 * is a feature, not a limitation: it removes interleaving between a read and
 * the write that depends on it, which is the usual source of state-machine
 * races in this kind of worker.
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);

  // WAL lets the HTTP reads proceed while a worker is writing.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Fail fast instead of hanging if another process holds a write lock.
  db.pragma('busy_timeout = 5000');

  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

  return db;
}
