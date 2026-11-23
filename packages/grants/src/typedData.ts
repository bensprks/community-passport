import type { Address } from "viem";
import type { Scope } from "./scope.ts";

const SCOPE_TYPE = [
  { name: "target", type: "address" },
  { name: "selector", type: "bytes4" },
] as const;

export const GRANT_TYPES = {
  Grant: [
    { name: "account", type: "address" },
    { name: "grantee", type: "address" },
    { name: "scopes", type: "Scope[]" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Scope: SCOPE_TYPE,
} as const;

export const REVOKE_TYPES = {
  Revoke: [
    { name: "account", type: "address" },
    { name: "grantee", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** What an Account's owner signs to let `grantee` call `scopes` as the Account until `expiry`. */
export type GrantMessage = {
  account: Address;
  grantee: Address;
  scopes: readonly Scope[];
  /** Unix seconds. At most a year ahead. */
  expiry: bigint;
  /** Any number the Account has not used yet, see `randomNonce`. */
  nonce: bigint;
  /** Unix seconds after which the signature can no longer be submitted. */
  deadline: bigint;
};

export type RevokeMessage = Pick<GrantMessage, "account" | "grantee" | "nonce" | "deadline">;

/** The registry's EIP-712 domain. It ties a signature to one chain and one registry. */
export function registryDomain(chainId: number, registry: Address) {
  return { name: "GrantRegistry", version: "1", chainId, verifyingContract: registry } as const;
}

/** The typed data to pass to a wallet's `signTypedData` for `GrantRegistry.grantWithSig`. */
export function grantTypedData(chainId: number, registry: Address, message: GrantMessage) {
  return { domain: registryDomain(chainId, registry), types: GRANT_TYPES, primaryType: "Grant", message } as const;
}

/** The typed data to pass to a wallet's `signTypedData` for `GrantRegistry.revokeWithSig`. */
export function revokeTypedData(chainId: number, registry: Address, message: RevokeMessage) {
  return { domain: registryDomain(chainId, registry), types: REVOKE_TYPES, primaryType: "Revoke", message } as const;
}

/** The registry accepts nonces in any order, so a random 256-bit number never collides or blocks another. */
export function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}
