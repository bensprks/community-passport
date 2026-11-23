import assert from "node:assert/strict";
import { test } from "node:test";
import { grantTypedData, revokeTypedData } from "@community-passport/grants";
import { encodeFunctionData, parseAbi } from "viem";
import { type MemberFacts, PolicyError, type PolicySettings, type SignRequest, checkPolicy } from "../src/policy.ts";

const registry = "0x00000000000000000000000000000000000000aa";
const feed = "0x00000000000000000000000000000000000000fe";
const token = "0x0000000000000000000000000000000000000070";
const account = "0x00000000000000000000000000000000000000a1";
const proxyAdmin = "0x00000000000000000000000000000000000000ad";
const stranger = "0x00000000000000000000000000000000000000ff";
const settings: PolicySettings = { chainId: 143, grantRegistry: registry, scopeTargets: [feed] };
const member: MemberFacts = { account, proxyAdmin, freshLogin: true };

const abi = parseAbi(["function transferOwnership(address)", "function addAccountManager(address,(bool,bool,bool,bool))", "function transfer(address,uint256)"]);
const handOver = encodeFunctionData({ abi, functionName: "transferOwnership", args: [stranger] });

type TypedData = Extract<SignRequest, { kind: "typedData" }>;
const grantMessage = { account, grantee: stranger, scopes: [{ target: feed, selector: "0x12345678" }], expiry: 2n, nonce: 1n, deadline: 2n } as const;
const grant = (overrides: Partial<TypedData> = {}): SignRequest => ({
  kind: "typedData",
  ...grantTypedData(143, registry, grantMessage),
  ...overrides,
});
const revoke = (): SignRequest => ({
  kind: "typedData",
  ...revokeTypedData(143, registry, { account, grantee: stranger, nonce: 1n, deadline: 2n }),
});

const denied = (request: SignRequest, who: MemberFacts = member) =>
  assert.throws(() => checkPolicy(request, settings, who), PolicyError);

test("grants and revocations for the registry, for the member's Account, are allowed", () => {
  checkPolicy(grant(), settings, member);
  checkPolicy(revoke(), settings, member);
  // Signing a grant takes no fresh sign-in.
  checkPolicy(grant(), settings, { ...member, freshLogin: false });
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

test("a grant may only name functions on the contracts the operator listed", () => {
  denied(grant({ message: { ...grantMessage, scopes: [{ target: token, selector: "0xa9059cbb" }] } }));
  denied(grant({ message: { ...grantMessage, scopes: [...grantMessage.scopes, { target: token, selector: "0xa9059cbb" }] } }));
  denied(grant({ message: { ...grantMessage, scopes: [] } }));
});

test("handing over the Account or its proxy admin is allowed, on a fresh sign-in only", () => {
  checkPolicy({ kind: "transaction", to: account, data: handOver }, settings, member);
  checkPolicy({ kind: "transaction", to: proxyAdmin, data: handOver }, settings, member);
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
