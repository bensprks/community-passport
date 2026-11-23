// Builds the page that makes a proof in a browser: the prover and its two workers bundled, with the circuit, an
// email's inputs and the Noir runtime's WebAssembly beside them.
//
//   node bench/build.mjs
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { circuitInputs } from "../scripts/email.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const require = createRequire(import.meta.url);
// A package's folder, found from its entry file.
const packageDir = (name, from = require) => from.resolve(name).split(`/node_modules/${name}/`)[0] + `/node_modules/${name}`;
const noirJs = createRequire(join(packageDir("@noir-lang/noir_js"), "package.json"));
const workers = join(packageDir("@aztec-foundation/bb.js"), "dest/browser/barretenberg_wasm");

mkdirSync(out, { recursive: true });
await build({
  entryPoints: {
    page: join(here, "page.js"),
    "main.worker": join(workers, "barretenberg_wasm_main/factory/browser/main.worker.js"),
    "thread.worker": join(workers, "barretenberg_wasm_thread/factory/browser/thread.worker.js"),
  },
  outdir: out,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "warning",
});

copyFileSync(join(packageDir("@noir-lang/acvm_js", noirJs), "web/acvm_js_bg.wasm"), join(out, "acvm_js_bg.wasm"));
copyFileSync(join(packageDir("@noir-lang/noirc_abi", noirJs), "web/noirc_abi_wasm_bg.wasm"), join(out, "noirc_abi_wasm_bg.wasm"));
copyFileSync(join(here, "../email_proof/target/email_proof.json"), join(out, "circuit.json"));
copyFileSync(join(here, "index.html"), join(out, "index.html"));

const email = readFileSync(
  join(here, "../../contracts/lib/email-tx-builder/packages/contracts/test/fixtures/case1_signHash/raw.eml"),
  "latin1",
);
const key = readFileSync(join(here, "../fixtures/gmail-20230601.pem"), "utf8");
writeFileSync(join(out, "inputs.json"), JSON.stringify(circuitInputs(email, key)));
console.log(`built ${out}`);
