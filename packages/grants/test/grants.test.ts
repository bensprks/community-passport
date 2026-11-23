import assert from "node:assert/strict";
import { test } from "node:test";
import { concat, encodeAbiParameters, hashDomain, hashTypedData, keccak256, stringToHex } from "viem";
import { type GrantMessage, grantTypedData, hashScopes, randomNonce, registryDomain, scopeOf } from "../src/index.ts";

const registry = "0x00000000000000000000000000000000000000aa";
const feed = "0x00000000000000000000000000000000000000f1";
const graph = "0x00000000000000000000000000000000000000f2";

const message: GrantMessage = {
  account: "0x00000000000000000000000000000000000000a1",
  grantee: "0x00000000000000000000000000000000000000c1",
  scopes: [...scopeOf(feed, ["deletePost(uint256,bytes32)"]), ...scopeOf(graph, ["unfollow(address,address)"])],
  expiry: 1_900_000_000n,
  nonce: 42n,
  deadline: 1_800_003_600n,
};

// The contract never sees the list when a grant is submitted, only this hash of it. So the digest the contract
// builds from the hash has to equal the digest a wallet builds from the whole list.
test("a wallet's digest of the full message equals the contract's digest built from hashScopes", () => {
  const typeHash = keccak256(
    stringToHex(
      "Grant(address account,address grantee,Scope[] scopes,uint64 expiry,uint256 nonce,uint256 deadline)" +
        "Scope(address target,bytes4 selector)",
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        typeHash,
        message.account,
        message.grantee,
        hashScopes(message.scopes),
        message.expiry,
        message.nonce,
        message.deadline,
      ],
    ),
  );
  const domainSeparator = hashDomain({
    domain: { ...registryDomain(31337, registry), chainId: 31337n },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });
  const contractDigest = keccak256(concat(["0x1901", domainSeparator, structHash]));

  assert.equal(hashTypedData(grantTypedData(31337, registry, message)), contractDigest);
});

test("the scope id depends on every entry and on their order", () => {
  const [first, second] = message.scopes as [(typeof message.scopes)[number], (typeof message.scopes)[number]];
  assert.notEqual(hashScopes([first, second]), hashScopes([second, first]));
  assert.notEqual(hashScopes([first, second]), hashScopes([first]));
  assert.equal(hashScopes([first, second]), hashScopes([{ ...first }, { ...second }]));
});

test("scopeOf uses each function's selector", () => {
  assert.deepEqual(scopeOf(feed, ["transfer(address,uint256)"]), [{ target: feed, selector: "0xa9059cbb" }]);
});

test("random nonces are 256-bit and differ", () => {
  const a = randomNonce();
  const b = randomNonce();
  assert.notEqual(a, b);
  assert.ok(a >= 0n && a < 2n ** 256n);
});
