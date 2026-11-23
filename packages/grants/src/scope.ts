import { type Address, type Hex, concat, encodeAbiParameters, keccak256, stringToHex, toFunctionSelector } from "viem";

/** One function on one contract. */
export type Scope = { target: Address; selector: Hex };

const SCOPE_TYPEHASH = keccak256(stringToHex("Scope(address target,bytes4 selector)"));

/**
 * The id the registry stores a list of functions under: the hash EIP-712 gives a `Scope[]` field. It depends on
 * the order of the list.
 */
export function hashScopes(scopes: readonly Scope[]): Hex {
  const hashes = scopes.map((scope) =>
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "bytes4" }],
        [SCOPE_TYPEHASH, scope.target, scope.selector],
      ),
    ),
  );
  return keccak256(concat(hashes));
}

/** A scope from function signatures, e.g. `scopeOf(feed, ["deletePost(uint256,bytes32)"])`. */
export function scopeOf(target: Address, functions: readonly string[]): Scope[] {
  return functions.map((signature) => ({ target, selector: toFunctionSelector(signature) }));
}
