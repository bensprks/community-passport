// Makes a proof of the real email in fixtures, checks it, and writes what the contracts and their tests need:
// the Solidity verifier, the proof and what it gives out.
//
//   node scripts/prove.mjs [native|wasm] [threads]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { BackendType, Barretenberg, UltraHonkBackend } from "@aztec-foundation/bb.js";
import { Noir } from "@noir-lang/noir_js";
import { circuitInputs } from "./email.mjs";

const here = (path) => new URL(path, import.meta.url);
const mode = process.argv[2] ?? "native";
const threads = Number(process.argv[3] ?? 0) || undefined;
// A contract checks this kind of proof, and it shows nothing of the email.
const target = { verifierTarget: "evm" };

const circuit = JSON.parse(readFileSync(here("../email_proof/target/email_proof.json"), "utf8"));
const email = readFileSync(here("../../contracts/lib/email-tx-builder/packages/contracts/test/fixtures/case1_signHash/raw.eml"), "latin1");
const inputs = circuitInputs(email, readFileSync(here("../fixtures/gmail-20230601.pem"), "utf8"));

const timed = async (label, work) => {
  const start = performance.now();
  const result = await work();
  console.log(`${label}: ${((performance.now() - start) / 1000).toFixed(2)} s`);
  return result;
};

const { witness } = await timed("witness", () => new Noir(circuit).execute(inputs));
const api = await Barretenberg.new({ threads, backend: mode === "wasm" ? BackendType.Wasm : undefined });
const backend = new UltraHonkBackend(circuit.bytecode, api);
const verificationKey = await timed("verification key", () => backend.getVerificationKey(target));
const proof = await timed(`proof (${mode}${threads ? `, ${threads} threads` : ""})`, () => backend.generateProof(witness, target));
console.log("verifies:", await backend.verifyProof(proof, target), "| proof bytes:", proof.proof.length, "| public inputs:", proof.publicInputs.length);

if (process.argv.includes("--write")) {
  const out = here("../../contracts/test/fixtures/noir/");
  mkdirSync(out, { recursive: true });
  const [keyHash, domain0, domain1, emailId, number, nullifier, timestamp] = proof.publicInputs;
  writeFileSync(
    new URL("NoirEmailFixture.sol", out),
    `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev Written by circuits/scripts/prove.mjs. A proof, made with the Noir circuit, of a real email sent from Gmail:
/// the first of the emails ZK Email publish with their tests. Its body says "signHash" and a number.
library NoirEmailFixture {
    bytes constant PROOF = hex"${Buffer.from(proof.proof).toString("hex")}";
    /// The hash of the key Gmail signed with.
    bytes32 constant KEY_HASH = ${keyHash};
    /// "gmail.com", as the circuit gives it out.
    bytes32 constant DOMAIN_0 = ${domain0};
    bytes32 constant DOMAIN_1 = ${domain1};
    /// The stand-in for the sender's address.
    bytes32 constant EMAIL_ID = ${emailId};
    /// The number the email approves, as the circuit gives it out.
    bytes32 constant NUMBER = ${number};
    bytes32 constant NULLIFIER = ${nullifier};
    uint256 constant TIMESTAMP = ${BigInt(timestamp)};
    /// The number as the email has it.
    bytes32 constant APPROVED = 0xda6c88e5c11236cd71d4733f45851c91257ba8d4c7f99145f72848e326126152;
}
`,
  );
  writeFileSync(here("../../contracts/src/email/noir/HonkVerifier.sol"), await backend.getSolidityVerifier(verificationKey, target));
  console.log("wrote the proof and the Solidity verifier");
}
await api.destroy();
