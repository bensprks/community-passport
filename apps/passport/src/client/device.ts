// Runs in the browser, on the Passport's own pages, for members whose Account is rooted in their email. Each
// device has an ordinary passkey. The passkey never leaves the device, and what it signs is checked onchain by
// the member's owner contract. Nothing here needs the passkey to hand out a secret, so any passkey manager works.
import { type PasskeyAssertion, encodePasskeySignature, lowS } from "@community-passport/grants";
import { type Hex, bytesToHex, hashTypedData, hexToBytes, numberToHex } from "viem";

// Passkeys belong to this host and no other. It is why the Passport's domain can never change.
const rpId = location.hostname;

type Device = { keyId: Hex; credentialId: string };
/** The member's devices, as the page was given them: which passkeys to ask this browser for. */
const devices: Device[] = JSON.parse(document.getElementById("devices")?.textContent ?? "[]");

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Something went wrong.");
  return result;
}

/** A passkey signs in a wrapped format: two numbers, each with a length in front. This takes them out. */
function readSignature(der: Uint8Array): { r: Hex; s: Hex } {
  const numberAt = (offset: number) => {
    const length = der[offset + 1] as number;
    const value = BigInt(bytesToHex(der.slice(offset + 2, offset + 2 + length)));
    return { value, next: offset + 2 + length };
  };
  const r = numberAt(2);
  const s = numberAt(r.next);
  return { r: numberToHex(r.value, { size: 32 }), s: numberToHex(lowS(s.value), { size: 32 }) };
}

/** Has one of the member's passkeys on this device sign `hash`, and packs the answer for the owner contract. */
async function sign(hash: Hex): Promise<Hex> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      rpId,
      challenge: Uint8Array.from(hexToBytes(hash)),
      allowCredentials: devices.map((device) => ({ type: "public-key", id: fromBase64Url(device.credentialId) })),
      userVerification: "required",
    },
  })) as PublicKeyCredential | null;
  const device = devices.find((candidate) => candidate.credentialId === credential?.id);
  if (!credential || !device) throw new Error("This device has no passkey for this account. Add this device first.");
  const response = credential.response as AuthenticatorAssertionResponse;
  const assertion: PasskeyAssertion = {
    ...readSignature(new Uint8Array(response.signature)),
    authenticatorData: bytesToHex(new Uint8Array(response.authenticatorData)),
    clientDataJSON: new TextDecoder().decode(response.clientDataJSON),
  };
  return encodePasskeySignature(device.keyId, assertion);
}

/** The server sends numbers as strings, since JSON has no big integers. */
function reviveTypedData(typedData: { message: Record<string, unknown> }): never {
  for (const field of ["expiry", "nonce", "deadline"]) {
    if (typeof typedData.message[field] === "string") typedData.message[field] = BigInt(typedData.message[field]);
  }
  return typedData as never;
}

/** Fetches a message from the server and has the passkey sign it. */
async function signFrom(url: string) {
  const typedData = await (await fetch(url)).json();
  const signature = await sign(hashTypedData(reviveTypedData(typedData)));
  const { expiry, nonce, deadline } = typedData.message;
  return { expiry: String(expiry), nonce: String(nonce), deadline: String(deadline), signature };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const actions: Record<string, (button: HTMLElement) => Promise<string>> = {
  /** Make a passkey on this device, and ask the member's email to approve it. */
  async enrol(button) {
    const name = button.dataset.name ?? "Community Passport";
    const credential = (await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId, name: "Community Passport" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name, displayName: name },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        // ES256: the one kind of passkey the owner contract checks.
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      },
    })) as PublicKeyCredential | null;
    const publicKey = credential && (credential.response as AuthenticatorAttestationResponse).getPublicKey();
    if (!credential || !publicKey) throw new Error("This device could not make a passkey.");
    // The public key comes wrapped, and its last 64 bytes are the two numbers that matter.
    const point = new Uint8Array(publicKey).slice(-64);
    const { keyId } = await postJson<{ keyId: Hex }>("/device/enrol", {
      credentialId: toBase64Url(new Uint8Array(credential.rawId)),
      qx: bytesToHex(point.slice(0, 32)),
      qy: bytesToHex(point.slice(32)),
    });

    const status = document.querySelector<HTMLElement>("[data-device-status]");
    if (status) status.hidden = false;
    // Wait for the member's reply to arrive and be recorded.
    for (let tries = 0; tries < 300; tries++) {
      const { active } = await (await fetch(`/device/status?key=${keyId}`)).json();
      if (active) return button.dataset.return ?? "/account";
      await wait(2000);
    }
    throw new Error("We have not seen your reply yet. Reload this page once you have sent it.");
  },

  /** Approve an app: sign its grant with this device's passkey. */
  async grant(button) {
    const uid = button.dataset.uid;
    // The optional things the member ticked. The server builds the grant from these, and again when it is submitted.
    const optional = [...document.querySelectorAll<HTMLInputElement>('input[name="optional"]:checked')].map((box) => box.value);
    const query = new URLSearchParams(optional.map((label) => ["optional", label]));
    const signed = await signFrom(`/interaction/${uid}/grant-request?${query}`);
    return (await postJson<{ redirect: string }>(`/interaction/${uid}/allow`, { optional, ...signed })).redirect;
  },

  /** Disconnect an app. */
  async revoke(button) {
    const grantee = button.dataset.grantee;
    const signed = await signFrom(`/account/revoke-request?grantee=${encodeURIComponent(grantee ?? "")}`);
    return (await postJson<{ redirect: string }>("/account/revoke", { grantee, ...signed })).redirect;
  },

  /** Disconnect every app at once. */
  async revokeAll() {
    const signed = await signFrom("/account/revoke-all-request");
    return (await postJson<{ redirect: string }>("/account/disconnect-all", signed)).redirect;
  },
};

for (const button of document.querySelectorAll<HTMLElement>("[data-passkey]")) {
  button.addEventListener("click", async () => {
    const errorBox = document.querySelector<HTMLElement>("[data-passkey-error]");
    if (errorBox) errorBox.hidden = true;
    button.setAttribute("disabled", "");
    try {
      location.assign(await (actions[button.dataset.passkey ?? ""] as (typeof actions)[string])(button));
    } catch (error) {
      if (errorBox) {
        errorBox.textContent = error instanceof Error ? error.message : "Something went wrong.";
        errorBox.hidden = false;
      }
      button.removeAttribute("disabled");
    }
  });
}
