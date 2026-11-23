import { randomBytes } from "node:crypto";
import { type Address, type Hex, encodeAbiParameters, keccak256, toBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Stands for a member's email address onchain without revealing it. FOR DEVELOPMENT: a hash of the address with a
 * secret the server holds. With real email proofs this becomes the proof system's own commitment to the address.
 */
export function emailIdOf(email: string, secret: string): Hex {
  return keccak256(toBytes(`${secret}:${email}`));
}

/** Produces what the owner contract's verifier takes as proof that a member sent an email approving `command`. */
export interface EmailProver {
  prove(emailId: Hex, command: Hex): Promise<Hex>;
}

/**
 * FOR DEVELOPMENT ONLY. Signs "I saw that email" with one key, for the AttestedEmailVerifier contract. Whoever
 * holds this key can add a device to any member, which is exactly what a real proof removes: there the proof is
 * made from the mail provider's own signature on the member's email, and this server cannot make one up.
 */
export class AttestingProver implements EmailProver {
  readonly #attestor;
  readonly #domain;

  constructor(attestorKey: Hex, chainId: number, verifier: Address) {
    this.#attestor = privateKeyToAccount(attestorKey);
    this.#domain = { name: "AttestedEmailVerifier", version: "1", chainId, verifyingContract: verifier } as const;
  }

  async prove(emailId: Hex, command: Hex): Promise<Hex> {
    const emailNullifier = toHex(randomBytes(32));
    const validUntil = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const signature = await this.#attestor.signTypedData({
      domain: this.#domain,
      types: {
        EmailSeen: [
          { name: "emailId", type: "bytes32" },
          { name: "command", type: "bytes32" },
          { name: "emailNullifier", type: "bytes32" },
          { name: "validUntil", type: "uint64" },
        ],
      },
      primaryType: "EmailSeen",
      message: { emailId, command, emailNullifier, validUntil },
    });
    return encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], [emailNullifier, validUntil, signature]);
  }
}
