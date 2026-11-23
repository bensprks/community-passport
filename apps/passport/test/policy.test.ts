import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, parseAbi } from "viem";
import { type PolicyContext, PolicyError, type SignRequest, checkPolicy } from "../src/policy.ts";

const registry = "0x00000000000000000000000000000000000000aa";
const account = "0x00000000000000000000000000000000000000a1";
const proxyAdmin = "0x00000000000000000000000000000000000000ad";
const stranger = "0x00000000000000000000000000000000000000ff";
const context: PolicyContext = { chainId: 143, grantRegistry: registry, account, proxyAdmin, freshLogin: true };

const abi = parseAbi(["function transferOwnership(address)", "function addAccountManager(address,(bool,bool,bool,bool))", "function transfer(address,uint256)"]);
const handOver = encodeFunctionData({ abi, functionName: "transferOwnership", args: [stranger] });

const grant = (overrides: Partial<Extract<SignRequest, { kind: "typedData" }>> = {}): SignRequest => ({
  kind: "typedData",
  domain: { chainId: 143, verifyingContract: registry },
  primaryType: "Grant",
  message: { account },
  ...overrides,
});

const denied = (request: SignRequest, when: PolicyContext = context) =>
  assert.throws(() => checkPolicy(request, when), PolicyError);

test("grants and revocations for the registry, for the member's Account, are allowed", () => {
  checkPolicy(grant(), context);
  checkPolicy(grant({ primaryType: "Revoke" }), context);
  // Signing a grant takes no fresh sign-in.
  checkPolicy(grant(), { ...context, freshLogin: false });
});

test("typed data for anything else is denied", () => {
  denied(grant({ domain: { chainId: 1, verifyingContract: registry } }));
  denied(grant({ domain: { chainId: 143, verifyingContract: stranger } }));
  denied(grant({ primaryType: "Permit" }));
  denied(grant({ message: { account: stranger } }));
});

test("handing over the Account or its proxy admin is allowed, on a fresh sign-in only", () => {
  checkPolicy({ kind: "transaction", to: account, data: handOver }, context);
  checkPolicy({ kind: "transaction", to: proxyAdmin, data: handOver }, context);
  denied({ kind: "transaction", to: account, data: handOver }, { ...context, freshLogin: false });
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
