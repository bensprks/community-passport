// Runs the Passport and the demo club together, for showing the whole flow in a browser.
// Run `pnpm chain` in another terminal first and wait for READY.
//
// `pnpm demo` has the Passport hold each member's key. `pnpm demo:email` roots each Account in the member's email
// instead: the Passport holds no key, and the member's device signs with a passkey.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const root = fileURLToPath(new URL("..", import.meta.url));
const localFile = new URL("../.data/local.json", import.meta.url);
const chainAnswers = async () => {
  if (!existsSync(localFile)) return false;
  const { rpcUrl } = JSON.parse(readFileSync(localFile, "utf8"));
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  return fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body }).then(
    (response) => response.ok,
    () => false,
  );
};
if (!(await chainAnswers())) {
  console.error("The local chain is not running. Run `pnpm chain` in another terminal and wait for READY.");
  process.exit(1);
}

// Writes .env and clubs.json for the local chain, keeping an .env that is already there.
if (spawnSync(process.execPath, ["scripts/dev-setup.mjs"], { cwd: root, stdio: "inherit" }).status !== 0) process.exit(1);

// For accounts rooted in an email, the local node's eighth test account vouches that a member sent an email. It
// stands in for a real proof, and comes from the node's public test phrase: never use it anywhere real.
const emailMode = process.argv[2] === "email";
const attestor = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 7 });
const env = emailMode
  ? { ...process.env, PASSPORT_CUSTODY: "email", PASSPORT_EMAIL_ATTESTOR_KEY: toHex(attestor.getHdKey().privateKey) }
  : process.env;

const children = [
  ["passport", "apps/passport/src/main.ts"],
  ["club", "apps/demo-club/src/main.ts"],
].map(([name, script]) => {
  const child = spawn(process.execPath, ["--env-file-if-exists=.env", script], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const print = (chunk) => {
    for (const line of String(chunk).split("\n")) if (line.trim()) console.log(`[${name}] ${line}`);
  };
  child.stdout.on("data", print);
  child.stderr.on("data", print);
  child.on("exit", (code) => {
    console.log(`[${name}] stopped (${code ?? "signal"})`);
    stop();
  });
  return child;
});

function stop() {
  for (const child of children) child.kill();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(`
Open http://localhost:5001 (the club's app). Sign-in codes are printed here, on lines starting with [passport] [mail].
The Passport's own pages are at http://localhost:4000. Ctrl-C stops both.
`);
