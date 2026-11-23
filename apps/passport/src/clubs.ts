import { readFileSync } from "node:fs";
import { type Scope, hashScopes } from "@community-passport/grants";
import { type Address, type Hex, getAddress, isAddressEqual, isHex } from "viem";

/**
 * One function a club may call as a member, and how the consent screen words it. Functions with the same label
 * are shown, and accepted or declined, as one thing. An optional one is the member's to leave out.
 */
export type Permission = { label: string; target: Address; selector: Hex; optional: boolean };

/** How many optional things one club may ask for. It keeps the consent screen short. */
const MAX_OPTIONAL = 6;

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

/**
 * Reads the list of clubs. `scopeTargets` are the only contracts a permission may name, so that no club can ask
 * for a function on a token or on anything else the operator has not looked at.
 */
export function parseClubs(json: string, scopeTargets: readonly Address[]): Map<string, Club> {
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
        const target = getAddress(permission.target);
        if (!scopeTargets.some((allowed) => isAddressEqual(allowed, target))) {
          fail(index, `"${permission.label}" names ${target}, which is not one of the contracts grants may name`);
        }
        return { label: permission.label, target, selector: permission.selector, optional: permission.optional === true };
      }),
      grantDays,
    });
    const club = clubs.get(entry.clientId) as Club;
    const optional = optionalLabels(club);
    if (club.permissions.every((permission) => permission.optional)) fail(index, "at least one permission must not be optional");
    if (optional.length > MAX_OPTIONAL) fail(index, `at most ${MAX_OPTIONAL} optional permissions`);
    if (club.permissions.some((permission) => !permission.optional && optional.includes(permission.label))) {
      fail(index, "a label is used for both an optional and a required permission");
    }
  });
  return clubs;
}

export function loadClubs(file: string, scopeTargets: readonly Address[]): Map<string, Club> {
  return parseClubs(readFileSync(file, "utf8"), scopeTargets);
}

/** The optional things a club asks for, by label, in the order it lists them. */
export function optionalLabels(club: Club): string[] {
  return [...new Set(club.permissions.filter((permission) => permission.optional).map((permission) => permission.label))];
}

/** What a member always grants a club, by label. */
export function requiredLabels(club: Club): string[] {
  return [...new Set(club.permissions.filter((permission) => !permission.optional).map((permission) => permission.label))];
}

/** Of what a request says the member ticked, the labels that really are this club's optional ones. */
export function acceptedFrom(club: Club, ticked: unknown): string[] {
  const labels = [ticked].flat();
  return optionalLabels(club).filter((label) => labels.includes(label));
}

/** The functions a member's grant to this club covers: everything required, and the optional things they accepted. */
export function clubScopes(club: Club, accepted: readonly string[] = []): Scope[] {
  return club.permissions
    .filter((permission) => !permission.optional || accepted.includes(permission.label))
    .map(({ target, selector }) => ({ target, selector }));
}

/** A member's grant to a club as the registry holds it, read against what the club asks for today. */
export type Connection = {
  /** Not expired, and one of the grants this club could have been given. */
  live: boolean;
  /** The optional things the member accepted. */
  accepted: string[];
  expiry: bigint;
  secondsLeft: number;
};

/**
 * The registry stores a grant's functions as one hash. Trying each combination of the club's optional things
 * tells which one the member accepted, or that the grant is not for what this club asks today.
 */
export function readGrant(club: Club, grant: { scopeId: Hex; expiry: bigint; secondsLeft: number }): Connection {
  const optional = optionalLabels(club);
  for (let choice = 0; choice < 1 << optional.length; choice++) {
    const accepted = optional.filter((_label, bit) => choice & (1 << bit));
    if (hashScopes(clubScopes(club, accepted)) === grant.scopeId) return { ...grant, live: grant.secondsLeft > 0, accepted };
  }
  return { ...grant, live: false, accepted: [] };
}

/** The domain a member is sent back to, which is what the consent screen shows largest. */
export function clubDomain(club: Club): string {
  return new URL(club.redirectUris[0] as string).host;
}
