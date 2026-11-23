import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { type GrantMessage, grantTypedData, hashScopes, randomNonce, revokeTypedData } from "@community-passport/grants";
import { build } from "esbuild";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Provider } from "oidc-provider";
import { type Address, type Hex, encodeFunctionData, getAddress, isAddress, isAddressEqual, isHex, verifyMessage } from "viem";
import {
  FRESH_LOGIN,
  type Mailer,
  SESSION_TTL,
  type Session,
  createSession,
  destroyOtherSessions,
  destroySession,
  finishEmailLogin,
  findSession,
  issueChallenge,
  normalizeEmail,
  parseCookies,
  randomId,
  spendChallenge,
  startEmailLogin,
} from "./auth.ts";
import { type Chain, lensAbi } from "./chain.ts";
import { type Club, acceptedFrom, clubScopes, readGrant } from "./clubs.ts";
import type { Config } from "./config.ts";
import { type User, now, userByEmail, userById, userByOwner, userByPendingOwner } from "./db.ts";
import type { KeyStore } from "./keystore.ts";
import { createProvider } from "./oidc.ts";
import { type MemberFacts, PolicyError } from "./policy.ts";
import * as views from "./views.ts";

export type Services = {
  config: Config;
  db: DatabaseSync;
  clubs: Map<string, Club>;
  chain: Chain;
  keyStore: KeyStore;
  mailer: Mailer;
};

/** How long a signature for a grant or a revocation stays submittable. */
const SIGNATURE_WINDOW = 10n * 60n;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A whole number from a request, or a 400. */
function toBigInt(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) throw new HttpError(400, "Malformed number.");
  return BigInt(value);
}

/** Only ever send a member back to one of the Passport's own pages. */
function safeReturn(value: unknown): string {
  return typeof value === "string" && /^\/(interaction\/[\w-]+|account(\/passkey)?)$/.test(value) ? value : "/account";
}

const toJson = (value: unknown) => JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));

export async function createApp(services: Services): Promise<{ app: express.Express; provider: Provider }> {
  const { config, db, clubs, chain, keyStore, mailer } = services;
  const provider = createProvider(config, db, clubs, chain);
  const secure = config.issuer.startsWith("https://");
  const { host, origin } = new URL(config.issuer);

  // The browser script for the passkey pages, bundled once at start.
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./client/passkey.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
  });
  const passkeyScript = bundle.outputFiles[0]?.text ?? "";

  const app = express();
  app.disable("x-powered-by");
  // The Passport's own forms and scripts are the only pages that may post to it. Cookies are SameSite=Lax, which
  // stops other sites; this also stops a sibling subdomain. (The sign-in protocol's own endpoints are not ours.)
  app.use((req, _res, next) => {
    const ours = /^\/(login|logout|interaction|account)(\/|$)/.test(req.path);
    if (req.method === "POST" && ours && req.headers.origin && req.headers.origin !== origin) {
      throw new HttpError(403, "That request did not come from this site.");
    }
    next();
  });
  const form = express.urlencoded({ extended: false });
  const json = express.json();

  function setCookie(res: Response, name: string, value: string, maxAge: number): void {
    res.append(
      "Set-Cookie",
      `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
    );
  }

  async function signedIn(req: Request): Promise<{ session: Session; user: User } | undefined> {
    const session = findSession(db, parseCookies(req.headers.cookie).pp_session);
    const user = session && userById(db, session.userId);
    return session && user ? { session, user: await settled(user, session.id) } : undefined;
  }

  function signIn(res: Response, user: User): void {
    setCookie(res, "pp_session", createSession(db, user.id).id, SESSION_TTL);
  }

  /** What the key store is told about this member with each request, see policy.ts. */
  async function memberFacts(user: User, session: Session): Promise<MemberFacts> {
    return {
      account: user.account,
      proxyAdmin: await chain.proxyAdminOf(user.account),
      freshLogin: now() - session.createdAt <= FRESH_LOGIN,
    };
  }

  // ---------------------------------------------------------------- Handing an Account to its member
  //
  // Two things change hands, each with one transaction from the key the Passport holds: the Account's proxy admin
  // (which could otherwise change the code the Account runs), then the Account. Either can fail or be cut short,
  // so the member's key is written down first (`pendingOwner`) and every step asks the chain what is already done.

  const ownedByPassport = async (user: User, target: Address) => isAddressEqual(await chain.ownerOf(target), user.owner);

  /** Records that a member holds their own key, forgets the Passport's, and ends their other sessions. */
  async function recordHandover(user: User, newOwner: Address, keepSession?: string): Promise<User> {
    db.prepare("UPDATE users SET owner = ?, custody = 'self', pending_owner = NULL WHERE id = ?").run(newOwner, user.id);
    await keyStore.destroy(user.id);
    // Sessions that an email code opened elsewhere end here: from now on only the new key signs in.
    destroyOtherSessions(db, user.id, keepSession);
    return { ...user, owner: newOwner, custody: "self", pendingOwner: null };
  }

  /**
   * If a handover reached the chain but was never recorded here (the server stopped in between), records it now.
   * The Account moves last, so once it belongs to the member's key the whole handover is done.
   */
  async function settled(user: User, keepSession?: string): Promise<User> {
    if (user.custody !== "passport" || !user.pendingOwner) return user;
    if (!isAddressEqual(await chain.ownerOf(user.account), user.pendingOwner)) return user;
    return recordHandover(user, user.pendingOwner, keepSession);
  }

  /** Where a member's handover stands: not begun, begun with nothing moved, or part of the Account moved. */
  async function handoverState(user: User, proxyAdmin: Address): Promise<"new" | "begun" | "moved"> {
    if (!user.pendingOwner) return "new";
    const untouched = (await ownedByPassport(user, proxyAdmin)) && (await ownedByPassport(user, user.account));
    return untouched ? "begun" : "moved";
  }

  async function handOver(user: User, newOwner: Address, session: Session): Promise<void> {
    const member = await memberFacts(user, session);
    // Once anything has moved to one key, no other key can finish the job.
    if (!isAddressEqual(user.pendingOwner ?? newOwner, newOwner) && (await handoverState(user, member.proxyAdmin)) === "moved") {
      throw new HttpError(409, "Finish with the passkey you already made for this account.");
    }
    db.prepare("UPDATE users SET pending_owner = ? WHERE id = ?").run(newOwner, user.id);

    const data = encodeFunctionData({ abi: lensAbi, functionName: "transferOwnership", args: [newOwner] });
    for (const target of [member.proxyAdmin, user.account]) {
      if (await ownedByPassport(user, target)) await keyStore.sendTransaction(user.id, { to: target, data }, member);
      if (!isAddressEqual(await chain.ownerOf(target), newOwner)) throw new Error(`${target} did not change owner`);
    }
    await recordHandover(user, newOwner, session.id);
  }

  function clubOf(clientId: unknown): Club {
    const club = typeof clientId === "string" ? clubs.get(clientId) : undefined;
    if (!club) throw new HttpError(400, "Unknown app.");
    return club;
  }

  /** A fresh grant for a member to sign: this club's functions, with the optional ones they accepted, for its number of days. */
  async function newGrant(user: User, club: Club, accepted: readonly string[]): Promise<GrantMessage> {
    const time = await chain.currentTime();
    return {
      account: user.account,
      grantee: club.grantee,
      scopes: clubScopes(club, accepted),
      expiry: time + BigInt(club.grantDays) * 86400n,
      nonce: randomNonce(),
      deadline: time + SIGNATURE_WINDOW,
    };
  }

  const challengeMessage = (challenge: string) => `Sign in to Community Passport at ${host}\nChallenge: ${challenge}`;

  /** Checks that whoever sent `address` holds its key: they signed the challenge this browser was just given. */
  async function provenAddress(req: Request, res: Response): Promise<Address> {
    const challenge = parseCookies(req.headers.cookie).pp_challenge;
    setCookie(res, "pp_challenge", "", 0);
    const { address, signature } = req.body ?? {};
    if (!challenge || !isAddress(address) || !isHex(signature)) throw new HttpError(400, "Missing proof.");
    // A challenge works once, so a signature that was seen before proves nothing.
    if (!spendChallenge(db, challenge)) throw new HttpError(401, "That took too long. Try again.");
    const proven = getAddress(address);
    if (!(await verifyMessage({ address: proven, message: challengeMessage(challenge), signature }))) {
      throw new HttpError(401, "That signature does not match.");
    }
    return proven;
  }

  app.get("/", (_req, res) => res.redirect(303, "/account"));

  app.get("/assets/passkey.js", (_req, res) => {
    res.type("application/javascript").send(passkeyScript);
  });

  // ---------------------------------------------------------------- Signing in

  app.get("/login", (req, res) => {
    res.send(views.loginPage(safeReturn(req.query.return)));
  });

  app.post("/login/email", form, async (req, res) => {
    const returnTo = safeReturn(req.body.return);
    const email = normalizeEmail(String(req.body.email ?? ""));
    if (!email) return void res.status(400).send(views.loginPage(returnTo, "That doesn't look like an email address."));
    setCookie(res, "pp_login", await startEmailLogin(db, mailer, email), 10 * 60);
    res.send(views.codePage(email, returnTo));
  });

  const creating = new Set<string>();

  app.post("/login/code", form, async (req, res) => {
    const returnTo = safeReturn(req.body.return);
    const pendingId = parseCookies(req.headers.cookie).pp_login ?? "";
    const email = finishEmailLogin(db, pendingId, String(req.body.code ?? ""));
    if (!email) {
      return void res.status(401).send(views.codePage("your address", returnTo, "That code is wrong or has expired."));
    }
    setCookie(res, "pp_login", "", 0);

    let user = userByEmail(db, email);
    if (!user) {
      // A first sign-in: a key in the key store, and a Lens Account that key owns, with the registry as manager.
      // One at a time per address, so that two codes used at once cannot make two Accounts.
      if (creating.has(email)) throw new HttpError(409, "Your account is being set up. Try again in a moment.");
      creating.add(email);
      const id = randomId();
      try {
        const owner = await keyStore.create(id);
        const account = await chain.createAccount(owner);
        db.prepare("INSERT INTO users (id, email, account, owner, custody, created_at) VALUES (?, ?, ?, ?, 'passport', ?)").run(
          id,
          email,
          account,
          owner,
          now(),
        );
        user = { id, email, account, owner, custody: "passport", pendingOwner: null };
      } catch (error) {
        await keyStore.destroy(id);
        throw error;
      } finally {
        creating.delete(email);
      }
    }
    user = await settled(user);
    // Once a member holds their own key, an inbox is not enough to sign in as them.
    if (user.custody === "self") return void res.send(views.passkeyRequiredPage(returnTo));
    signIn(res, user);
    res.redirect(303, returnTo);
  });

  app.get("/passkey/challenge", (_req, res) => {
    const challenge = issueChallenge(db);
    setCookie(res, "pp_challenge", challenge.id, challenge.maxAge);
    res.json({ message: challengeMessage(challenge.id) });
  });

  app.post("/login/passkey", json, async (req, res) => {
    const owner = await provenAddress(req, res);
    const found = userByOwner(db, owner) ?? userByPendingOwner(db, owner);
    const user = found && (await settled(found));
    // The chain has the last word on who owns the Account.
    if (!user || user.custody !== "self" || !isAddressEqual(await chain.ownerOf(user.account), owner)) {
      throw new HttpError(401, "No account is controlled by that passkey.");
    }
    signIn(res, user);
    res.json({ redirect: safeReturn(req.body.return) });
  });

  app.post("/logout", (req, res) => {
    const session = parseCookies(req.headers.cookie).pp_session;
    if (session) destroySession(db, session);
    setCookie(res, "pp_session", "", 0);
    res.redirect(303, "/login");
  });

  // ---------------------------------------------------------------- An app asks for sign-in

  app.get("/interaction/:uid", async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    const current = await signedIn(req);
    if (!current) return void res.redirect(303, `/login?return=/interaction/${details.uid}`);
    if (details.prompt.name === "login") {
      return void (await provider.interactionFinished(
        req,
        res,
        { login: { accountId: current.user.account } },
        { mergeWithLastSubmission: false },
      ));
    }
    const club = clubOf(details.params.client_id);
    // When a grant is being renewed, what the member accepted last time is ticked again.
    const status = readGrant(club, await chain.grantOf(current.user.account, club.grantee));
    res.send(views.consentPage(details.uid, club, current.user, status));
  });

  /** For a member who holds their own key: the grant for their passkey to sign. */
  app.get("/interaction/:uid/grant-request", async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    const current = await signedIn(req);
    if (!current) throw new HttpError(401, "Sign in first.");
    const club = clubOf(details.params.client_id);
    const grant = await newGrant(current.user, club, acceptedFrom(club, req.query.optional));
    res.type("json").send(toJson(grantTypedData(config.chainId, config.grantRegistry, grant)));
  });

  app.post("/interaction/:uid/allow", form, json, async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    const current = await signedIn(req);
    if (!current || details.session?.accountId !== current.user.account) throw new HttpError(401, "Sign in first.");
    const { user, session } = current;
    const club = clubOf(details.params.client_id);

    let grant = await newGrant(user, club, acceptedFrom(club, req.body.optional));
    let signature: Hex;
    if (user.custody === "passport") {
      const typedData = grantTypedData(config.chainId, config.grantRegistry, grant);
      signature = await keyStore.signTypedData(user.id, typedData, await memberFacts(user, session));
    } else {
      // The member's passkey signed in their browser. Only the three numbers it chose are taken from the request,
      // and never a longer grant than this club gets; the registry checks the signature against all of it.
      if (!isHex(req.body.signature)) throw new HttpError(400, "Missing signature.");
      const expiry = toBigInt(req.body.expiry);
      if (expiry > grant.expiry) throw new HttpError(400, "That grant lasts too long.");
      grant = { ...grant, expiry, nonce: toBigInt(req.body.nonce), deadline: toBigInt(req.body.deadline) };
      signature = req.body.signature;
    }
    try {
      await chain.submitGrant({ ...grant, signature });
    } catch (error) {
      // Anyone may submit a signed grant, so someone else may have got this one in first. What counts is that
      // the grant the member approved is there.
      const onchain = await chain.grantOf(user.account, club.grantee);
      if (!onchain.secondsLeft || onchain.scopeId !== hashScopes(grant.scopes) || onchain.expiry !== grant.expiry) throw error;
    }

    const oidcGrant = new provider.Grant({ accountId: user.account, clientId: club.clientId });
    oidcGrant.addOIDCScope("openid");
    const result = { consent: { grantId: await oidcGrant.save() } };
    if (user.custody === "passport") {
      return void (await provider.interactionFinished(req, res, result, { mergeWithLastSubmission: true }));
    }
    res.json({ redirect: await provider.interactionResult(req, res, result, { mergeWithLastSubmission: true }) });
  });

  app.post("/interaction/:uid/deny", form, async (req, res) => {
    await provider.interactionFinished(
      req,
      res,
      { error: "access_denied", error_description: "The member did not connect this app." },
      { mergeWithLastSubmission: false },
    );
  });

  // ---------------------------------------------------------------- A member's own page

  app.get("/account", async (req, res) => {
    const current = await signedIn(req);
    if (!current) return void res.redirect(303, "/login?return=/account");
    // The registry says which apps are connected. The Passport keeps no list of its own that could disagree.
    const connections: views.ConnectedApp[] = [];
    for (const club of clubs.values()) {
      const status = readGrant(club, await chain.grantOf(current.user.account, club.grantee));
      if (status.live) connections.push({ club, accepted: status.accepted, expiry: new Date(Number(status.expiry) * 1000) });
    }
    res.send(views.accountPage(current.user, connections));
  });

  async function newRevoke(user: User, club: Club) {
    const time = await chain.currentTime();
    return { account: user.account, grantee: club.grantee, nonce: randomNonce(), deadline: time + SIGNATURE_WINDOW };
  }

  /** For a member who holds their own key: the revocation for their passkey to sign. */
  app.get("/account/revoke-request", async (req, res) => {
    const current = await signedIn(req);
    if (!current) throw new HttpError(401, "Sign in first.");
    const revoke = await newRevoke(current.user, clubOf(req.query.client));
    res.type("json").send(toJson(revokeTypedData(config.chainId, config.grantRegistry, revoke)));
  });

  app.post("/account/revoke", form, json, async (req, res) => {
    const current = await signedIn(req);
    if (!current) throw new HttpError(401, "Sign in first.");
    const { user, session } = current;
    const club = clubOf(req.body.client);

    let revoke = await newRevoke(user, club);
    let signature: Hex;
    if (user.custody === "passport") {
      const typedData = revokeTypedData(config.chainId, config.grantRegistry, revoke);
      signature = await keyStore.signTypedData(user.id, typedData, await memberFacts(user, session));
    } else {
      if (!isHex(req.body.signature)) throw new HttpError(400, "Missing signature.");
      revoke = { ...revoke, nonce: toBigInt(req.body.nonce), deadline: toBigInt(req.body.deadline) };
      signature = req.body.signature;
    }
    try {
      await chain.submitRevoke({ ...revoke, signature });
    } catch (error) {
      // As with grants: if the grant is gone, the member has what they asked for.
      if ((await chain.grantOf(user.account, club.grantee)).secondsLeft) throw error;
    }
    if (user.custody === "passport") return void res.redirect(303, "/account");
    res.json({ redirect: "/account" });
  });

  // ---------------------------------------------------------------- Taking the key over

  app.get("/account/passkey", async (req, res) => {
    const current = await signedIn(req);
    if (!current) return void res.redirect(303, "/login?return=/account/passkey");
    if (current.user.custody === "self") return void res.redirect(303, "/account");
    // Moving an Account to a new owner takes a sign-in from moments ago, not an old session.
    if (now() - current.session.createdAt > FRESH_LOGIN) return void res.redirect(303, "/login?return=/account/passkey");
    const proxyAdmin = await chain.proxyAdminOf(current.user.account);
    res.send(views.passkeyPage(current.user, await handoverState(current.user, proxyAdmin)));
  });

  /** Hands a member's Account to the key their passkey derives. Afterwards the Passport holds nothing for them. */
  app.post("/account/handover", json, async (req, res) => {
    const current = await signedIn(req);
    if (!current) throw new HttpError(401, "Sign in first.");
    if (current.user.custody !== "passport") throw new HttpError(409, "This account already has its own key.");
    await handOver(current.user, await provenAddress(req, res), current.session);
    res.json({ redirect: "/account" });
  });

  // ---------------------------------------------------------------- Everything else is the sign-in protocol

  app.use(provider.callback());

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof HttpError ? error.status : error instanceof PolicyError ? 403 : 500;
    const message = status === 500 ? "Something went wrong on our side." : (error as Error).message;
    if (status === 500) console.error(error);
    if (req.is("json") || req.accepts(["html", "json"]) === "json") return void res.status(status).json({ error: message });
    res.status(status).send(views.messagePage("That didn't work", message));
  });

  return { app, provider };
}
