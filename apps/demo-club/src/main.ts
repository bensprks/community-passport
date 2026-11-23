// A pretend club's app, for showing the Passport from the outside. It does the two things any club's server
// does: signs a member in through the Passport (signin.ts), then acts on Lens as them with its own key (lens.ts).
// FOR DEMONSTRATION ONLY: sessions live in memory, and by default the key is one of the local node's test keys.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { type Address, type Hex, isHex, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { type Post, Refused, createLens } from "./lens.ts";
import { type Notice, memberPage, welcomePage } from "./pages.ts";
import { type PassportClient, type PendingSignIn, finishSignIn, startSignIn } from "./signin.ts";

const root = process.cwd();
const localFile = resolve(root, ".data/local.json");
const clubsFile = resolve(root, process.env.PASSPORT_CLUBS_FILE ?? "clubs.json");
if (!existsSync(localFile) || !existsSync(clubsFile)) {
  console.error("Run `pnpm chain` in another terminal, then `pnpm dev:setup`, before starting the demo club.");
  process.exit(1);
}
const local = JSON.parse(readFileSync(localFile, "utf8")) as { chainId: number; rpcUrl: string; grantRegistry: Address; feed: Address };

// The club's own registration with the Passport: here it is read from the operator's file, since both run on one
// machine. A real club is given its client id and secret by the operator.
const clientId = process.env.CLUB_CLIENT_ID ?? "queens-book-club";
const registration = (JSON.parse(readFileSync(clubsFile, "utf8")) as { clientId: string; name: string; clientSecret: string; redirectUris: string[] }[]).find(
  (club) => club.clientId === clientId,
);
if (!registration) throw new Error(`${clubsFile} has no club called ${clientId}`);
const passport: PassportClient = {
  issuer: process.env.PASSPORT_ISSUER ?? "http://localhost:4000",
  clientId,
  clientSecret: registration.clientSecret,
  redirectUri: registration.redirectUris[0] as string,
};
const { port, origin } = new URL(passport.redirectUri);

// One of the local node's funded test keys (the one `pnpm dev:setup` registers as this club's), from its public
// test phrase. Never use it anywhere real.
const testKey = () =>
  toHex(mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 9 }).getHdKey().privateKey as Uint8Array);
const clubKey = (process.env.CLUB_KEY ?? testKey()) as Hex;
if (!isHex(clubKey) || clubKey.length !== 66) throw new Error("CLUB_KEY is not a private key");
const lens = createLens({ ...local, clubKey });

type Session = { account: Address; notice?: Notice };
const sessions = new Map<string, Session>();
const pendingSignIns = new Map<string, PendingSignIn & { expires: number }>();
const postsByAccount = new Map<Address, Post[]>();

const newId = () => randomBytes(32).toString("base64url");
const cookie = (req: Request, name: string) =>
  (req.headers.cookie ?? "").split(";").map((part) => part.trim().split("=")).find(([key]) => key === name)?.[1];
const setCookie = (res: Response, name: string, value: string, maxAge: number) =>
  res.append("Set-Cookie", `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
const sessionOf = (req: Request) => sessions.get(cookie(req, "club_session") ?? "");

/** What to tell a member when the registry or Lens refuses something. */
function explain(reason: string): string {
  if (reason === "GrantNotActive") return "Refused by the grant registry: this app has no live grant on your account (GrantNotActive).";
  if (reason === "NotInScope") return "Refused by the grant registry: that is not one of the things you allowed (NotInScope).";
  if (reason === "RegistryPaused") return "The grant registry is paused.";
  return `Lens refused that (${reason}).`;
}

const app = express();
app.disable("x-powered-by");
const form = express.urlencoded({ extended: false });

app.get("/", async (req, res) => {
  const session = sessionOf(req);
  const error: Notice | undefined = typeof req.query.error === "string" ? { kind: "no", text: req.query.error } : undefined;
  if (!session) return void res.send(welcomePage(registration.name, lens.clubAddress, error));
  const message = session.notice ?? error;
  session.notice = undefined;
  res.send(
    memberPage({
      clubName: registration.name,
      clubKey: lens.clubAddress,
      account: session.account,
      connectedUntil: await lens.grantExpiry(session.account),
      posts: postsByAccount.get(session.account) ?? [],
      passportUrl: passport.issuer,
      message,
    }),
  );
});

// Signing in: send the member to the Passport, remembering what to check when they come back.
app.post("/login", async (_req, res) => {
  const { url, pending } = await startSignIn(passport);
  pendingSignIns.set(pending.state, { ...pending, expires: Date.now() + 10 * 60 * 1000 });
  setCookie(res, "club_login", pending.state, 10 * 60);
  res.redirect(303, url);
});

// The member is back from the Passport, with a one-time code or with a refusal.
app.get(new URL(passport.redirectUri).pathname, async (req, res) => {
  const state = String(req.query.state ?? "");
  const pending = pendingSignIns.get(state);
  pendingSignIns.delete(state);
  setCookie(res, "club_login", "", 0);
  // The sign-in must be one this browser started here, moments ago.
  if (!pending || pending.expires < Date.now() || cookie(req, "club_login") !== state) {
    return void res.redirect(303, `/?error=${encodeURIComponent("That sign-in was not started here. Try again.")}`);
  }
  if (typeof req.query.code !== "string") {
    return void res.redirect(303, `/?error=${encodeURIComponent("You chose not to connect this app at the Passport.")}`);
  }
  const account = await finishSignIn(passport, pending, req.query.code);
  const id = newId();
  sessions.set(id, { account });
  setCookie(res, "club_session", id, 24 * 60 * 60);
  res.redirect(303, "/");
});

app.post("/logout", (req, res) => {
  sessions.delete(cookie(req, "club_session") ?? "");
  setCookie(res, "club_session", "", 0);
  res.redirect(303, "/");
});

// Acting on Lens as the member. Nothing here talks to the Passport.
app.post("/post", form, async (req, res) => {
  const session = sessionOf(req);
  if (!session) return void res.redirect(303, "/");
  const text = String(req.body.text ?? "").trim().slice(0, 280);
  if (!text) return void res.redirect(303, "/");
  try {
    const post = await lens.post(session.account, text);
    postsByAccount.set(session.account, [post, ...(postsByAccount.get(session.account) ?? [])]);
    session.notice = { kind: "ok", text: "Posted to Lens as you. You were not asked for anything." };
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    session.notice = { kind: "no", text: explain(error.reason) };
  }
  res.redirect(303, "/");
});

app.post("/overreach", async (req, res) => {
  const session = sessionOf(req);
  if (!session) return void res.redirect(303, "/");
  try {
    await lens.tryToTakeOver(session.account);
    session.notice = { kind: "no", text: "That went through, which it never should. Something is wrong with the grant registry." };
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    session.notice = { kind: "ok", text: `This app tried to make itself a manager of your account. ${explain(error.reason)}` };
  }
  res.redirect(303, "/");
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.redirect(303, `/?error=${encodeURIComponent(error instanceof Error ? error.message : "Something went wrong.")}`);
});

app.listen(Number(port), () => {
  console.log(`Demo club "${registration.name}" on ${origin}, signing in through ${passport.issuer}, acting with key ${lens.clubAddress}`);
});
