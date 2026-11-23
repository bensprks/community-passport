// Accounts rooted in an email, against a local chain with the real Lens contracts: run `pnpm chain` first.
//
// In this mode the Passport holds no key for a member. Their Account is owned by a contract, a device's passkey
// signs for it, and the member's email is the only thing that can add a device. Two things are stand-ins here:
// one key vouches for the email where a real deployment would prove it, and a P-256 key in this test plays the
// passkey, producing exactly what a browser's passkey returns.
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";
import { encodePasskeySignature, grantRegistryAbi, hashScopes, lowS, passkeyKeyId } from "@community-passport/grants";
import {
  AttestingProver,
  type Chain,
  type Config,
  LocalKeyStore,
  type Mailer,
  createApp,
  createChain,
  openDb,
  ownerAbi,
  parseClubs,
  policySettings,
} from "@community-passport/passport";
import {
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  bytesToHex,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  hashTypedData,
  http,
  isAddressEqual,
  numberToHex,
  toFunctionSelector,
  toHex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { Browser } from "./browser.ts";

// Three of the local node's funded test accounts, from its public test phrase: never use them anywhere real.
const anvilKey = (index: number) =>
  toHex(mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: index }).getHdKey().privateKey as Uint8Array);
const ATTESTOR_KEY = anvilKey(7);
const RELAYER_KEY = anvilKey(8);
const CLUB_KEY = anvilKey(9);

const localFile = new URL("../.data/local.json", import.meta.url);
const feedAbi = JSON.parse(readFileSync(new URL("../contracts/lib/lens-monad-protocol/ABIs/IFeed.abi.json", import.meta.url), "utf8")) as Abi;
const selectorOf = (name: string) => toFunctionSelector(feedAbi.find((item) => item.type === "function" && item.name === name) as AbiFunction);

class Outbox implements Mailer {
  readonly codes = new Map<string, string>();
  readonly deviceLinks = new Map<string, string>();
  async sendCode(email: string, code: string) {
    this.codes.set(email, code);
  }
  async sendDeviceRequest(email: string, standInLink: string) {
    this.deviceLinks.set(email, standInLink);
  }
}

/** A passkey as a browser has it: a P-256 key that signs what WebAuthn says a passkey signs. */
function makePasskey(origin: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const qx = bytesToHex(Buffer.from(jwk.x as string, "base64url"));
  const qy = bytesToHex(Buffer.from(jwk.y as string, "base64url"));
  const keyId = passkeyKeyId(qx, qy);
  return {
    credentialId: randomBytes(16).toString("base64url"),
    qx,
    qy,
    keyId,
    /** Signs `hash` as the challenge, and packs the answer the way the owner contract reads it. */
    sign(hash: Hex): Hex {
      const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(hash.slice(2), "hex").toString("base64url"), origin, crossOrigin: false });
      // The site the passkey belongs to, then "the member was present and was checked", then a counter.
      const authenticatorData = Buffer.concat([createHash("sha256").update(new URL(origin).hostname).digest(), Buffer.from([0x05, 0, 0, 0, 0])]);
      const signed = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
      const signature = createSign("sha256").update(signed).sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
      return encodePasskeySignature(keyId, {
        r: bytesToHex(signature.subarray(0, 32)),
        s: numberToHex(lowS(BigInt(bytesToHex(signature.subarray(32)))), { size: 32 }),
        authenticatorData: bytesToHex(authenticatorData),
        clientDataJSON,
      });
    },
  };
}

describe("a member whose Account is rooted in their email, with no key held for them", () => {
  const club = privateKeyToAccount(CLUB_KEY);
  const redirectUri = "http://127.0.0.1:5001/callback";
  const email = `ada-${Date.now()}@example.com`;
  const outbox = new Outbox();

  let local: { chainId: number; rpcUrl: string; grantRegistry: Address; accountFactory: Address; feed: Address; graph: Address; clubFeed: Address; ownerFactory: Address; emailVerifier: Address };
  let config: Config;
  let chain: Chain;
  let server: Server;
  let browser: Browser;
  let db: ReturnType<typeof openDb>;
  let clubClient: ReturnType<typeof createWalletClient>;
  let phone: ReturnType<typeof makePasskey>;
  /** What the Passport's database says about the member. */
  let member: { account: Address; owner: Address };

  before(async () => {
    assert.ok(existsSync(localFile), "No local chain found. Run `pnpm chain` in another terminal first.");
    local = JSON.parse(readFileSync(localFile, "utf8"));
    assert.ok(local.ownerFactory, "This chain was started before email-rooted accounts were added. Restart `pnpm chain`.");
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address() as { port: number };
        probe.close(() => resolve(free));
      });
    });
    config = {
      issuer: `http://127.0.0.1:${port}`,
      port,
      dataDir: "",
      chainId: local.chainId,
      rpcUrl: local.rpcUrl,
      grantRegistry: local.grantRegistry,
      accountFactory: local.accountFactory,
      scopeTargets: [local.clubFeed],
      relayerKey: RELAYER_KEY,
      keyStoreSecret: "e2e",
      clubsFile: "",
      custody: "email",
      email: { ownerFactory: local.ownerFactory, verifier: local.emailVerifier, attestorKey: ATTESTOR_KEY },
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
          redirectUris: [redirectUri],
          grantee: club.address,
          permissions: [{ label: "Post in the club's feed as you", target: local.clubFeed, selector: selectorOf("createPost") }],
        },
      ]),
      config.scopeTargets,
    );
    const { app } = await createApp({
      config,
      db,
      clubs,
      chain,
      // Present because the app expects one, and never used: the last step checks it holds nothing.
      keyStore: new LocalKeyStore(db, chain, config.keyStoreSecret, policySettings(config.chainId, config.grantRegistry, clubs)),
      mailer: outbox,
      emailProver: new AttestingProver(ATTESTOR_KEY, config.chainId, local.emailVerifier),
    });
    server = app.listen(port, "127.0.0.1");
    browser = new Browser(config.issuer);
    phone = makePasskey(config.issuer);
    clubClient = createWalletClient({
      account: club,
      transport: http(local.rpcUrl),
      chain: defineChain({ id: local.chainId, name: "Local", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [local.rpcUrl] } } }),
    });
  });

  after(() => {
    server?.close();
    db?.close();
  });

  const signInUrl = () => {
    const query = new URLSearchParams({
      client_id: "queens-book-club",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid",
      state: randomBytes(8).toString("hex"),
      nonce: randomBytes(8).toString("hex"),
      code_challenge: createHash("sha256").update("a-verifier-long-enough-to-be-a-pkce-verifier-0123456789").digest("base64url"),
      code_challenge_method: "S256",
    });
    return `/auth?${query}`;
  };
  const uidOf = (consentPage: string) => /\/interaction\/([\w-]+)\/deny/.exec(consentPage)?.[1] ?? assert.fail("not a consent page");
  const post = (contentURI: string) =>
    encodeFunctionData({
      abi: feedAbi,
      functionName: "createPost",
      args: [{ author: member.account, contentURI, repostedPostId: 0n, quotedPostId: 0n, repliedPostId: 0n, ruleChanges: [], extraData: [] }, [], [], [], []],
    });
  async function clubExecutes(data: Hex) {
    const { request } = await chain.publicClient.simulateContract({
      account: club,
      address: local.grantRegistry,
      abi: grantRegistryAbi,
      functionName: "execute",
      args: [member.account, local.clubFeed, data],
    });
    return chain.publicClient.waitForTransactionReceipt({ hash: await clubClient.writeContract(request) });
  }
  type FromServer = { domain: never; types: never; primaryType: never; message: Record<string, string> };
  /** Has the passkey sign what the Passport hands the browser, the way the page's script does. */
  function signFromServer(passkey: ReturnType<typeof makePasskey>, typedData: FromServer) {
    const { expiry, nonce, deadline } = typedData.message;
    const message = { ...typedData.message, nonce: BigInt(nonce as string), deadline: BigInt(deadline as string), ...(expiry ? { expiry: BigInt(expiry) } : {}) };
    return { expiry, nonce, deadline, signature: passkey.sign(hashTypedData({ ...typedData, message } as never)) };
  }
  let consentUid: string;

  test("signing up takes an email code, and the Account that is created belongs to a contract, not to a key", async () => {
    const loginPage = await browser.get(signInUrl());
    const returnTo = /name="return" value="([^"]+)"/.exec(loginPage.body)?.[1] ?? "";
    await browser.postForm("/login/email", { email, return: returnTo });
    const consent = await browser.postForm("/login/code", { code: outbox.codes.get(email) as string, return: returnTo });
    assert.match(consent.body, /Add this device first/, "there is no device yet, so nothing can be allowed");
    consentUid = uidOf(consent.body);

    member = db.prepare("SELECT account, owner FROM users WHERE email = ?").get(email) as typeof member;
    assert.ok(isAddressEqual(await chain.ownerOf(member.account), member.owner));
    assert.ok(await chain.publicClient.getCode({ address: member.owner }), "the owner is a contract");
    assert.equal(await chain.publicClient.readContract({ address: member.owner, abi: ownerAbi, functionName: "keyCount" }), 0n);
    assert.equal(await chain.isRegistryManager(member.account), true);
  });

  test("with no device, neither the Passport nor a stranger's passkey can connect an app", async (t) => {
    // The registry's refusal below is the point of the test. The server logs it; keep that out of the output.
    t.mock.method(console, "error", () => {});
    // The page's own form, which is how the Passport signs for members whose key it holds.
    const byPassport = await browser.postJson(`/interaction/${consentUid}/allow`, {});
    assert.equal(byPassport.status, 400);

    const stranger = makePasskey(config.issuer);
    const typedData = await browser.getJson<FromServer>(`/interaction/${consentUid}/grant-request`);
    const refused = await browser.postJson(`/interaction/${consentUid}/allow`, signFromServer(stranger, typedData));
    assert.equal(refused.status, 500, "the registry rejects it: the owner contract does not know that passkey");
    const [, expiry] = await chain.publicClient.readContract({ address: local.grantRegistry, abi: grantRegistryAbi, functionName: "grantOf", args: [member.account, club.address] });
    assert.equal(expiry, 0n);
  });

  test("a device is added by the member's email, and by nothing else", async () => {
    const asked = await browser.postJson<{ keyId: Hex }>("/device/enrol", { credentialId: phone.credentialId, qx: phone.qx, qy: phone.qy });
    assert.equal(asked.status, 200);
    assert.equal(asked.body.keyId, phone.keyId);
    // Asking is not enough.
    assert.equal(await chain.isDeviceActive(member.owner, phone.keyId), false);

    // The member replies. (The link stands in for the reply; a real deployment proves the email itself.)
    const link = new URL(outbox.deviceLinks.get(email) as string);
    const replied = await new Browser(config.issuer).get(link.pathname + link.search);
    assert.match(replied.body, /Device added/);
    assert.equal(await chain.isDeviceActive(member.owner, phone.keyId), true);
    assert.deepEqual(await browser.getJson("/device/status?key=" + phone.keyId), { active: true });

    // A reply works once.
    assert.equal((await new Browser(config.issuer).get(link.pathname + link.search)).status, 404);
  });

  test("the device's passkey approves the club, and the club posts in its feed as the member", async () => {
    const consent = await browser.get(`/interaction/${consentUid}`);
    assert.match(consent.body, /Allow with passkey/);
    assert.match(consent.body, new RegExp(phone.credentialId), "the page tells the browser which passkey to ask for");

    const typedData = await browser.getJson<FromServer>(`/interaction/${consentUid}/grant-request`);
    const allowed = await browser.postJson<{ redirect: string }>(`/interaction/${consentUid}/allow`, signFromServer(phone, typedData));
    assert.equal(allowed.status, 200);
    const back = await browser.get(new URL(allowed.body.redirect).pathname);
    assert.ok(back.leftFor, "the member is sent back to the club");

    const [scopeId] = await chain.publicClient.readContract({ address: local.grantRegistry, abi: grantRegistryAbi, functionName: "grantOf", args: [member.account, club.address] });
    assert.equal(scopeId, hashScopes([{ target: local.clubFeed, selector: selectorOf("createPost") }]));
    assert.equal((await clubExecutes(post("lens://e2e/email-rooted"))).status, "success");
  });

  test("the passkey disconnects the club, and the Passport never held a key", async () => {
    assert.match((await browser.get("/account")).body, /Queens Book Club/);
    const revoke = await browser.getJson<FromServer>(`/account/revoke-request?grantee=${club.address}`);
    const removed = await browser.postJson("/account/revoke", { grantee: club.address, ...signFromServer(phone, revoke) });
    assert.equal(removed.status, 200);
    await assert.rejects(clubExecutes(post("lens://e2e/after-revoke")), /GrantNotActive/);

    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM keys").get() as { count: number }).count, 0);
  });
});
