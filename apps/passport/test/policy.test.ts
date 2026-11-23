import assert from "node:assert/strict";
import { test } from "node:test";
import { grantTypedData, revokeAllTypedData, revokeTypedData } from "@community-passport/grants";
import { encodeFunctionData, parseAbi } from "viem";
import { type MemberFacts, PolicyError, type PolicySettings, type SignRequest, addRegistry, checkPolicy, removeRegistry } from "../src/policy.ts";

const registry = "0x00000000000000000000000000000000000000aa";
const feed = "0x00000000000000000000000000000000000000fe";
const token = "0x0000000000000000000000000000000000000070";
const account = "0x00000000000000000000000000000000000000a1";
const proxyAdmin = "0x00000000000000000000000000000000000000ad";
const stranger = "0x00000000000000000000000000000000000000ff";
const club = "0x00000000000000000000000000000000000000c1";
const NOW = 1_800_000_000;
const DAY = 86400;
// One registered app: it may be granted two functions on the feed, for 90 days.
const settings: PolicySettings = {
  chainId: 143,
  grantRegistry: registry,
  apps: [{ grantee: club, scopes: [{ target: feed, selector: "0x12345678" }, { target: feed, selector: "0x9abcdef0" }], maxSeconds: 90 * DAY }],
};
const member: MemberFacts = { account, proxyAdmin, freshLogin: true };

const abi = parseAbi(["function transferOwnership(address)", "function addAccountManager(address,(bool,bool,bool,bool))", "function transfer(address,uint256)"]);
const handOver = encodeFunctionData({ abi, functionName: "transferOwnership", args: [stranger] });

type TypedData = Extract<SignRequest, { kind: "typedData" }>;
const grantMessage = { account, grantee: club, scopes: [{ target: feed, selector: "0x12345678" }], expiry: BigInt(NOW + 90 * DAY), nonce: 1n, deadline: 2n } as const;
const grant = (overrides: Partial<TypedData> = {}): SignRequest => ({
  kind: "typedData",
  ...grantTypedData(143, registry, grantMessage),
  ...overrides,
});
const revoke = (): SignRequest => ({
  kind: "typedData",
  ...revokeTypedData(143, registry, { account, grantee: stranger, nonce: 1n, deadline: 2n }),
});
const revokeAll = (): SignRequest => ({ kind: "typedData", ...revokeAllTypedData(143, registry, { account, nonce: 1n, deadline: 2n }) });

const allowed = (request: SignRequest, who: MemberFacts = member) => checkPolicy(request, settings, who, NOW);
const denied = (request: SignRequest, who: MemberFacts = member) =>
  assert.throws(() => checkPolicy(request, settings, who, NOW), PolicyError);

test("grants and revocations for the registry, for the member's Account, are allowed", () => {
  allowed(grant());
  // Ending a grant is allowed whoever holds it, and so is ending them all.
  allowed(revoke());
  allowed(revokeAll());
  // Signing a grant takes no fresh sign-in.
  allowed(grant(), { ...member, freshLogin: false });
});

test("typed data for anything else is denied", () => {
  const domain = grantTypedData(143, registry, grantMessage).domain;
  denied(grant({ domain: { ...domain, chainId: 1 } }));
  denied(grant({ domain: { ...domain, verifyingContract: stranger } }));
  denied(grant({ domain: { ...domain, name: "Permit2" } }));
  denied(grant({ primaryType: "Permit" }));
  denied(grant({ message: { ...grantMessage, account: stranger } }));
  // The right name on a different shape of message is not a grant.
  denied(grant({ types: { Grant: [{ name: "account", type: "address" }] } }));
});

test("a grant is only for a registered app's key, for functions and a length that app is registered for", () => {
  allowed(grant({ message: { ...grantMessage, scopes: settings.apps[0]?.scopes } }));
  denied(grant({ message: { ...grantMessage, grantee: stranger } }));
  denied(grant({ message: { ...grantMessage, scopes: [{ target: token, selector: "0xa9059cbb" }] } }));
  denied(grant({ message: { ...grantMessage, scopes: [...grantMessage.scopes, { target: token, selector: "0xa9059cbb" }] } }));
  // The right contract, but a function this app is not registered for.
  denied(grant({ message: { ...grantMessage, scopes: [{ target: feed, selector: "0xdeadbeef" }] } }));
  denied(grant({ message: { ...grantMessage, scopes: [] } }));
  denied(grant({ message: { ...grantMessage, expiry: BigInt(NOW + 365 * DAY) } }));
});

test("the registry can be taken off the Account, and put back exactly as it was", () => {
  const stale = { ...member, freshLogin: false };
  allowed({ kind: "transaction", to: account, data: removeRegistry(registry) }, stale);
  allowed({ kind: "transaction", to: account, data: addRegistry(registry) }, stale);
  // Not some other manager, not more rights, and not on the proxy admin.
  denied({ kind: "transaction", to: account, data: addRegistry(stranger) }, stale);
  denied({ kind: "transaction", to: account, data: removeRegistry(stranger) }, stale);
  denied({ kind: "transaction", to: account, data: encodeFunctionData({ abi, functionName: "addAccountManager", args: [registry, [true, true, true, true]] }) });
  denied({ kind: "transaction", to: proxyAdmin, data: removeRegistry(registry) });
});

test("handing over the Account or its proxy admin is allowed, on a fresh sign-in only", () => {
  allowed({ kind: "transaction", to: account, data: handOver });
  allowed({ kind: "transaction", to: proxyAdmin, data: handOver });
  denied({ kind: "transaction", to: account, data: handOver }, { ...member, freshLogin: false });
});

test("every other transaction is denied", () => {
  denied({ kind: "transaction", to: stranger, data: handOver });
  denied({ kind: "transaction", to: account, data: "0x" });
  denied({
    kind: "transaction",
    to: account,
    data: encodeFunctionData({ abi, functionName: "addAccountManager", args: [stranger, [true, true, true, true]] }),
  });
  denied({ kind: "transaction", to: account, data: encodeFunctionData({ abi, functionName: "transfer", args: [stranger, 1n] }) });
  // A transfer of ownership with anything appended is not one.
  denied({ kind: "transaction", to: account, data: `${handOver}00` });
});
