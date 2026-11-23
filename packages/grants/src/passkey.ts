import { type Hex, encodeAbiParameters, keccak256 } from "viem";

/** What a passkey returns when it signs, in the form the owner contract checks. */
export type PasskeyAssertion = {
  r: Hex;
  /** The lower of the two equivalent values, see `lowS`. */
  s: Hex;
  authenticatorData: Hex;
  clientDataJSON: string;
};

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** A passkey's signature has two equivalent forms. Contracts accept the one with the lower `s`. */
export function lowS(s: bigint): bigint {
  return s > P256_N / 2n ? P256_N - s : s;
}

/** How the owner contract names a device's passkey: the hash of its public key. */
export function passkeyKeyId(qx: Hex, qy: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [qx, qy]));
}

/**
 * Packs a passkey's answer as the signature an EmailOwner accepts: which device, and what its passkey returned
 * when asked to sign a 32-byte value as the challenge.
 */
export function encodePasskeySignature(keyId: Hex, assertion: PasskeyAssertion): Hex {
  return encodeAbiParameters(
    [
      { type: "bytes32" },
      {
        type: "tuple",
        components: [
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
          { name: "challengeIndex", type: "uint256" },
          { name: "typeIndex", type: "uint256" },
          { name: "authenticatorData", type: "bytes" },
          { name: "clientDataJSON", type: "string" },
        ],
      },
    ],
    [
      keyId,
      {
        r: assertion.r,
        s: assertion.s,
        challengeIndex: BigInt(assertion.clientDataJSON.indexOf('"challenge":"')),
        typeIndex: BigInt(assertion.clientDataJSON.indexOf('"type":"webauthn.get"')),
        authenticatorData: assertion.authenticatorData,
        clientDataJSON: assertion.clientDataJSON,
      },
    ],
  );
}
