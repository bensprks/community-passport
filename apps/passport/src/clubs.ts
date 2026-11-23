import { readFileSync } from "node:fs";
import type { Scope } from "@community-passport/grants";
import { type Address, type Hex, getAddress, isHex } from "viem";

/** One thing a club may do as a member, and how the consent screen words it. */
export type Permission = { label: string; target: Address; selector: Hex };

/**
 * An app that may ask for sign-in. In this version the Passport's operator keeps the list, so a club's name and
 * the wording of what it may do come from the operator, not from the club.
 */
export type Club = {
  clientId: string;
  name: string;
  /** Where the Passport may send a member back to. The first one's host is the domain shown on the consent screen. */
  redirectUris: string[];
  clientSecret: string;
  /** The address of the key the club's server acts with. */
  grantee: Address;
  permissions: Permission[];
  /** How long a grant lasts. It is renewed when a member signs in with less than half of it left. */
  grantDays: number;
};

function fail(index: number, problem: string): never {
  throw new Error(`clubs file, entry ${index}: ${problem}`);
}

export function parseClubs(json: string): Map<string, Club> {
  const entries: unknown = JSON.parse(json);
  if (!Array.isArray(entries)) throw new Error("clubs file: expected a list");
  const clubs = new Map<string, Club>();
  entries.forEach((entry: Partial<Club>, index) => {
    if (!entry.clientId || !entry.name || !entry.clientSecret) fail(index, "clientId, name and clientSecret are required");
    if (!entry.redirectUris?.length) fail(index, "at least one redirect URI is required");
    if (!entry.permissions?.length) fail(index, "at least one permission is required");
    if (clubs.has(entry.clientId)) fail(index, `duplicate clientId ${entry.clientId}`);
    const grantDays = entry.grantDays ?? 90;
    if (!Number.isInteger(grantDays) || grantDays < 1 || grantDays > 365) fail(index, "grantDays must be 1 to 365");
    clubs.set(entry.clientId, {
      clientId: entry.clientId,
      name: entry.name,
      clientSecret: entry.clientSecret,
      redirectUris: entry.redirectUris.map((uri) => new URL(uri).toString()),
      grantee: getAddress(entry.grantee ?? fail(index, "grantee is required")),
      permissions: entry.permissions.map((permission) => {
        if (!permission.label) fail(index, "every permission needs a label");
        if (!isHex(permission.selector) || permission.selector.length !== 10) {
          fail(index, `"${permission.label}" needs a 4-byte selector`);
        }
        return { label: permission.label, target: getAddress(permission.target), selector: permission.selector };
      }),
      grantDays,
    });
  });
  return clubs;
}

export function loadClubs(file: string): Map<string, Club> {
  return parseClubs(readFileSync(file, "utf8"));
}

/** The list of functions a member's grant to this club covers. */
export function clubScopes(club: Club): Scope[] {
  return club.permissions.map(({ target, selector }) => ({ target, selector }));
}

/** The domain a member is sent back to, which is what the consent screen shows largest. */
export function clubDomain(club: Club): string {
  return new URL(club.redirectUris[0] as string).host;
}
