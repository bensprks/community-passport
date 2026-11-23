import assert from "node:assert/strict";
import { test } from "node:test";
import { hashScopes } from "@community-passport/grants";
import { acceptedFrom, clubScopes, optionalLabels, parseClubs, readGrant } from "../src/clubs.ts";

const feed = "0x00000000000000000000000000000000000000fe";
const token = "0x0000000000000000000000000000000000000070";
const POST = { label: "Post as you", target: feed, selector: "0x11111111" };
const EDIT = { label: "Edit and delete any of your posts", target: feed, selector: "0x22222222", optional: true };
const DELETE = { label: "Edit and delete any of your posts", target: feed, selector: "0x33333333", optional: true };
const PIN = { label: "Pin posts", target: feed, selector: "0x44444444", optional: true };

const clubs = (permissions: object[]) =>
  JSON.stringify([
    {
      clientId: "book-club",
      name: "Book Club",
      clientSecret: "secret",
      redirectUris: ["https://bookclub.example/callback"],
      grantee: "0x00000000000000000000000000000000000000c1",
      permissions,
    },
  ]);
const club = (permissions: object[]) => parseClubs(clubs(permissions), [feed]).get("book-club") ?? assert.fail("no club");

test("a club may only ask for functions on the contracts the operator listed", () => {
  assert.equal(club([POST]).grantDays, 90);
  assert.throws(() => parseClubs(clubs([{ ...POST, target: token }]), [feed]), /not one of the contracts grants may name/);
});

test("a grant covers what is required, and only the optional things the member accepted", () => {
  const bookClub = club([POST, EDIT, DELETE, PIN]);
  assert.deepEqual(optionalLabels(bookClub), [EDIT.label, PIN.label]);
  assert.deepEqual(clubScopes(bookClub).map((scope) => scope.selector), ["0x11111111"]);
  // Functions that share a label are accepted together.
  assert.deepEqual(clubScopes(bookClub, [EDIT.label]).map((scope) => scope.selector), ["0x11111111", "0x22222222", "0x33333333"]);
  // What a request claims was ticked is checked against the club's own list.
  assert.deepEqual(acceptedFrom(bookClub, [PIN.label, "Move money", POST.label]), [PIN.label]);
  assert.deepEqual(acceptedFrom(bookClub, PIN.label), [PIN.label]);
  assert.deepEqual(acceptedFrom(bookClub, undefined), []);
});

test("a grant on the chain is read back as what the member accepted", () => {
  const bookClub = club([POST, EDIT, DELETE, PIN]);
  const onchain = (accepted: string[], secondsLeft = 60) => ({ scopeId: hashScopes(clubScopes(bookClub, accepted)), expiry: 1n, secondsLeft });
  assert.deepEqual(readGrant(bookClub, onchain([])).accepted, []);
  assert.deepEqual(readGrant(bookClub, onchain([PIN.label])).accepted, [PIN.label]);
  assert.deepEqual(readGrant(bookClub, onchain([EDIT.label, PIN.label])).accepted, [EDIT.label, PIN.label]);
  assert.equal(readGrant(bookClub, onchain([PIN.label])).live, true);
  assert.equal(readGrant(bookClub, onchain([PIN.label], 0)).live, false, "expired");
  // A grant for some other list of functions is not one of this club's.
  assert.equal(readGrant(bookClub, { scopeId: hashScopes([{ target: feed, selector: "0x99999999" }]), expiry: 1n, secondsLeft: 60 }).live, false);
});

test("a club cannot make everything optional, or use one label both ways", () => {
  assert.throws(() => club([EDIT]), /at least one permission must not be optional/);
  assert.throws(() => club([POST, { ...POST, selector: "0x55555555", optional: true }]), /both an optional and a required/);
});
