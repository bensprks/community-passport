import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Address } from "viem";

/**
 * Who holds the key that owns a user's Account. "passport": the Passport's key store. "self": the user, with a
 * key of their own. "email": nobody: the Account is owned by a contract rooted in the user's email, and the
 * passkeys of their devices sign for it.
 */
export type Custody = "passport" | "self" | "email";

export type User = {
  id: string;
  email: string;
  /** The user's Lens Account. This is their identity, and the `sub` of their ID tokens. */
  account: Address;
  /** The address that owns the Account. */
  owner: Address;
  custody: Custody;
  /** The member's own key, while a handover to it is under way. */
  pendingOwner: Address | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  account TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  custody TEXT NOT NULL CHECK (custody IN ('passport', 'self', 'email')),
  pending_owner TEXT,
  -- Set while a handover is running, so that two cannot run at once.
  handover_at INTEGER,
  created_at INTEGER NOT NULL
);
-- A member whose key exists but whose Account is not recorded yet. Written before the Account is created, so that
-- a failure half-way leaves something to pick up from.
CREATE TABLE IF NOT EXISTS provisioning (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  started_at INTEGER NOT NULL
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
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- Challenges handed to a browser for its key to sign. Each works once.
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
-- The passkeys of a member's devices, for accounts rooted in an email. The owner contract says which of them
-- work; this says which passkey to ask a browser for.
CREATE TABLE IF NOT EXISTS devices (
  key_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  qx TEXT NOT NULL,
  qy TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- A device waiting for the member's email to approve it.
CREATE TABLE IF NOT EXISTS device_requests (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  qx TEXT NOT NULL,
  qy TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
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

/** Deletes records that have run out. Sign-in codes are kept for a day, since they count towards the daily limit. */
export function purgeExpired(db: DatabaseSync): void {
  const time = now();
  db.prepare("DELETE FROM email_codes WHERE created_at < ?").run(time - 86400);
  db.prepare("DELETE FROM challenges WHERE expires_at <= ?").run(time);
  db.prepare("DELETE FROM device_requests WHERE expires_at <= ?").run(time);
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

const USER_COLUMNS = "id, email, account, owner, custody, pending_owner AS pendingOwner";

function oneUser(db: DatabaseSync, column: "id" | "email" | "account" | "owner" | "pending_owner", value: string) {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE ${column} = ?`).get(value) as User | undefined;
}

export const userById = (db: DatabaseSync, id: string) => oneUser(db, "id", id);
export const userByEmail = (db: DatabaseSync, email: string) => oneUser(db, "email", email);
export const userByOwner = (db: DatabaseSync, owner: Address) => oneUser(db, "owner", owner);
/** A member part-way through moving their Account to `owner`. */
export const userByPendingOwner = (db: DatabaseSync, owner: Address) => oneUser(db, "pending_owner", owner);
