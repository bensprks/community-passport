// Runs in the browser, on the Passport's own pages only. It is the one place a passkey-derived key ever exists:
// in this page's memory, for as long as one signature takes.
import {
  MeraError,
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  deriveEvmPrivateKey,
  getPasskeyPrfOutput,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import type { LocalAccount } from "viem";

// Passkeys belong to this host and no other. It is why the Passport's domain can never change.
const rpId = location.hostname;

/** Derives the key from a passkey's PRF output, uses it once, and wipes it. */
async function withKey<T>(prfOutput: Uint8Array, use: (account: LocalAccount) => Promise<T>): Promise<T> {
  const privateKey = deriveEvmPrivateKey({ prfOutput, accountIndex: 0 });
  prfOutput.fill(0);
  const session = createSecp256k1SigningSession({ privateKey });
  privateKey.fill(0);
  try {
    return await use(toViemAccount(session));
  } finally {
    session.end();
  }
}

async function withExistingPasskey<T>(use: (account: LocalAccount) => Promise<T>): Promise<T> {
  const { prfOutput } = await getPasskeyPrfOutput({ rpId });
  return withKey(prfOutput, use);
}

async function postJson(url: string, body: unknown): Promise<{ redirect: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Something went wrong.");
  return result;
}

/** Proves this page holds the key for `account`, by signing a challenge the server just made. */
async function signChallenge(account: LocalAccount): Promise<{ address: string; signature: string }> {
  const { message } = await (await fetch("/passkey/challenge")).json();
  return { address: account.address, signature: await account.signMessage({ message }) };
}

/** The server sends numbers as strings, since JSON has no big integers. */
function reviveTypedData(typedData: { message: Record<string, unknown> }): never {
  for (const field of ["expiry", "nonce", "deadline"]) {
    if (typeof typedData.message[field] === "string") typedData.message[field] = BigInt(typedData.message[field]);
  }
  return typedData as never;
}

const actions: Record<string, (button: HTMLElement) => Promise<string>> = {
  /** Sign in as the account this passkey controls. */
  async login(button) {
    const proof = await withExistingPasskey(signChallenge);
    return (await postJson("/login/passkey", { ...proof, return: button.dataset.return })).redirect;
  },

  /** Make a passkey and move the account to the key it derives. */
  async create(button) {
    const name = button.dataset.name ?? "Community Passport";
    const { prfOutput } = await createPasskeyWithPrfOutput({
      rp: { id: rpId, name: "Community Passport" },
      user: { name, displayName: name },
    });
    const proof = await withKey(prfOutput, signChallenge);
    return (await postJson("/account/handover", proof)).redirect;
  },

  /** Finish a move that stopped half-way, with the passkey made the first time. */
  async resume() {
    const proof = await withExistingPasskey(signChallenge);
    return (await postJson("/account/handover", proof)).redirect;
  },

  /** Approve an app: sign its grant with the passkey-derived key. */
  async grant(button) {
    const uid = button.dataset.uid;
    // The optional things the member ticked. The server builds the grant from these, and again when it is submitted.
    const optional = [...document.querySelectorAll<HTMLInputElement>('input[name="optional"]:checked')].map((box) => box.value);
    const query = new URLSearchParams(optional.map((label) => ["optional", label]));
    const typedData = await (await fetch(`/interaction/${uid}/grant-request?${query}`)).json();
    const signature = await withExistingPasskey((account) => account.signTypedData(reviveTypedData(typedData)));
    const { expiry, nonce, deadline } = typedData.message;
    return (await postJson(`/interaction/${uid}/allow`, { optional, expiry: String(expiry), nonce: String(nonce), deadline: String(deadline), signature })).redirect;
  },

  /** Disconnect an app: sign the revocation with the passkey-derived key. */
  async revoke(button) {
    const client = button.dataset.client;
    const typedData = await (await fetch(`/account/revoke-request?client=${encodeURIComponent(client ?? "")}`)).json();
    const signature = await withExistingPasskey((account) => account.signTypedData(reviveTypedData(typedData)));
    const { nonce, deadline } = typedData.message;
    return (await postJson("/account/revoke", { client, nonce: String(nonce), deadline: String(deadline), signature })).redirect;
  },
};

function explain(error: unknown): string {
  if (error instanceof MeraError) {
    if (error.code === "PASSKEY_CANCELLED") return "The passkey prompt was dismissed.";
    if (error.code === "PRF_UNAVAILABLE") {
      return "This passkey manager can't be used here. Try iCloud Keychain, Google Password Manager or 1Password.";
    }
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

for (const button of document.querySelectorAll<HTMLElement>("[data-passkey]")) {
  button.addEventListener("click", async () => {
    const errorBox = document.querySelector<HTMLElement>("[data-passkey-error]");
    if (errorBox) errorBox.hidden = true;
    button.setAttribute("disabled", "");
    try {
      location.assign(await (actions[button.dataset.passkey ?? ""] as (typeof actions)[string])(button));
    } catch (error) {
      if (errorBox) {
        errorBox.textContent = explain(error);
        errorBox.hidden = false;
      }
      button.removeAttribute("disabled");
    }
  });
}
