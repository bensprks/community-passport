import { GRANT_TYPES, REVOKE_ALL_TYPES, REVOKE_TYPES, type Scope } from "@community-passport/grants";
import { type Address, type Hex, encodeFunctionData, isAddressEqual, parseAbi, toFunctionSelector } from "viem";

/**
 * What a key the Passport holds for a member is allowed to sign. This is the rule a key vendor's policy engine
 * enforces inside its sealed server; the development key store enforces the same rule in code.
 *
 *   Allow                a grant for the registry, for this member's Account, to a registered app's key, for
 *                        functions that app is registered for, for no longer than that app's grants last
 *   Allow                ending one grant, or all of them
 *   Allow                removing the registry from the Account, and adding it back with no more than the
 *                        right to pass calls on
 *   Allow, fresh login   handing the Account, or its proxy admin, to a new owner
 *   Deny                 everything else
 *
 * What this rule cannot check is that the member really tapped Allow, or really chose the new owner. A vendor
 * has to see that for itself (see docs/passport.md), or a compromised Passport server can ask on their behalf.
 */
export type SignRequest =
  | {
      kind: "typedData";
      domain: { name: string; version: string; chainId: number; verifyingContract: Address };
      types: unknown;
      primaryType: string;
      message: { account: Address; grantee?: Address; scopes?: readonly Scope[]; expiry?: bigint };
    }
  | { kind: "transaction"; to: Address; data: Hex };

/** What one registered app may be granted. */
export type GrantLimit = { grantee: Address; scopes: readonly Scope[]; maxSeconds: number };

/** Fixed when the key store is set up. Nothing in a request can change these. */
export type PolicySettings = {
  chainId: number;
  grantRegistry: Address;
  /** One entry per registered app: its key, every function it may be given, and how long its grants last. */
  apps: readonly GrantLimit[];
};

/**
 * What is true of the member a request is for. A key only ever owns one Account and its proxy admin, so a
 * wrong `account` here gains nothing: the registry and Lens reject what the key does not own. `freshLogin` is
 * different. A vendor has to check it for itself, or a compromised Passport server could claim it.
 */
export type MemberFacts = {
  /** The member's Lens Account. */
  account: Address;
  /** The contract that can change what code the Account's proxy runs. It has its own owner. */
  proxyAdmin: Address;
  /** Whether the member signed in moments ago, not on an old session. */
  freshLogin: boolean;
};

export class PolicyError extends Error {}

const accountAbi = parseAbi([
  "struct AccountManagerPermissions { bool canExecuteTransactions; bool canTransferTokens; bool canTransferNative; bool canSetMetadataURI; }",
  "function addAccountManager(address accountManager, AccountManagerPermissions permissions)",
  "function removeAccountManager(address accountManager)",
]);
/** What the registry is on an Account: a manager that can have it make calls, and nothing else. */
const PASS_CALLS_ON_ONLY = { canExecuteTransactions: true, canTransferTokens: false, canTransferNative: false, canSetMetadataURI: false };

/** The transaction that takes the registry off an Account. Every grant on the Account stops working with it. */
export const removeRegistry = (registry: Address): Hex =>
  encodeFunctionData({ abi: accountAbi, functionName: "removeAccountManager", args: [registry] });
/** The transaction that puts the registry back on an Account, with the right to pass calls on and no other. */
export const addRegistry = (registry: Address): Hex =>
  encodeFunctionData({ abi: accountAbi, functionName: "addAccountManager", args: [registry, PASS_CALLS_ON_ONLY] });

const TRANSFER_OWNERSHIP = toFunctionSelector("transferOwnership(address)");
/** How far the chain's clock may run ahead of this one before a grant looks too long. */
const CLOCK_SLACK = 3600;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameFunction = (a: Scope, b: Scope) => isAddressEqual(a.target, b.target) && a.selector.toLowerCase() === b.selector.toLowerCase();

export function checkPolicy(request: SignRequest, settings: PolicySettings, member: MemberFacts, now = Date.now() / 1000): void {
  if (request.kind === "typedData") {
    const { domain, primaryType, message } = request;
    if (domain.chainId !== settings.chainId) throw new PolicyError("typed data is for another chain");
    const forRegistry =
      isAddressEqual(domain.verifyingContract, settings.grantRegistry) && domain.name === "GrantRegistry" && domain.version === "1";
    if (!forRegistry) throw new PolicyError("typed data is not for the grant registry");
    const expected = { Grant: GRANT_TYPES, Revoke: REVOKE_TYPES, RevokeAll: REVOKE_ALL_TYPES }[primaryType];
    if (!expected || !same(request.types, expected)) throw new PolicyError("typed data is not a grant or the end of one");
    if (!isAddressEqual(message.account, member.account)) throw new PolicyError("typed data is for another Account");
    if (primaryType !== "Grant") return;

    const app = settings.apps.find((limit) => message.grantee && isAddressEqual(limit.grantee, message.grantee));
    if (!app) throw new PolicyError("a grant must be for a registered app's key");
    if (!message.scopes?.length) throw new PolicyError("a grant must name its functions");
    for (const scope of message.scopes) {
      if (!app.scopes.some((allowed) => sameFunction(allowed, scope))) {
        throw new PolicyError(`that app is not registered for ${scope.selector} on ${scope.target}`);
      }
    }
    if (message.expiry === undefined || Number(message.expiry) > now + app.maxSeconds + CLOCK_SLACK) {
      throw new PolicyError("a grant may not outlast what its app is registered for");
    }
    return;
  }

  const toAccount = isAddressEqual(request.to, member.account);
  const toProxyAdmin = isAddressEqual(request.to, member.proxyAdmin);
  if (!toAccount && !toProxyAdmin) throw new PolicyError("transaction is not to the member's Account or its proxy admin");
  const data = request.data.toLowerCase();
  // Taking the registry off the Account, or putting it back exactly as it was, moves nothing to anyone.
  if (toAccount && (data === removeRegistry(settings.grantRegistry) || data === addRegistry(settings.grantRegistry))) return;
  // The selector, then one 32-byte address.
  if (data.length !== 2 + 8 + 64 || !data.startsWith(TRANSFER_OWNERSHIP)) {
    throw new PolicyError("transaction is not one the key may send");
  }
  if (!member.freshLogin) throw new PolicyError("transferring ownership needs a fresh sign-in");
}
