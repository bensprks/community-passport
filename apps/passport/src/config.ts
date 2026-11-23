import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Address, type Hex, getAddress, isHex } from "viem";

export type Config = {
  /** The Passport's public URL. Its host is the domain every passkey belongs to, so it must never change. */
  issuer: string;
  port: number;
  /** Where the database lives. */
  dataDir: string;
  chainId: number;
  rpcUrl: string;
  grantRegistry: Address;
  accountFactory: Address;
  /** The contracts a grant may name: the Lens feeds, graphs and so on. Never a token. */
  scopeTargets: Address[];
  /** Pays the gas for creating Accounts and for submitting grants and revocations. Holds no user's rights. */
  relayerKey: Hex;
  /** Encrypts the development key store. */
  keyStoreSecret: string;
  /** The apps that may ask for sign-in, see clubs.example.json. */
  clubsFile: string;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Reads the configuration from the environment. The chain's addresses default to the local chain's, which
 * `pnpm chain` writes to .data/local.json.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, root: string = process.cwd()): Config {
  const dataDir = resolve(root, env.PASSPORT_DATA_DIR ?? ".data");
  const localFile = resolve(root, ".data/local.json");
  const local: Record<string, string | number> = existsSync(localFile)
    ? JSON.parse(readFileSync(localFile, "utf8"))
    : {};
  const localTargets = [local.feed, local.graph, local.clubFeed].filter(Boolean).join(",");
  const scopeTargets = env.PASSPORT_SCOPE_TARGETS ?? (localTargets || required(env, "PASSPORT_SCOPE_TARGETS"));

  const relayerKey = required(env, "PASSPORT_RELAYER_KEY");
  if (!isHex(relayerKey) || relayerKey.length !== 66) throw new Error("PASSPORT_RELAYER_KEY is not a private key");

  return {
    issuer: env.PASSPORT_ISSUER ?? "http://localhost:4000",
    port: Number(env.PASSPORT_PORT ?? 4000),
    dataDir,
    chainId: Number(env.PASSPORT_CHAIN_ID ?? local.chainId ?? required(env, "PASSPORT_CHAIN_ID")),
    rpcUrl: String(env.PASSPORT_RPC_URL ?? local.rpcUrl ?? required(env, "PASSPORT_RPC_URL")),
    grantRegistry: getAddress(
      String(env.PASSPORT_GRANT_REGISTRY ?? local.grantRegistry ?? required(env, "PASSPORT_GRANT_REGISTRY")),
    ),
    accountFactory: getAddress(
      String(env.PASSPORT_ACCOUNT_FACTORY ?? local.accountFactory ?? required(env, "PASSPORT_ACCOUNT_FACTORY")),
    ),
    scopeTargets: scopeTargets.split(",").map((target) => getAddress(target.trim())),
    relayerKey,
    keyStoreSecret: required(env, "PASSPORT_KEYSTORE_SECRET"),
    clubsFile: resolve(root, env.PASSPORT_CLUBS_FILE ?? "clubs.json"),
  };
}
