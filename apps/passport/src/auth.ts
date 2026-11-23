import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { now } from "./db.ts";

/** Sends sign-in codes. */
export interface Mailer {
  sendCode(email: string, code: string): Promise<void>;
}

/** FOR DEVELOPMENT ONLY. Prints the code where a real mailer would send it. */
export class ConsoleMailer implements Mailer {
  async sendCode(email: string, code: string): Promise<void> {
    console.log(`[mail] to ${email}: your Community Passport code is ${code}. Only ever type it on this site.`);
  }
}

const CODE_TTL = 10 * 60;
const CODE_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;
export const SESSION_TTL = 30 * 24 * 60 * 60;
/** How recently a user must have signed in to hand their Account to a new owner. */
export const FRESH_LOGIN = 10 * 60;

export function randomId(): string {
  return randomBytes(32).toString("base64url");
}

export function normalizeEmail(input: string): string | undefined {
  const email = input.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : undefined;
}

function hashCode(pendingId: string, code: string): Buffer {
  return createHash("sha256").update(`${pendingId}:${code}`).digest();
}

/**
 * Sends a 6-digit code and returns the id of the pending sign-in, which goes in a cookie. The code only works
 * together with that cookie, so it is of no use in any other browser.
 */
export async function startEmailLogin(db: DatabaseSync, mailer: Mailer, email: string): Promise<string> {
  const recent = db
    .prepare("SELECT COUNT(*) AS count FROM email_codes WHERE email = ? AND created_at > ?")
    .get(email, now() - 3600) as { count: number };
  const pendingId = randomId();
  // Past the limit nothing is sent, and the answer looks the same, so the limit says nothing about the address.
  if (recent.count >= CODES_PER_HOUR) return pendingId;
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  db.prepare("INSERT INTO email_codes (id, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(
    pendingId,
    email,
    hashCode(pendingId, code).toString("hex"),
    now() + CODE_TTL,
    now(),
  );
  await mailer.sendCode(email, code);
  return pendingId;
}

/** Checks a code. Returns the email it proves, or undefined. A code works once, and takes five guesses at most. */
export function finishEmailLogin(db: DatabaseSync, pendingId: string, code: string): string | undefined {
  const row = db.prepare("SELECT email, code_hash, expires_at, attempts FROM email_codes WHERE id = ?").get(pendingId) as
    | { email: string; code_hash: string; expires_at: number; attempts: number }
    | undefined;
  if (!row || row.expires_at <= now() || row.attempts >= CODE_ATTEMPTS) return undefined;
  db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?").run(pendingId);
  if (!timingSafeEqual(hashCode(pendingId, code.trim()), Buffer.from(row.code_hash, "hex"))) return undefined;
  // Spent: mark it as out of attempts, and keep the row so that it still counts towards the hourly limit.
  db.prepare("UPDATE email_codes SET attempts = ? WHERE id = ?").run(CODE_ATTEMPTS, pendingId);
  return row.email;
}

export type Session = { id: string; userId: string; createdAt: number };

export function createSession(db: DatabaseSync, userId: string): Session {
  const session = { id: randomId(), userId, createdAt: now() };
  db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    session.id,
    userId,
    session.createdAt,
    session.createdAt + SESSION_TTL,
  );
  return session;
}

export function findSession(db: DatabaseSync, id: string | undefined): Session | undefined {
  if (!id) return undefined;
  const row = db.prepare("SELECT id, user_id, created_at FROM sessions WHERE id = ? AND expires_at > ?").get(id, now()) as
    | { id: string; user_id: string; created_at: number }
    | undefined;
  return row && { id: row.id, userId: row.user_id, createdAt: row.created_at };
}

export function destroySession(db: DatabaseSync, id: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

/** Ends every session of a user but one. */
export function destroyOtherSessions(db: DatabaseSync, userId: string, keepId: string): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(userId, keepId);
}

const CHALLENGE_TTL = 5 * 60;

/** A random challenge for a browser's key to sign. */
export function issueChallenge(db: DatabaseSync): { id: string; maxAge: number } {
  const id = randomId();
  db.prepare("INSERT INTO challenges (id, expires_at) VALUES (?, ?)").run(id, now() + CHALLENGE_TTL);
  return { id, maxAge: CHALLENGE_TTL };
}

/** Whether a challenge was issued here, has not run out, and has not been used. Using it up is part of asking. */
export function spendChallenge(db: DatabaseSync, id: string | undefined): boolean {
  if (!id) return false;
  return db.prepare("DELETE FROM challenges WHERE id = ? AND expires_at > ?").run(id, now()).changes === 1;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}
