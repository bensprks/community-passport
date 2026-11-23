// The whole design against a local chain with the real Lens contracts: run `pnpm chain` first.
//
// A scripted club and a scripted browser stand in for a community app and a member. Nothing is mocked on the
// Passport's side except the mailbox, and the passkey: a plain key stands in for the one a passkey would derive,
// since the server only ever sees that key's address and signatures.
import assert from "node:assert/strict";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";
import { grantRegistryAbi, grantTypedData, hashScopes } from "@community-passport/grants";
import {
  type Chain,
  type Config,
  type KeyStore,
  LocalKeyStore,
  type Mailer,
  createApp,
  createChain,
  lensAbi,
  openDb,
  parseClubs,
  policySettings,
} from "@community-passport/passport";
import {
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  isAddressEqual,
  parseEther,
  parseEventLogs,
  toFunctionSelector,
  toHex,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { Browser } from "./browser.ts";

// Two of the local node's funded accounts that the Lens deployment gives no role. They come from anvil's public
// test phrase: never use them anywhere real.
const ANVIL_PHRASE = "test test test test test test test test test test test junk";
const anvilKey = (index: number) =>
  toHex(mnemonicToAccount(ANVIL_PHRASE, { addressIndex: index }).getHdKey().privateKey as Uint8Array);
const RELAYER_KEY = anvilKey(8);
const CLUB_KEY = anvilKey(9);

const localFile = new URL("../.data/local.json", import.meta.url);
const lensAbis = new URL("../contracts/lib/lens-monad-protocol/ABIs/", import.meta.url);
const loadAbi = (name: string) => JSON.parse(readFileSync(new URL(`${name}.abi.json`, lensAbis), "utf8")) as Abi;
const selectorOf = (abi: Abi, name: string) =>
  toFunctionSelector(abi.find((item) => item.type === "function" && item.name === name) as AbiFunction);

const base64url = (bytes: Buffer) => bytes.toString("base64url");
/** The one thing the test club asks for that a member may leave out. */
const DELETE_ANY = "Delete your posts in the club's feed";

class Outbox implements Mailer {
  readonly codes = new Map<string, string>();
  async sendCode(email: string, code: string) {
    this.codes.set(email, code);
  }
  async sendDeviceRequest() {}
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

describe("a club signs a member in through the Passport and acts for them on Lens", () => {
  const feedAbi = loadAbi("IFeed");
  const graphAbi = loadAbi("IGraph");
  const club = privateKeyToAccount(CLUB_KEY);
  const redirectUri = "http://127.0.0.1:5001/callback";
  /** A second address the club registered, on another domain. */
  const otherRedirectUri = "http://localhost:5002/callback";
  const email = `maya-${Date.now()}@example.com`;
  const outbox = new Outbox();

  let local: {
    chainId: number;
    rpcUrl: string;
    grantRegistry: Address;
    accountFactory: Address;
    /** The feed every app shares. */
    feed: Address;
    graph: Address;
    /** The club's own feed, which is the one its grants name. */
    clubFeed: Address;
  };
  let localChain: ReturnType<typeof defineChain>;
  let config: Config;
  let chain: Chain;
  let server: Server;
  let browser: Browser;
  let db: ReturnType<typeof openDb>;
  let clubClient: ReturnType<typeof createWalletClient>;
  /** The member's Lens Account, learnt from their ID token like a club learns it. */
  let account: Address;
  /** Stands in for the key a passkey derives in the member's browser. */
  const passkeyKey = privateKeyToAccount(generatePrivateKey());
  /** Makes the key store's next transaction fail, either before it is sent or after it went through. */
  let breakNextTransfer: { to: Address; when: "before" | "after" } | undefined;
  /** Makes the next Account creation go through on the chain and then fail, as if the answer never arrived. */
  let breakNextCreation = false;

  before(async () => {
    assert.ok(existsSync(localFile), "No local chain found. Run `pnpm chain` in another terminal first.");
    local = JSON.parse(readFileSync(localFile, "utf8"));
    const port = await freePort();
    config = {
      issuer: `http://127.0.0.1:${port}`,
      port,
      dataDir: "",
      chainId: local.chainId,
      rpcUrl: local.rpcUrl,
      grantRegistry: local.grantRegistry,
      accountFactory: local.accountFactory,
      scopeTargets: [local.feed, local.graph, local.clubFeed],
      relayerKey: RELAYER_KEY,
      keyStoreSecret: "e2e",
      clubsFile: "",
      custody: "vendor",
    };
    chain = createChain(config);
    await chain.publicClient.getChainId().catch(() => assert.fail("The local chain is not answering. Run `pnpm chain`."));

    db = openDb(":memory:");
    const clubs = parseClubs(
      JSON.stringify([
        {
          clientId: "queens-book-club",
          name: "Queens Book Club",
          clientSecret: "e2e-secret",
          redirectUris: [redirectUri, otherRedirectUri],
          grantee: club.address,
          grantDays: 90,
          permissions: [
            { label: "Post as you", target: local.clubFeed, selector: selectorOf(feedAbi, "createPost") },
            { label: "Follow people as you", target: local.graph, selector: selectorOf(graphAbi, "follow") },
            { label: DELETE_ANY, target: local.clubFeed, selector: selectorOf(feedAbi, "deletePost"), optional: true },
          ],
        },
      ]),
      config.scopeTargets,
    );
    // The real key store, with a way to cut a transaction short like a crash or a dropped connection would.
    const store = new LocalKeyStore(db, chain, config.keyStoreSecret, policySettings(config.chainId, config.grantRegistry, clubs));
    const keyStore: KeyStore = {
      create: (userId) => store.create(userId),
      signTypedData: (userId, typedData, member) => store.signTypedData(userId, typedData, member),
      destroy: (userId) => store.destroy(userId),
      async sendTransaction(userId, transaction, member) {
        const failure = breakNextTransfer && isAddressEqual(breakNextTransfer.to, transaction.to) ? breakNextTransfer : undefined;
        if (failure) breakNextTransfer = undefined;
        if (failure?.when === "before") throw new Error("simulated: the transaction was never sent");
        await store.sendTransaction(userId, transaction, member);
        if (failure?.when === "after") throw new Error("simulated: the connection dropped after the transaction went through");
      },
    };
    const flakyChain: Chain = {
      ...chain,
      async createAccount(owner) {
        const created = await chain.createAccount(owner);
        if (breakNextCreation) {
          breakNextCreation = false;
          throw new Error("simulated: the connection dropped after the Account was created");
        }
        return created;
      },
    };
    const { app } = await createApp({ config, db, clubs, chain: flakyChain, keyStore, mailer: outbox });
    server = app.listen(port, "127.0.0.1");
    browser = new Browser(config.issuer);
    localChain = defineChain({
      id: local.chainId,
      name: "Local",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [local.rpcUrl] } },
    });
    clubClient = createWalletClient({ account: club, transport: http(local.rpcUrl), chain: localChain });
  });

  after(() => {
    server?.close();
    db?.close();
  });

  // ------------------------------------------------------------------ What the club's server does

  /** Starts a sign-in the way a club's server does: a random state, nonce and PKCE secret, then a redirect. */
  function signInRequest(sendBackTo = redirectUri) {
    const verifier = base64url(randomBytes(32));
    const request = { verifier, state: base64url(randomBytes(16)), nonce: base64url(randomBytes(16)) };
    const query = new URLSearchParams({
      client_id: "queens-book-club",
      redirect_uri: sendBackTo,
      response_type: "code",
      scope: "openid",
      state: request.state,
      nonce: request.nonce,
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    });
    return { ...request, url: `/auth?${query}` };
  }

  /** Swaps the one-time code for an ID token, server to server, and checks the token like a club must. */
  async function redeem(callback: URL, request: ReturnType<typeof signInRequest>): Promise<Address> {
    assert.equal(callback.origin + callback.pathname, redirectUri);
    assert.equal(callback.searchParams.get("state"), request.state);
    const response = await fetch(`${config.issuer}/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("queens-book-club:e2e-secret").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code") ?? "",
        redirect_uri: redirectUri,
        code_verifier: request.verifier,
      }),
    });
    const tokens = (await response.json()) as { id_token?: string; error_description?: string };
    assert.ok(tokens.id_token, `no ID token: ${tokens.error_description}`);

    const [header = "", payload = "", signature = ""] = tokens.id_token.split(".");
    const { kid } = JSON.parse(Buffer.from(header, "base64url").toString());
    const { keys } = (await (await fetch(`${config.issuer}/jwks`)).json()) as { keys: { kid: string }[] };
    const key = createPublicKey({ key: keys.find((jwk) => jwk.kid === kid) as never, format: "jwk" });
    assert.ok(
      verify("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")),
      "the ID token's signature is wrong",
    );
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    assert.equal(claims.iss, config.issuer);
    assert.equal(claims.aud, "queens-book-club");
    assert.equal(claims.nonce, request.nonce);
    assert.ok(claims.exp > Date.now() / 1000);
    assert.equal(claims.email, undefined, "the club is not told the member's email");
    return claims.sub;
  }

  const post = (contentURI: string) =>
    encodeFunctionData({
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

  /** The club's server acts with its own key, through the registry. */
  async function clubExecutes(target: Address, data: Hex) {
    const { request } = await chain.publicClient.simulateContract({
      account: club,
      address: local.grantRegistry,
      abi: grantRegistryAbi,
      functionName: "execute",
      args: [account, target, data],
    });
    const hash = await clubClient.writeContract(request);
    return chain.publicClient.waitForTransactionReceipt({ hash });
  }

  const uidOf = (consentPage: string) => /\/interaction\/([\w-]+)\/deny/.exec(consentPage)?.[1] ?? assert.fail("not a consent page");
  const grantOf = () =>
    chain.publicClient.readContract({ address: local.grantRegistry, abi: grantRegistryAbi, functionName: "grantOf", args: [account, club.address] });

  // ------------------------------------------------------------------ The story

  let firstPost: bigint;
  const deleteFirstPost = () => encodeFunctionData({ abi: feedAbi, functionName: "deletePost", args: [firstPost, [], []] });
  const scopesWithDelete = () => [
    { target: local.clubFeed, selector: selectorOf(feedAbi, "createPost") },
    { target: local.graph, selector: selectorOf(graphAbi, "follow") },
    { target: local.clubFeed, selector: selectorOf(feedAbi, "deletePost") },
  ];
  let firstRequest: ReturnType<typeof signInRequest>;
  let firstCallback: URL;

  test("a new member signs in with an email code, on the Passport's page", async () => {
    firstRequest = signInRequest();
    const loginPage = await browser.get(firstRequest.url);
    assert.equal(loginPage.status, 200);
    assert.match(loginPage.body, /Email me a code/);
    const returnTo = /name="return" value="([^"]+)"/.exec(loginPage.body)?.[1] ?? "";

    const codePage = await browser.postForm("/login/email", { email, return: returnTo });
    assert.match(codePage.body, /Enter your code/);
    const code = outbox.codes.get(email);
    assert.match(code ?? "", /^\d{8}$/);

    // A wrong code gets nowhere.
    const wrong = await browser.postForm("/login/code", { code: code === "00000000" ? "11111111" : "00000000", return: returnTo });
    assert.equal(wrong.status, 401);

    // The right one signs in, creates the member's Lens Account, and lands on the consent screen.
    const consent = await browser.postForm("/login/code", { code: code as string, return: returnTo });
    assert.equal(consent.status, 200);
    assert.match(consent.body, /127\.0\.0\.1:5001/, "the club's domain is shown");
    assert.match(consent.body, /Post as you/);
    assert.match(consent.body, /Follow people as you/);
    assert.match(consent.body, /type="checkbox" name="optional" value="Delete your posts in the club[^"]*">/, "what is optional starts unticked");

    // Tapping Allow records the grant onchain and sends the member back to the club with a one-time code.
    const allowed = await browser.postForm(`/interaction/${uidOf(consent.body)}/allow`);
    assert.ok(allowed.leftFor, "the member is sent back to the club");
    firstCallback = allowed.leftFor;
  });

  test("the ID token names the member's Lens Account, which the Passport's key owns", async () => {
    account = await redeem(firstCallback, firstRequest);
    const owner = await chain.ownerOf(account);
    assert.ok(!isAddressEqual(owner, chain.relayerAddress), "the relayer pays gas and owns nothing");
    assert.ok(!isAddressEqual(owner, club.address));
    const isManager = await chain.publicClient.readContract({
      address: account,
      abi: lensAbi,
      functionName: "isAccountManager",
      args: [local.grantRegistry],
    });
    assert.ok(isManager, "the registry is the Account's manager from creation");

    const [scopeId, expiry] = await grantOf();
    assert.equal(
      scopeId,
      hashScopes([
        { target: local.clubFeed, selector: selectorOf(feedAbi, "createPost") },
        { target: local.graph, selector: selectorOf(graphAbi, "follow") },
      ]),
    );
    // Measured on the chain's clock, which runs ahead of this machine's when a local chain mines quickly.
    const days = Number(expiry - (await chain.currentTime())) / 86400;
    assert.ok(days > 89 && days <= 90, `the grant lasts 90 days, got ${days}`);
  });

  test("the club posts to Lens as the member, with its own key and no prompt", async () => {
    const receipt = await clubExecutes(local.clubFeed, post("lens://e2e/first-review"));
    assert.equal(receipt.status, "success");
    const [created] = parseEventLogs({ abi: feedAbi, eventName: "Lens_Feed_PostCreated", logs: receipt.logs });
    assert.ok(created, "the feed recorded a post");
    firstPost = (created.args as unknown as { postId: bigint }).postId;
    assert.ok(isAddressEqual((created.args as { author: Address }).author, account), "the member's Account is the author");
  });

  test("the club cannot do anything outside its grant", async () => {
    // The member left "delete" unticked, so it is not in the grant.
    await assert.rejects(clubExecutes(local.clubFeed, deleteFirstPost()), /NotInScope/);
    // The same function on a contract that is not in the grant: the grant names the club's feed, not the shared one.
    await assert.rejects(clubExecutes(local.feed, post("lens://e2e/shared-feed")), /NotInScope/);
    await assert.rejects(clubExecutes(local.graph, post("lens://e2e/elsewhere")), /NotInScope/);
    // Nor can anyone else use the club's grant.
    await assert.rejects(
      chain.publicClient.simulateContract({
        account: chain.relayerAddress,
        address: local.grantRegistry,
        abi: grantRegistryAbi,
        functionName: "execute",
        args: [account, local.clubFeed, post("lens://e2e/stranger")],
      }),
      /GrantNotActive/,
    );
  });

  test("an Account created without the Passport hearing back is found again, not made twice", async (t) => {
    const logged = t.mock.method(console, "error", () => {});
    const other = new Browser(config.issuer);
    const otherEmail = `noor-${Date.now()}@example.com`;
    const signIn = async () => {
      await other.postForm("/login/email", { email: otherEmail, return: "/account" });
      return other.postForm("/login/code", { code: outbox.codes.get(otherEmail) as string, return: "/account" });
    };

    breakNextCreation = true;
    assert.equal((await signIn()).status, 500);
    assert.match(String(logged.mock.calls[0]?.arguments[0]), /simulated/);
    const pending = db.prepare("SELECT user_id AS id, owner FROM provisioning WHERE email = ?").get(otherEmail) as { id: string; owner: Address };
    const created = await chain.accountCreatedFor(pending.owner);
    assert.ok(created, "the Account exists on the chain");
    assert.ok(db.prepare("SELECT 1 FROM keys WHERE user_id = ?").get(pending.id), "and the key that owns it was kept");

    // Straight away, another attempt is told to wait: the first may still be running.
    assert.equal((await signIn()).status, 409);

    // Once the first is clearly over, signing in picks the same Account up.
    db.prepare("UPDATE provisioning SET started_at = started_at - 600 WHERE email = ?").run(otherEmail);
    assert.match((await signIn()).body, new RegExp(created, "i"));
    const creations = await chain.publicClient.getContractEvents({
      address: local.accountFactory,
      abi: lensAbi,
      eventName: "Lens_Account_Created",
      args: { owner: pending.owner },
      fromBlock: "earliest",
    });
    assert.equal(creations.length, 1, "one Account, not two");
  });

  test("signing in again asks the member for nothing", async () => {
    const request = signInRequest();
    const result = await browser.get(request.url);
    assert.ok(result.leftFor, "no login and no consent screen: straight back to the club");
    assert.equal(await redeem(result.leftFor, request), account);
  });

  test("after signing out, the Passport asks who is there before it answers a club", async () => {
    await browser.postForm("/logout");
    const request = signInRequest();
    const loginPage = await browser.get(request.url);
    assert.equal(loginPage.leftFor, undefined, "the club gets nothing while nobody is signed in");
    assert.match(loginPage.body, /Email me a code/);
    const returnTo = /name="return" value="([^"]+)"/.exec(loginPage.body)?.[1] ?? "";

    // Signing in again is enough: the grant is still live, so there is no consent screen.
    await browser.postForm("/login/email", { email, return: returnTo });
    const result = await browser.postForm("/login/code", { code: outbox.codes.get(email) as string, return: returnTo });
    assert.ok(result.leftFor);
    assert.equal(await redeem(result.leftFor, request), account);
  });

  test("the member disconnects the club from their account page", async () => {
    const page = await browser.get("/account");
    assert.match(page.body, /Queens Book Club/);

    const after = await browser.postForm("/account/revoke", { grantee: club.address });
    assert.doesNotMatch(after.body, /Queens Book Club/);
    assert.equal((await grantOf())[1], 0n);
    await assert.rejects(clubExecutes(local.clubFeed, post("lens://e2e/after-revoke")), /GrantNotActive/);
  });

  test("connecting again with the optional box ticked lets the club delete, and the account page says so", async () => {
    // The domain shown is the one this request sends the member back to, not just the first one registered.
    assert.match((await browser.get(signInRequest(otherRedirectUri).url)).body, /<h1>localhost:5002<\/h1>/);

    const request = signInRequest();
    const consent = await browser.get(request.url);
    assert.match(consent.body, /<h1>127\.0\.0\.1:5001<\/h1>/);
    assert.match(consent.body, /Only if you tick it/);
    const allowed = await browser.postForm(`/interaction/${uidOf(consent.body)}/allow`, { optional: DELETE_ANY });
    assert.ok(allowed.leftFor);
    assert.equal(await redeem(allowed.leftFor, request), account);
    assert.equal((await grantOf())[0], hashScopes(scopesWithDelete()));
    assert.match((await browser.get("/account")).body, /Also allowed: Delete your posts in the club&#39;s feed/);

    const receipt = await clubExecutes(local.clubFeed, deleteFirstPost());
    assert.equal(receipt.status, "success");
  });

  test("turning app access off ends every grant and takes the registry off the Account, until an app is connected again", async () => {
    const off = await browser.postForm("/account/disconnect-all");
    assert.match(off.body, /App access is off/);
    assert.equal((await grantOf())[1], 0n);
    assert.equal(await chain.isRegistryManager(account), false);
    await assert.rejects(clubExecutes(local.clubFeed, post("lens://e2e/while-off")), /GrantNotActive/);

    // Connecting an app puts the registry back. The earlier grant, with its extra permission, does not come back.
    const request = signInRequest();
    const consent = await browser.get(request.url);
    const allowed = await browser.postForm(`/interaction/${uidOf(consent.body)}/allow`);
    assert.ok(allowed.leftFor);
    assert.equal(await chain.isRegistryManager(account), true);
    assert.equal((await clubExecutes(local.clubFeed, post("lens://e2e/back-on"))).status, "success");
    await assert.rejects(clubExecutes(local.clubFeed, deleteFirstPost()), /NotInScope/);

    // Disconnect again, so that the next steps start without a grant.
    await browser.postForm("/account/revoke", { grantee: club.address });
    assert.equal((await grantOf())[1], 0n);
  });

  /** Asks the Passport to hand the Account to `key`, proving the browser holds it. */
  async function handOverTo(key: typeof passkeyKey) {
    const { message } = await browser.getJson<{ message: string }>("/passkey/challenge");
    return browser.postJson("/account/handover", { address: key.address, signature: await key.signMessage({ message }) });
  }
  /** How many keys the Passport holds for this member: one until the handover is done, then none. */
  const keysHeld = () =>
    (db.prepare("SELECT COUNT(*) AS count FROM keys WHERE user_id = (SELECT id FROM users WHERE email = ?)").get(email) as { count: number }).count;

  test("a handover that stops half-way can only be finished with the same passkey", async (t) => {
    // The failure below is made on purpose. The server logs it, as it should; keep that out of the test's output.
    const logged = t.mock.method(console, "error", () => {});
    const proxyAdmin = await chain.proxyAdminOf(account);
    assert.match((await browser.get("/account/passkey")).body, /Create a passkey and move my account/);

    // The proxy admin moves, then the Account's own transfer fails.
    breakNextTransfer = { to: account, when: "before" };
    assert.equal((await handOverTo(passkeyKey)).status, 500);
    assert.match(String(logged.mock.calls[0]?.arguments[0]), /simulated/, "the server logged the failure");
    assert.ok(isAddressEqual(await chain.ownerOf(proxyAdmin), passkeyKey.address));
    assert.ok(!isAddressEqual(await chain.ownerOf(account), passkeyKey.address), "the Passport's key still owns the Account");
    assert.equal(keysHeld(), 1, "and the Passport still holds that key");

    const page = (await browser.get("/account/passkey")).body;
    assert.match(page, /Finish with that passkey/);
    assert.doesNotMatch(page, /Make a new passkey instead/);
    const otherPasskey = privateKeyToAccount(generatePrivateKey());
    assert.equal((await handOverTo(otherPasskey)).status, 409, "another passkey cannot finish it");
  });

  test("the member takes the key over: the Account and its proxy admin move to their own key", async (t) => {
    // This time everything goes through on the chain, but the Passport never hears back. Also on purpose.
    const logged = t.mock.method(console, "error", () => {});
    breakNextTransfer = { to: account, when: "after" };
    assert.equal((await handOverTo(passkeyKey)).status, 500);
    assert.match(String(logged.mock.calls[0]?.arguments[0]), /simulated/, "the server logged the failure");
    assert.ok(isAddressEqual(await chain.ownerOf(account), passkeyKey.address));
    assert.ok(isAddressEqual(await chain.ownerOf(await chain.proxyAdminOf(account)), passkeyKey.address));

    // The Passport reads the chain the next time it sees the member, and records what happened. The session that
    // an email code opened ends with it: from here on, only the new key signs in.
    assert.match((await browser.get("/account")).body, /Email me a code/);
    assert.equal(keysHeld(), 0, "the Passport holds no key for this member any more");
  });

  test("after that, an email code alone does not sign in", async () => {
    await browser.postForm("/logout");
    const fresh = new Browser(config.issuer);
    await fresh.postForm("/login/email", { email, return: "/account" });
    const page = await fresh.postForm("/login/code", { code: outbox.codes.get(email) as string, return: "/account" });
    assert.match(page.body, /Use your passkey/);
    assert.ok(!fresh.hasCookie("pp_session"), "no session was started");

    // A signature from some other key does not sign in either.
    const stranger = privateKeyToAccount(generatePrivateKey());
    const challenge = await fresh.getJson<{ message: string }>("/passkey/challenge");
    const refused = await fresh.postJson("/login/passkey", {
      address: stranger.address,
      signature: await stranger.signMessage({ message: challenge.message }),
    });
    assert.equal(refused.status, 401);
  });

  test("the member's own key signs in, and approves the club by signature", async () => {
    const { message } = await browser.getJson<{ message: string }>("/passkey/challenge");
    const login = await browser.postJson("/login/passkey", {
      address: passkeyKey.address,
      signature: await passkeyKey.signMessage({ message }),
      return: "/account",
    });
    assert.equal(login.status, 200);

    const request = signInRequest();
    const consent = await browser.get(request.url);
    assert.match(consent.body, /Allow with passkey/);
    const uid = uidOf(consent.body);

    // The Passport cannot sign this grant: a form post without the member's signature is refused.
    const unsigned = await browser.postJson(`/interaction/${uid}/allow`, {});
    assert.equal(unsigned.status, 400);

    type TypedData = { domain: never; types: never; primaryType: "Grant"; message: Record<string, string> };
    // The member ticks the optional box: their own key signs a grant that includes it, and nothing it was not shown.
    const ticked = new URLSearchParams([["optional", DELETE_ANY], ["optional", "Move money"]]);
    const typedData = await browser.getJson<TypedData & { message: { scopes: unknown[] } }>(`/interaction/${uid}/grant-request?${ticked}`);
    assert.equal(typedData.message.scopes.length, 3);
    const { expiry, nonce, deadline } = typedData.message;
    const signature = await passkeyKey.signTypedData({
      ...typedData,
      message: { ...typedData.message, expiry: BigInt(expiry as string), nonce: BigInt(nonce as string), deadline: BigInt(deadline as string) },
    } as never);
    const allowed = await browser.postJson<{ redirect: string }>(`/interaction/${uid}/allow`, { optional: [DELETE_ANY], expiry, nonce, deadline, signature });
    assert.equal(allowed.status, 200);

    const back = await browser.get(new URL(allowed.body.redirect).pathname);
    assert.ok(back.leftFor);
    assert.equal(await redeem(back.leftFor, request), account, "the same Account as before the handover");
    assert.equal((await grantOf())[0], hashScopes(scopesWithDelete()));

    const receipt = await clubExecutes(local.clubFeed, post("lens://e2e/second-review"));
    assert.equal(receipt.status, "success");
  });

  type FromServer = { domain: never; types: never; primaryType: never; message: Record<string, string> };
  /** Signs what the Passport hands the member's browser, the way the passkey page does. */
  async function signFromServer(typedData: FromServer) {
    const { nonce, deadline } = typedData.message;
    const message = { ...typedData.message, nonce: BigInt(nonce as string), deadline: BigInt(deadline as string) };
    return { nonce, deadline, signature: await passkeyKey.signTypedData({ ...typedData, message } as never) };
  }

  test("the account page lists every key that can act, and the member's key ends one of them or all", async () => {
    // A grant the Passport had no part in: the member's key signs one for a key that no app is registered with.
    const unknown = privateKeyToAccount(generatePrivateKey());
    const time = await chain.currentTime();
    const grant = {
      account,
      grantee: unknown.address,
      scopes: [{ target: local.graph, selector: selectorOf(graphAbi, "follow") }],
      expiry: time + 86400n,
      nonce: 77n,
      deadline: time + 600n,
    };
    const signature = await passkeyKey.signTypedData(grantTypedData(local.chainId, local.grantRegistry, grant));
    await chain.submitGrant({ ...grant, signature });

    const page = (await browser.get("/account")).body;
    assert.match(page, /Queens Book Club/);
    assert.match(page, /An app this Passport does not know/);
    assert.match(page, new RegExp(unknown.address, "i"));

    // It is removed by its address, registered or not.
    const revoke = await browser.getJson<FromServer>(`/account/revoke-request?grantee=${unknown.address}`);
    const removed = await browser.postJson("/account/revoke", { grantee: unknown.address, ...(await signFromServer(revoke)) });
    assert.equal(removed.status, 200);
    assert.doesNotMatch((await browser.get("/account")).body, /does not know/);

    // And everything at once.
    const revokeAll = await browser.getJson<FromServer>("/account/revoke-all-request");
    const ended = await browser.postJson("/account/disconnect-all", await signFromServer(revokeAll));
    assert.equal(ended.status, 200);
    assert.equal((await grantOf())[1], 0n);
    await assert.rejects(clubExecutes(local.clubFeed, post("lens://e2e/after-everything")), /GrantNotActive/);
  });

  test("when the Account changes hands outside the Passport, the old owner's session ends", async () => {
    // The member's key sends the Account to someone else directly, with no Passport involved.
    await chain.publicClient.waitForTransactionReceipt({
      hash: await clubClient.sendTransaction({ account: club, chain: localChain, to: passkeyKey.address, value: parseEther("1") }),
    });
    const ownerClient = createWalletClient({ account: passkeyKey, transport: http(local.rpcUrl), chain: localChain });
    const newOwner = privateKeyToAccount(generatePrivateKey()).address;
    await chain.publicClient.waitForTransactionReceipt({
      hash: await ownerClient.sendTransaction({
        account: passkeyKey,
        chain: localChain,
        to: account,
        data: encodeFunctionData({ abi: lensAbi, functionName: "transferOwnership", args: [newOwner] }),
      }),
    });

    assert.match((await browser.get("/account")).body, /Email me a code/, "the Passport's own pages ask who is there");
    assert.equal((await browser.get(signInRequest().url)).leftFor, undefined, "and clubs are no longer told this browser is that member");
  });
});
