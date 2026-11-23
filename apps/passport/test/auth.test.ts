import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Mailer,
  createSession,
  destroyOtherSessions,
  findSession,
  finishEmailLogin,
  issueChallenge,
  normalizeEmail,
  parseCookies,
  spendChallenge,
  startEmailLogin,
} from "../src/auth.ts";
import { openDb } from "../src/db.ts";

class Outbox implements Mailer {
  codes: string[] = [];
  async sendCode(_email: string, code: string) {
    this.codes.push(code);
  }
}

test("a code signs in once, from the browser that asked for it", async () => {
  const db = openDb(":memory:");
  const outbox = new Outbox();
  const pending = await startEmailLogin(db, outbox, "maya@example.com");
  const code = outbox.codes[0] as string;
  assert.match(code, /^\d{6}$/);

  const otherBrowser = await startEmailLogin(db, outbox, "maya@example.com");
  assert.equal(finishEmailLogin(db, otherBrowser, code), undefined);

  assert.equal(finishEmailLogin(db, pending, code), "maya@example.com");
  assert.equal(finishEmailLogin(db, pending, code), undefined);
});

test("a code takes five guesses at most", async () => {
  const db = openDb(":memory:");
  const outbox = new Outbox();
  const pending = await startEmailLogin(db, outbox, "maya@example.com");
  const code = outbox.codes[0] as string;
  const wrong = code === "000000" ? "111111" : "000000";
  for (let guess = 0; guess < 5; guess++) assert.equal(finishEmailLogin(db, pending, wrong), undefined);
  assert.equal(finishEmailLogin(db, pending, code), undefined);
});

test("at most five codes an hour go to one address", async () => {
  const db = openDb(":memory:");
  const outbox = new Outbox();
  for (let request = 0; request < 7; request++) await startEmailLogin(db, outbox, "maya@example.com");
  assert.equal(outbox.codes.length, 5);
});

test("sessions, emails and cookies", () => {
  const db = openDb(":memory:");
  const session = createSession(db, "user-1");
  assert.equal(findSession(db, session.id)?.userId, "user-1");
  assert.equal(findSession(db, "nope"), undefined);
  assert.equal(normalizeEmail("  Maya@Example.com "), "maya@example.com");
  assert.equal(normalizeEmail("not an email"), undefined);
  assert.deepEqual(parseCookies("a=1; pp_session=x%20y"), { a: "1", pp_session: "x y" });
});

test("a challenge works once, and only if it was issued here", () => {
  const db = openDb(":memory:");
  const challenge = issueChallenge(db);
  assert.equal(spendChallenge(db, "made-up"), false);
  assert.equal(spendChallenge(db, undefined), false);
  assert.equal(spendChallenge(db, challenge.id), true);
  assert.equal(spendChallenge(db, challenge.id), false);
});

test("ending a user's other sessions keeps the one in use", () => {
  const db = openDb(":memory:");
  const kept = createSession(db, "user-1");
  const other = createSession(db, "user-1");
  const someoneElse = createSession(db, "user-2");
  destroyOtherSessions(db, "user-1", kept.id);
  assert.ok(findSession(db, kept.id));
  assert.equal(findSession(db, other.id), undefined);
  assert.ok(findSession(db, someoneElse.id));
});
