# Email proof circuit

A [Noir](https://noir-lang.org) circuit that proves someone sent an email, without showing the email. [`NoirEmailVerifier`](../contracts/src/email/NoirEmailVerifier.sol) checks its proofs onchain. See [Accounts rooted in an email](../docs/email-accounts.md).

| Path | What it is |
| --- | --- |
| [`email_proof/`](email_proof/src/main.nr) | The circuit |
| [`lib/zkemail.nr`](lib) | ZK Email's Noir library, as a submodule |
| [`scripts/email.mjs`](scripts/email.mjs) | Turns a raw email and its provider's key into the circuit's inputs |
| [`scripts/prove.mjs`](scripts/prove.mjs) | Makes a proof of the email in `fixtures`, and writes the Solidity verifier and the proof the contract tests use |
| [`bench/`](bench) | A page that makes the same proof in a browser and times it |
| [`fixtures/`](fixtures) | The key Gmail signed with under the selector `20230601`. Gmail withdrew it from DNS in June 2026, so it is kept here. The email is one of the real ones ZK Email publish with their tests |

## Run it

Needs [nargo](https://noir-lang.org/docs/getting_started/quick_start) 1.0.0.

```bash
pnpm --filter @community-passport/circuits compile
```

```bash
pnpm --filter @community-passport/circuits prove
```

`prove` takes `native` or `wasm`, then a number of threads. `--write` rewrites the Solidity verifier and the test proof.

In a browser, at `http://localhost:4173`:

```bash
pnpm --filter @community-passport/circuits bench:browser
```

## What the proof shows

Given an email its provider signed (DKIM), that:

- the provider's key signed the header, and the header's hash of the body matches the body;
- the body carries `signHash <number> Code <code>` inside the block marked `zkemail`;
- the sender's address is at the domain given out.

It gives out seven numbers: the hash of the provider's key, the sender's domain (two numbers), a stand-in for the sender (a hash of the address and the code), the number the email approves, a value unique to the email, and when the provider signed it.

Limits: a signed header of up to 1,024 bytes, a 2,048-bit provider key, and the command within the last 1,024 bytes of the body. The body before that is hashed outside the proof, so its length does not matter.

## Dependencies

| What | Version | Licence |
| --- | --- | --- |
| nargo (Noir compiler) | 1.0.0 | MIT or Apache-2.0 |
| `@noir-lang/noir_js` | 1.0.0 | MIT or Apache-2.0 |
| `@aztec-foundation/bb.js` (the prover, Barretenberg) | 6.1.0 | MIT |
| ZK Email's Noir library | commit `1aebcb3` | MIT |
| `esbuild`, for the browser page only | 0.28.2 | MIT |

The generated verifier, [`HonkVerifier.sol`](../contracts/src/email/noir/HonkVerifier.sol), is Apache-2.0.

The library's last release (2.0.0) does not compile with Noir 1.0. The submodule is pinned to the top of the open changes that port it and fix soundness findings (zkemail/zkemail.nr pull requests 67 to 82). They are not merged.

The compiler flags three places in the library's body hashing (`partial_hash.nr`) where a value computed outside the proof is not tied down in a way it can follow. The code checks those values by hand afterwards, and has not been audited at this commit. Hashing the whole body inside the proof avoids that code and costs about six times the proving time for an 8,192-byte body.
