// Everything a club's server does to sign a member in through the Passport. It is plain OpenID Connect
// (authorization code with PKCE), written out here so that each step can be read. A real club would use any
// standard OpenID Connect client library instead.
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { type Address, getAddress } from "viem";

export type PassportClient = {
  /** The Passport's address. */
  issuer: string;
  /** What the Passport's operator registered this club as. */
  clientId: string;
  clientSecret: string;
  /** Where the Passport sends members back to. */
  redirectUri: string;
};

/** What the club remembers between sending a member away and getting them back. */
export type PendingSignIn = { state: string; nonce: string; verifier: string };

type Endpoints = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string };

const random = () => randomBytes(32).toString("base64url");
const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

/** The Passport publishes where its endpoints are. */
async function endpoints(passport: PassportClient): Promise<Endpoints> {
  const response = await fetch(`${passport.issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error("the Passport is not answering");
  return (await response.json()) as Endpoints;
}

/** Step 1: where to send the member's browser, and what to remember until they come back. */
export async function startSignIn(passport: PassportClient): Promise<{ url: string; pending: PendingSignIn }> {
  const pending = { state: random(), nonce: random(), verifier: random() };
  const url = new URL((await endpoints(passport)).authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: passport.clientId,
    redirect_uri: passport.redirectUri,
    response_type: "code",
    scope: "openid",
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: sha256(pending.verifier),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), pending };
}

/**
 * Steps 2 to 5: the member is back with a one-time code. Swap it for an ID token, server to server, check the
 * token, and read the member's Lens Account from it.
 */
export async function finishSignIn(passport: PassportClient, pending: PendingSignIn, code: string): Promise<Address> {
  const { token_endpoint, jwks_uri } = await endpoints(passport);
  const response = await fetch(token_endpoint, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${passport.clientId}:${passport.clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: passport.redirectUri,
      code_verifier: pending.verifier,
    }),
  });
  const tokens = (await response.json()) as { id_token?: string; error_description?: string };
  if (!tokens.id_token) throw new Error(`the Passport gave no ID token: ${tokens.error_description ?? response.status}`);

  // The token is three parts: what kind of signature, the claims, and the signature.
  const [header = "", payload = "", signature = ""] = tokens.id_token.split(".");
  const { alg, kid } = JSON.parse(Buffer.from(header, "base64url").toString());
  if (alg !== "ES256") throw new Error("the ID token is signed in a way this club does not accept");
  const { keys } = (await (await fetch(jwks_uri)).json()) as { keys: { kid: string }[] };
  const jwk = keys.find((key) => key.kid === kid);
  if (!jwk) throw new Error("the ID token is signed with a key the Passport does not publish");
  const signed = verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key: createPublicKey({ key: jwk as never, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
  if (!signed) throw new Error("the ID token's signature is wrong");

  // Signed by the Passport, for this club, for this sign-in, and still fresh.
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (claims.iss !== passport.issuer) throw new Error("the ID token is from someone else");
  if (![claims.aud].flat().includes(passport.clientId)) throw new Error("the ID token is for another app");
  if (claims.nonce !== pending.nonce) throw new Error("the ID token is for another sign-in");
  if (!(claims.exp > Date.now() / 1000)) throw new Error("the ID token has expired");

  // The one thing it says about the member: which Lens Account is theirs.
  return getAddress(claims.sub);
}
