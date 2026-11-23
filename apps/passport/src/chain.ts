import { type Scope, grantRegistryAbi, hashScopes } from "@community-passport/grants";
import {
  type Address,
  type Hex,
  type LocalAccount,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.ts";

/** The parts of the Lens contracts the Passport calls. */
export const lensAbi = parseAbi([
  "struct AccountManagerPermissions { bool canExecuteTransactions; bool canTransferTokens; bool canTransferNative; bool canSetMetadataURI; }",
  "struct SourceStamp { address source; address originalMsgSender; address validator; uint256 nonce; uint256 deadline; bytes signature; }",
  "struct KeyValue { bytes32 key; bytes value; }",
  "function deployAccount(address owner, string metadataURI, address[] accountManagers, AccountManagerPermissions[] accountManagersPermissions, SourceStamp sourceStamp, KeyValue[] extraData) returns (address)",
  "event Lens_Account_Created(address indexed account, address indexed owner, string metadataURI, address[] accountManagers, AccountManagerPermissions[] accountManagersPermissions, address indexed source, KeyValue[] extraData)",
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner)",
  "function isAccountManager(address accountManager) view returns (bool)",
]);

/** Where a Lens Account's proxy keeps the address of its proxy admin (the ERC-1967 admin slot). */
const PROXY_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const ZERO = "0x0000000000000000000000000000000000000000";
const NO_SOURCE = { source: ZERO, originalMsgSender: ZERO, validator: ZERO, nonce: 0n, deadline: 0n, signature: "0x" } as const;
/** What the registry is on an Account: a manager that can have it call things, and nothing else. */
const REGISTRY_PERMISSIONS = {
  canExecuteTransactions: true,
  canTransferTokens: false,
  canTransferNative: false,
  canSetMetadataURI: false,
} as const;

export type SignedGrant = {
  account: Address;
  grantee: Address;
  scopes: readonly Scope[];
  expiry: bigint;
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
};

export type SignedRevoke = { account: Address; grantee: Address; nonce: bigint; deadline: bigint; signature: Hex };

export type Chain = ReturnType<typeof createChain>;

export function createChain(config: Config) {
  const chain = defineChain({
    id: config.chainId,
    name: "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const relayer = privateKeyToAccount(config.relayerKey);
  const relayerClient = createWalletClient({ chain, transport, account: relayer });
  const registry = { address: config.grantRegistry, abi: grantRegistryAbi } as const;

  // The relayer's transactions go out one at a time, so that two requests never pick the same nonce.
  let queue: Promise<unknown> = Promise.resolve();
  function inTurn<T>(send: () => Promise<T>): Promise<T> {
    const result = queue.then(send, send);
    queue = result.catch(() => undefined);
    return result;
  }

  async function mined(hash: Hex) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return receipt;
  }

  /**
   * The time the next block will see, in Unix seconds: the later of the last block's time and this server's
   * clock. On a chain that has been idle, the last block alone would be in the past.
   */
  async function currentTime(): Promise<bigint> {
    const { timestamp } = await publicClient.getBlock();
    const clock = BigInt(Math.floor(Date.now() / 1000));
    return timestamp > clock ? timestamp : clock;
  }

  return {
    publicClient,
    relayerAddress: relayer.address,

    /** Creates a Lens Account owned by `owner`, with the registry as its only manager. The relayer pays. */
    async createAccount(owner: Address): Promise<Address> {
      return inTurn(async () => {
        const hash = await relayerClient.writeContract({
          address: config.accountFactory,
          abi: lensAbi,
          functionName: "deployAccount",
          args: [owner, "", [config.grantRegistry], [REGISTRY_PERMISSIONS], NO_SOURCE, []],
        });
        const receipt = await mined(hash);
        const [created] = parseEventLogs({ abi: lensAbi, eventName: "Lens_Account_Created", logs: receipt.logs });
        if (!created) throw new Error("the account factory did not report a new Account");
        return created.args.account;
      });
    },

    async ownerOf(account: Address): Promise<Address> {
      return publicClient.readContract({ address: account, abi: lensAbi, functionName: "owner" });
    },

    async proxyAdminOf(account: Address): Promise<Address> {
      const word = await publicClient.getStorageAt({ address: account, slot: PROXY_ADMIN_SLOT });
      return getAddress(`0x${(word ?? "0x").slice(-40).padStart(40, "0")}`);
    },

    /** The grant `grantee` holds on `account`: which functions (as their hash), until when, and how long is left. */
    async grantOf(account: Address, grantee: Address) {
      const [scopeId, expiry] = await publicClient.readContract({
        ...registry,
        functionName: "grantOf",
        args: [account, grantee],
      });
      const time = await currentTime();
      return { scopeId, expiry, secondsLeft: expiry > time ? Number(expiry - time) : 0 };
    },

    /** Stores the list of functions in the registry if nobody has yet, and submits the owner's signed grant. */
    async submitGrant(grant: SignedGrant): Promise<void> {
      const scopeId = hashScopes(grant.scopes);
      await inTurn(async () => {
        const defined = await publicClient.readContract({ ...registry, functionName: "isScopeDefined", args: [scopeId] });
        if (!defined) {
          await mined(await relayerClient.writeContract({ ...registry, functionName: "defineScope", args: [grant.scopes] }));
        }
        const hash = await relayerClient.writeContract({
          ...registry,
          functionName: "grantWithSig",
          args: [grant.account, grant.grantee, scopeId, grant.expiry, grant.nonce, grant.deadline, grant.signature],
        });
        await mined(hash);
      });
    },

    async submitRevoke(revoke: SignedRevoke): Promise<void> {
      await inTurn(async () => {
        const hash = await relayerClient.writeContract({
          ...registry,
          functionName: "revokeWithSig",
          args: [revoke.account, revoke.grantee, revoke.nonce, revoke.deadline, revoke.signature],
        });
        await mined(hash);
      });
    },

    /**
     * Sends one transaction from a key the Passport holds for a user. The key has no MON of its own, so the
     * relayer first sends it what the transaction will cost.
     */
    async sendFrom(owner: LocalAccount, to: Address, data: Hex): Promise<void> {
      const gas = await publicClient.estimateGas({ account: owner.address, to, data });
      const fees = await publicClient.estimateFeesPerGas();
      // Monad charges for the gas limit, not the gas used, so the limit is the cost.
      const cost = gas * fees.maxFeePerGas;
      await inTurn(async () => mined(await relayerClient.sendTransaction({ to: owner.address, value: cost })));
      const ownerClient = createWalletClient({ chain, transport, account: owner });
      await mined(await ownerClient.sendTransaction({ to, data, gas, ...fees }));
    },

    currentTime,
  };
}
