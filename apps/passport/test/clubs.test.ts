import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClubs } from "../src/clubs.ts";

const feed = "0x00000000000000000000000000000000000000fe";
const token = "0x0000000000000000000000000000000000000070";
const club = (target: string) =>
  JSON.stringify([
    {
      clientId: "book-club",
      name: "Book Club",
      clientSecret: "secret",
      redirectUris: ["https://bookclub.example/callback"],
      grantee: "0x00000000000000000000000000000000000000c1",
      permissions: [{ label: "Post as you", target, selector: "0x12345678" }],
    },
  ]);

test("a club may only ask for functions on the contracts the operator listed", () => {
  assert.equal(parseClubs(club(feed), [feed]).get("book-club")?.grantDays, 90);
  assert.throws(() => parseClubs(club(token), [feed]), /not one of the contracts grants may name/);
});
