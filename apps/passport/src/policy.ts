import { type Address, type Hex, isAddressEqual, toFunctionSelector } from "viem";

/**
 * What a key the Passport holds for a user is allowed to sign. This is the rule a key vendor's policy engine
 * enforces inside its sealed server; the development key store enforces the same rule in code.
 *
 *   Allow                grants and revocations for the grant registry, for this user's Account
 *   Allow, fresh login   handing the Account, or its proxy admin, to a new owner
 *   Deny                 everything else
 */
export type SignRequest =
  | {
      kind: "typedData";
      domain: { chainId: number; verifyingContract: Address };
      primaryType: string;
      message: { account: Address };
    }
  | { kind: "transaction"; to: Address; data: Hex };

export type PolicyContext = {
  chainId: number;
  grantRegistry: Address;
  /** The user's Lens Account. */
  account: Address;
  /** The contract that can change what code the Account's proxy runs. It has its own owner. */
  proxyAdmin: Address;
  /** Whether the user signed in moments ago, not on an old session. */
  freshLogin: boolean;
};

export class PolicyError extends Error {}

const TRANSFER_OWNERSHIP = toFunctionSelector("transferOwnership(address)");

export function checkPolicy(request: SignRequest, context: PolicyContext): void {
  if (request.kind === "typedData") {
    if (request.domain.chainId !== context.chainId) throw new PolicyError("typed data is for another chain");
    if (!isAddressEqual(request.domain.verifyingContract, context.grantRegistry)) {
      throw new PolicyError("typed data is not for the grant registry");
    }
    if (request.primaryType !== "Grant" && request.primaryType !== "Revoke") {
      throw new PolicyError("typed data is neither a grant nor a revocation");
    }
    if (!isAddressEqual(request.message.account, context.account)) {
      throw new PolicyError("typed data is for another Account");
    }
    return;
  }

  const toAccount = isAddressEqual(request.to, context.account);
  const toProxyAdmin = isAddressEqual(request.to, context.proxyAdmin);
  if (!toAccount && !toProxyAdmin) throw new PolicyError("transaction is not to the user's Account or its proxy admin");
  // The selector, then one 32-byte address.
  if (request.data.length !== 2 + 8 + 64 || !request.data.toLowerCase().startsWith(TRANSFER_OWNERSHIP)) {
    throw new PolicyError("transaction is not a transfer of ownership");
  }
  if (!context.freshLogin) throw new PolicyError("transferring ownership needs a fresh sign-in");
}
