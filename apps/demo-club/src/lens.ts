// What the club does on Lens as a member: every call goes through the grant registry, signed by the club's own
// key. The member's key is not involved, and neither is the Passport.
import { readFileSync } from "node:fs";
import { grantRegistryAbi } from "@community-passport/grants";
import {
  type Abi,
  type Address,
  type Hex,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type LensConfig = { chainId: number; rpcUrl: string; grantRegistry: Address; feed: Address; clubKey: Hex };

export type Post = { id: bigint; text: string; author: Address; transaction: Hex };

/** Why the registry or Lens refused a call, by the error's name, e.g. `GrantNotActive` or `NotInScope`. */
export class Refused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

const feedAbi = JSON.parse(
  readFileSync(new URL("../../../contracts/lib/lens-monad-protocol/ABIs/IFeed.abi.json", import.meta.url), "utf8"),
) as Abi;
const accountAbi = parseAbi([
  "struct AccountManagerPermissions { bool canExecuteTransactions; bool canTransferTokens; bool canTransferNative; bool canSetMetadataURI; }",
  "function addAccountManager(address accountManager, AccountManagerPermissions permissions)",
]);

const asText = (contentURI: string) => decodeURIComponent(contentURI.replace(/^data:text\/plain;charset=utf-8,/, ""));

export function createLens(config: LensConfig) {
  const chain = defineChain({
    id: config.chainId,
    name: "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const club = privateKeyToAccount(config.clubKey);
  const wallet = createWalletClient({ chain, transport, account: club });
  const registry = { address: config.grantRegistry, abi: grantRegistryAbi } as const;

  /** Has `account` call `target`, through the registry. Throws `Refused` if the grant does not allow it. */
  async function execute(account: Address, target: Address, data: Hex) {
    try {
      const { request } = await publicClient.simulateContract({
        ...registry,
        account: club,
        functionName: "execute",
        args: [account, target, data],
      });
      const hash = await wallet.writeContract(request);
      return await publicClient.waitForTransactionReceipt({ hash });
    } catch (error) {
      const reverted = error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError);
      if (reverted instanceof ContractFunctionRevertedError) throw new Refused(reverted.data?.errorName ?? "refused");
      throw error;
    }
  }

  return {
    clubAddress: club.address,

    /** Until when the member's grant to this club runs, or undefined if there is none. */
    async grantExpiry(account: Address): Promise<Date | undefined> {
      const [, expiry] = await publicClient.readContract({ ...registry, functionName: "grantOf", args: [account, club.address] });
      return Number(expiry) * 1000 > Date.now() ? new Date(Number(expiry) * 1000) : undefined;
    },

    /** Posts to the Lens feed as the member, then reads the post back from the chain. */
    async post(account: Address, text: string): Promise<Post> {
      const contentURI = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
      const data = encodeFunctionData({
        abi: feedAbi,
        functionName: "createPost",
        args: [
          { author: account, contentURI, repostedPostId: 0n, quotedPostId: 0n, repliedPostId: 0n, ruleChanges: [], extraData: [] },
          [],
          [],
          [],
          [],
        ],
      });
      const receipt = await execute(account, config.feed, data);
      const [created] = parseEventLogs({ abi: feedAbi, eventName: "Lens_Feed_PostCreated", logs: receipt.logs });
      if (!created) throw new Error("the feed did not record a post");
      const id = (created.args as unknown as { postId: bigint }).postId;
      const stored = (await publicClient.readContract({
        address: config.feed,
        abi: feedAbi,
        functionName: "getPost",
        args: [id],
      })) as { author: Address; contentURI: string };
      return { id, text: asText(stored.contentURI), author: stored.author, transaction: receipt.transactionHash };
    },

    /**
     * Tries something no grant covers: making the club's own key a full manager of the member's Account. This
     * is here to show the refusal. It never gets as far as a transaction.
     */
    async tryToTakeOver(account: Address): Promise<void> {
      const data = encodeFunctionData({
        abi: accountAbi,
        functionName: "addAccountManager",
        args: [club.address, { canExecuteTransactions: true, canTransferTokens: true, canTransferNative: true, canSetMetadataURI: true }],
      });
      await execute(account, account, data);
    },
  };
}

export type Lens = ReturnType<typeof createLens>;
