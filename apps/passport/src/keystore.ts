import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { grantTypedData, revokeTypedData } from "@community-passport/grants";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Chain } from "./chain.ts";
import { type PolicyContext, checkPolicy } from "./policy.ts";

export type RegistryTypedData = ReturnType<typeof grantTypedData> | ReturnType<typeof revokeTypedData>;

/**
 * Holds the key that owns a user's Account until the user takes it over. Whatever stands behind this interface
 * must refuse every request the policy does not allow (see policy.ts), whoever asks.
 */
export interface KeyStore {
  /** Makes a key for a new user and returns its address. */
  create(userId: string): Promise<Address>;
  /** Signs a grant or a revocation for the grant registry. */
  signTypedData(userId: string, typedData: RegistryTypedData, context: PolicyContext): Promise<Hex>;
  /** Sends a transfer of ownership, of the Account or of its proxy admin. */
  sendTransaction(userId: string, transaction: { to: Address; data: Hex }, context: PolicyContext): Promise<void>;
  /** Forgets a user's key, once it owns nothing. */
  destroy(userId: string): Promise<void>;
}

/**
 * FOR DEVELOPMENT ONLY. Keeps keys in the Passport's own database, encrypted with a secret from its environment,
 * so whoever controls the server controls the keys. In production a key vendor's sealed server takes this place
 * and enforces the policy itself.
 */
export class LocalKeyStore implements KeyStore {
  readonly #db: DatabaseSync;
  readonly #chain: Chain;
  readonly #secret: Buffer;

  constructor(db: DatabaseSync, chain: Chain, secret: string) {
    this.#db = db;
    this.#chain = chain;
    this.#secret = scryptSync(secret, "community-passport-keystore", 32);
  }

  async create(userId: string): Promise<Address> {
    const privateKey = generatePrivateKey();
    const { address } = privateKeyToAccount(privateKey);
    this.#db
      .prepare("INSERT INTO keys (user_id, address, ciphertext) VALUES (?, ?, ?)")
      .run(userId, address, this.#encrypt(privateKey));
    return address;
  }

  async signTypedData(userId: string, typedData: RegistryTypedData, context: PolicyContext): Promise<Hex> {
    checkPolicy(
      { kind: "typedData", domain: typedData.domain, primaryType: typedData.primaryType, message: typedData.message },
      context,
    );
    const account = this.#account(userId);
    return typedData.primaryType === "Grant" ? account.signTypedData(typedData) : account.signTypedData(typedData);
  }

  async sendTransaction(
    userId: string,
    transaction: { to: Address; data: Hex },
    context: PolicyContext,
  ): Promise<void> {
    checkPolicy({ kind: "transaction", ...transaction }, context);
    await this.#chain.sendFrom(this.#account(userId), transaction.to, transaction.data);
  }

  async destroy(userId: string): Promise<void> {
    this.#db.prepare("DELETE FROM keys WHERE user_id = ?").run(userId);
  }

  #account(userId: string) {
    const row = this.#db.prepare("SELECT ciphertext FROM keys WHERE user_id = ?").get(userId) as
      | { ciphertext: string }
      | undefined;
    if (!row) throw new Error("the key store holds no key for this user");
    return privateKeyToAccount(this.#decrypt(row.ciphertext));
  }

  #encrypt(privateKey: Hex): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#secret, iv);
    const data = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString("hex")).join(".");
  }

  #decrypt(ciphertext: string): Hex {
    const [iv, tag, data] = ciphertext.split(".").map((part) => Buffer.from(part, "hex")) as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv("aes-256-gcm", this.#secret, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8") as Hex;
  }
}
