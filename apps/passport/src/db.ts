import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Address } from "viem";

/** Who holds the key that owns a user's Account: the Passport's key store, or the user (a passkey or a wallet). */
export type Custody = "passport" | "self";

export type User = {
  id: string;
  email: string;
  /** The user's Lens Account. This is their identity, and the `sub` of their ID tokens. */
  account: Address;
  /** The address that owns the Account. */
  owner: Address;
  custody: Custody;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  account TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  custody TEXT NOT NULL CHECK (custody IN ('passport', 'self')),
  created_at INTEGER NOT NULL
);
-- The development key store. A key vendor replaces this table.
CREATE TABLE IF NOT EXISTS keys (
  user_id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  ciphertext TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS email_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- Challenges handed to a browser for its key to sign. Each works once.
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- Which apps a user connected. The registry says whether each grant is still live; this only says where to look.
CREATE TABLE IF NOT EXISTS connections (
  account TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account, client_id)
);
-- oidc-provider's own records: sessions, interactions, authorization codes.
CREATE TABLE IF NOT EXISTS oidc (
  model TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER,
  grant_id TEXT,
  user_code TEXT,
  uid TEXT,
  PRIMARY KEY (model, id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  purgeExpired(db);
  return db;
}

/** Deletes records that have run out. Sign-in codes are kept for an hour, since they count towards the hourly limit. */
export function purgeExpired(db: DatabaseSync): void {
  const time = now();
  db.prepare("DELETE FROM email_codes WHERE created_at < ?").run(time - 3600);
  db.prepare("DELETE FROM challenges WHERE expires_at <= ?").run(time);
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(time);
  db.prepare("DELETE FROM oidc WHERE expires_at <= ?").run(time);
}

/** Unix seconds. */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** A stored value that is made once and then kept, e.g. the key that signs ID tokens. */
export function setting(db: DatabaseSync, key: string, create: () => string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (row) return row.value;
  const value = create();
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
  return value;
}

export function userById(db: DatabaseSync, id: string): User | undefined {
  return db.prepare("SELECT id, email, account, owner, custody FROM users WHERE id = ?").get(id) as User | undefined;
}

export function userByEmail(db: DatabaseSync, email: string): User | undefined {
  return db.prepare("SELECT id, email, account, owner, custody FROM users WHERE email = ?").get(email) as
    | User
    | undefined;
}

export function userByAccount(db: DatabaseSync, account: Address): User | undefined {
  return db.prepare("SELECT id, email, account, owner, custody FROM users WHERE account = ?").get(account) as
    | User
    | undefined;
}

export function userByOwner(db: DatabaseSync, owner: Address): User | undefined {
  return db.prepare("SELECT id, email, account, owner, custody FROM users WHERE owner = ?").get(owner) as
    | User
    | undefined;
}
