import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type Adapter, type AdapterPayload, type Configuration, Provider, interactionPolicy } from "oidc-provider";
import type { Address } from "viem";
import { SESSION_TTL, findSession, parseCookies, randomId } from "./auth.ts";
import type { Chain } from "./chain.ts";
import { type Club, clubScopes } from "./clubs.ts";
import type { Config } from "./config.ts";
import { now, setting, userById } from "./db.ts";

/** Keeps oidc-provider's records (sessions, interactions, authorization codes) in the Passport's database. */
function sqliteAdapter(db: DatabaseSync) {
  return class SqliteAdapter implements Adapter {
    readonly model: string;

    constructor(model: string) {
      this.model = model;
    }

    async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
      db.prepare(
        `INSERT INTO oidc (model, id, payload, expires_at, grant_id, user_code, uid) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (model, id) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at,
           grant_id = excluded.grant_id, user_code = excluded.user_code, uid = excluded.uid`,
      ).run(
        this.model,
        id,
        JSON.stringify(payload),
        expiresIn ? now() + expiresIn : null,
        payload.grantId ?? null,
        payload.userCode ?? null,
        payload.uid ?? null,
      );
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      return this.#one("id", id);
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      return this.#one("uid", uid);
    }

    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
      return this.#one("user_code", userCode);
    }

    async consume(id: string): Promise<void> {
      const payload = await this.find(id);
      if (!payload) return;
      db.prepare("UPDATE oidc SET payload = ? WHERE model = ? AND id = ?").run(
        JSON.stringify({ ...payload, consumed: now() }),
        this.model,
        id,
      );
    }

    async destroy(id: string): Promise<void> {
      db.prepare("DELETE FROM oidc WHERE model = ? AND id = ?").run(this.model, id);
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      db.prepare("DELETE FROM oidc WHERE model = ? AND grant_id = ?").run(this.model, grantId);
    }

    #one(column: "id" | "uid" | "user_code", value: string): AdapterPayload | undefined {
      const row = db
        .prepare(`SELECT payload FROM oidc WHERE model = ? AND ${column} = ? AND (expires_at IS NULL OR expires_at > ?)`)
        .get(this.model, value, now()) as { payload: string } | undefined;
      return row && JSON.parse(row.payload);
    }
  };
}

/** The key that signs ID tokens. Made on first start and kept, so that apps can keep checking tokens against it. */
function newSigningKey(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: randomBytes(8).toString("hex"), alg: "ES256", use: "sig" });
}

/**
 * The sign-in protocol: OpenID Connect by redirect, authorization code with PKCE. An app gets one thing from it,
 * an ID token whose `sub` is the member's Lens Account.
 */
export function createProvider(config: Config, db: DatabaseSync, clubs: Map<string, Club>, chain: Chain): Provider {
  // oidc-provider keeps a session of its own. The Passport's session is the one that counts: when it has ended,
  // or belongs to someone else, the member signs in again whatever oidc-provider remembers.
  const policy = interactionPolicy.base();
  policy.get("login")?.checks.add(
    new interactionPolicy.Check("passport_session", "the member is not signed in to the Passport", (ctx) => {
      const session = findSession(db, parseCookies(ctx.req.headers.cookie).pp_session);
      const user = session && userById(db, session.userId);
      return !user || user.account !== ctx.oidc.session?.accountId;
    }),
  );

  const configuration: Configuration = {
    adapter: sqliteAdapter(db),
    clients: [...clubs.values()].map((club) => ({
      client_id: club.clientId,
      client_secret: club.clientSecret,
      redirect_uris: club.redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
      id_token_signed_response_alg: "ES256",
    })),
    jwks: { keys: [JSON.parse(setting(db, "oidc_signing_key", newSigningKey))] },
    cookies: { keys: [setting(db, "oidc_cookie_key", randomId)] },
    pkce: { required: () => true },
    scopes: ["openid"],
    claims: { openid: ["sub"] },
    features: { devInteractions: { enabled: false } },
    ttl: { Interaction: 10 * 60, Session: SESSION_TTL, Grant: SESSION_TTL, AuthorizationCode: 60, IdToken: 5 * 60, AccessToken: 5 * 60 },
    interactions: { policy, url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    // A member's id is their Lens Account's address, which is all an ID token says about them.
    findAccount: async (_ctx, id) => ({ accountId: id, claims: async () => ({ sub: id }) }),
    /**
     * Whether a member has to see the consent screen. The registry decides, not a record the Passport keeps: an
     * app is connected while its grant on the member's Account is live. A grant with less than half its time
     * left is treated as missing, which is how grants get renewed.
     */
    loadExistingGrant: async (ctx) => {
      const justGranted = ctx.oidc.result?.consent?.grantId;
      if (justGranted) return ctx.oidc.provider.Grant.find(justGranted);
      const accountId = ctx.oidc.session?.accountId;
      const club = ctx.oidc.client && clubs.get(ctx.oidc.client.clientId);
      if (!accountId || !club) return undefined;
      const status = await chain.grantStatus(accountId as Address, club.grantee, clubScopes(club));
      if (!status.live || status.secondsLeft < (club.grantDays * 86400) / 2) return undefined;
      const grant = new ctx.oidc.provider.Grant({ accountId, clientId: club.clientId });
      grant.addOIDCScope("openid");
      await grant.save();
      return grant;
    },
  };
  const provider = new Provider(config.issuer, configuration);
  // Behind a TLS-terminating proxy, trust its forwarded headers.
  if (config.issuer.startsWith("https://")) provider.proxy = true;
  return provider;
}
