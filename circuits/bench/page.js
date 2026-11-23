// Makes a proof of the email in this page and times each step. `?threads=4&auto=1` runs it on load.
import { Barretenberg, UltraHonkBackend } from "@aztec-foundation/bb.js";
import { Noir } from "@noir-lang/noir_js";

const target = { verifierTarget: "evm" };
const params = new URLSearchParams(location.search);
const threadsInput = document.querySelector("#threads");
const status = document.querySelector("#status");
const table = document.querySelector("#results");
threadsInput.value = params.get("threads") ?? navigator.hardwareConcurrency;

const rows = {};
const record = (label, value) => {
  rows[label] = value;
  table.insertRow().innerHTML = `<td>${label}</td><td>${value}</td>`;
};
const timed = async (label, work) => {
  status.textContent = `${label}…`;
  const start = performance.now();
  const result = await work();
  record(label, `${((performance.now() - start) / 1000).toFixed(2)} s`);
  return result;
};
// The prover fetches its common reference string from its publisher the first time, then keeps it in the browser.
// Count what comes from other hosts.
let downloaded = 0;
const plainFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (...args) => {
  const response = await plainFetch(...args);
  if (new URL(response.url).origin !== location.origin) {
    downloaded += (await response.clone().arrayBuffer()).byteLength;
  }
  return response;
};

async function run() {
  table.innerHTML = "";
  for (const key of Object.keys(rows)) delete rows[key];
  const threads = Number(threadsInput.value);
  record("threads asked for", threads);
  record("threads available", navigator.hardwareConcurrency);
  record("shared memory (needed for more than one thread)", String(crossOriginIsolated));

  const [circuit, inputs] = await timed("fetch the circuit", () =>
    Promise.all([fetch("./circuit.json").then((r) => r.json()), fetch("./inputs.json").then((r) => r.json())]),
  );
  const noir = new Noir(circuit);
  await timed("start the Noir runtime", () => noir.init());
  const { witness } = await timed("witness", () => noir.execute(inputs));
  downloaded = 0;
  const api = await timed("start the prover (with any download)", () => Barretenberg.new({ threads }));
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  const first = await timed("first proof", () => backend.generateProof(witness, target));
  record("downloaded", `${(downloaded / 1e6).toFixed(1)} MB`);
  const proof = await timed("second proof", () => backend.generateProof(witness, target));
  record("verifies", String(await backend.verifyProof(proof, target)));
  record("proof bytes", first.proof.length);
  await api.destroy();
  status.textContent = "Done";
  window.benchResult = rows;
}

document.querySelector("#run").addEventListener("click", () =>
  run().catch((error) => {
    status.textContent = `Failed: ${error.message ?? error}`;
    window.benchResult = { error: String(error.stack ?? error) };
  }),
);
if (params.has("auto")) document.querySelector("#run").click();
