import { GRANT_TYPES, REVOKE_TYPES, type Scope } from "@community-passport/grants";
import { type Address, type Hex, isAddressEqual, toFunctionSelector } from "viem";

/**
 * What a key the Passport holds for a member is allowed to sign. This is the rule a key vendor's policy engine
 * enforces inside its sealed server; the development key store enforces the same rule in code.
 *
 *   Allow                grants and revocations for the grant registry, for this member's Account, and only
 *                        for functions on the contracts grants may name
 *   Allow, fresh login   handing the Account, or its proxy admin, to a new owner
 *   Deny                 everything else
 */
export type SignRequest =
  | {
      kind: "typedData";
      domain: { name: string; version: string; chainId: number; verifyingContract: Address };
      types: unknown;
      primaryType: string;
      message: { account: Address; scopes?: readonly Scope[] };
    }
  | { kind: "transaction"; to: Address; data: Hex };

/** Fixed when the key store is set up. Nothing in a request can change these. */
export type PolicySettings = {
  chainId: number;
  grantRegistry: Address;
  /** The contracts a grant may name: the Lens feeds, graphs and so on. Never a token. */
  scopeTargets: readonly Address[];
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

const TRANSFER_OWNERSHIP = toFunctionSelector("transferOwnership(address)");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function checkPolicy(request: SignRequest, settings: PolicySettings, member: MemberFacts): void {
  if (request.kind === "typedData") {
    const { domain, primaryType, message } = request;
    if (domain.chainId !== settings.chainId) throw new PolicyError("typed data is for another chain");
    const forRegistry =
      isAddressEqual(domain.verifyingContract, settings.grantRegistry) && domain.name === "GrantRegistry" && domain.version === "1";
    if (!forRegistry) throw new PolicyError("typed data is not for the grant registry");
    const isGrant = primaryType === "Grant" && same(request.types, GRANT_TYPES);
    const isRevoke = primaryType === "Revoke" && same(request.types, REVOKE_TYPES);
    if (!isGrant && !isRevoke) throw new PolicyError("typed data is neither a grant nor a revocation");
    if (!isAddressEqual(message.account, member.account)) throw new PolicyError("typed data is for another Account");
    if (isGrant) {
      if (!message.scopes?.length) throw new PolicyError("a grant must name its functions");
      for (const { target } of message.scopes) {
        if (!settings.scopeTargets.some((allowed) => isAddressEqual(allowed, target))) {
          throw new PolicyError(`a grant may not name ${target}`);
        }
      }
    }
    return;
  }

  const toAccount = isAddressEqual(request.to, member.account);
  const toProxyAdmin = isAddressEqual(request.to, member.proxyAdmin);
  if (!toAccount && !toProxyAdmin) throw new PolicyError("transaction is not to the member's Account or its proxy admin");
  // The selector, then one 32-byte address.
  if (request.data.length !== 2 + 8 + 64 || !request.data.toLowerCase().startsWith(TRANSFER_OWNERSHIP)) {
    throw new PolicyError("transaction is not a transfer of ownership");
  }
  if (!member.freshLogin) throw new PolicyError("transferring ownership needs a fresh sign-in");
}
