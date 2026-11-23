// Writes .env and clubs.json for the local chain, so that `pnpm passport` runs out of the box.
// Run `pnpm chain` first. Uses two of anvil's funded accounts, from its public test phrase: never use them anywhere real.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { toFunctionSelector, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const root = new URL("..", import.meta.url);
const localFile = new URL(".data/local.json", root);
if (!existsSync(localFile)) {
  console.error("No local chain found. Run `pnpm chain` in another terminal first.");
  process.exit(1);
}
const local = JSON.parse(readFileSync(localFile, "utf8"));
const lensAbi = (name) =>
  JSON.parse(readFileSync(new URL(`contracts/lib/lens-monad-protocol/ABIs/${name}.abi.json`, root), "utf8"));
const selector = (abi, name) => toFunctionSelector(abi.find((item) => item.type === "function" && item.name === name));

const anvil = (index) =>
  mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: index });
const relayer = anvil(8);
const club = anvil(9);
const EDIT_AND_DELETE = "Edit and delete any of your posts, including ones made in other apps";
const UNFOLLOW = "Unfollow anyone you follow, including people you followed in other apps";
const feed = lensAbi("IFeed");
const graph = lensAbi("IGraph");

// An existing .env is kept: its secret is what unlocks the keys already in the Passport's database.
const envFile = new URL(".env", root);
if (!existsSync(envFile)) writeFileSync(
  envFile,
  `PASSPORT_ISSUER=http://localhost:4000
PASSPORT_PORT=4000
PASSPORT_RELAYER_KEY=${toHex(relayer.getHdKey().privateKey)}
PASSPORT_KEYSTORE_SECRET=${randomBytes(24).toString("hex")}
PASSPORT_CLUBS_FILE=clubs.json
`,
);
writeFileSync(
  new URL("clubs.json", root),
  `${JSON.stringify(
    [
      {
        clientId: "queens-book-club",
        name: "Queens Book Club",
        clientSecret: randomBytes(24).toString("hex"),
        redirectUris: ["http://localhost:5001/auth/callback"],
        grantee: club.address,
        grantDays: 90,
        permissions: [
          { label: "Post and reply as you", target: local.feed, selector: selector(feed, "createPost") },
          { label: "Follow people as you", target: local.graph, selector: selector(graph, "follow") },
          // On a shared feed or graph these reach what the member did in any app, so they are the member's to leave out.
          { label: EDIT_AND_DELETE, target: local.feed, selector: selector(feed, "editPost"), optional: true },
          { label: EDIT_AND_DELETE, target: local.feed, selector: selector(feed, "deletePost"), optional: true },
          { label: UNFOLLOW, target: local.graph, selector: selector(graph, "unfollow"), optional: true },
        ],
      },
    ],
    null,
    2,
  )}\n`,
);
console.log(`Wrote clubs.json (and .env, if there was none) for chain ${local.chainId}. Relayer ${relayer.address}, club key ${club.address}.`);
