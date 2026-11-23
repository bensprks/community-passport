// Turns a raw email into what the circuit takes: the signed part of the header, the end of the body, the mail
// provider's key and signature, and where things are. It first checks the provider's signature the ordinary way,
// so a wrong reading of the email fails here and not inside a proof.
import { createHash, createPublicKey, createVerify } from "node:crypto";

export const MAX_HEADER_LENGTH = 1024;
export const MAX_BODY_LENGTH = 1024;
const CRLF = "\r\n";

/** The email as the provider signed it ("relaxed" form): field names in lower case, runs of spaces as one. */
function relaxedHeader(name, value) {
  return `${name.toLowerCase()}:${value.replace(/\r\n/g, "").replace(/[ \t]+/g, " ").trim()}`;
}

function relaxedBody(body) {
  const lines = body.split(CRLF).map((line) => line.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length ? lines.join(CRLF) + CRLF : "";
}

/** SHA-256 over whole 64-byte blocks, stopping there: the state to carry on from. */
function sha256State(bytes) {
  const K = [];
  for (let n = 2; K.length < 64; n++) {
    if ([...Array(n).keys()].slice(2).every((d) => n % d)) K.push(Math.floor((Math.cbrt(n) % 1) * 2 ** 32));
  }
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = [];
    for (let i = 0; i < 16; i++) w.push(bytes.readUInt32BE(offset + 4 * i));
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w.push((w[i - 16] + s0 + w[i - 7] + s1) >>> 0);
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => (H[i] = (H[i] + value) >>> 0));
  }
  return H;
}

/** A big number as 18 numbers of 120 bits each, smallest first: how the circuit takes keys and signatures. */
function limbs(value) {
  return Array.from({ length: 18 }, (_, i) => ((value >> (120n * BigInt(i))) & ((1n << 120n) - 1n)).toString());
}

const padded = (bytes, length) => [...bytes, ...Array(length - bytes.length).fill(0)];

/**
 * @param raw the email as it arrived, headers and all
 * @param keyPem the provider's key for the selector in the email's signature
 */
export function circuitInputs(raw, keyPem) {
  const split = raw.indexOf(CRLF + CRLF);
  const fields = [...raw.slice(0, split).matchAll(/^([^\s:]+):((?:.*(?:\r\n[ \t].*)*))/gm)].map(([, name, value]) => ({ name, value }));
  const dkim = fields.find((field) => field.name.toLowerCase() === "dkim-signature");
  const tag = (name) => new RegExp(`(?:^|;)\\s*${name}=([^;]*)`).exec(dkim.value.replace(/\r\n/g, ""))?.[1].replace(/\s+/g, "") ?? "";
  if (tag("c") !== "relaxed/relaxed" || tag("a") !== "rsa-sha256") throw new Error("only relaxed, RSA-signed mail is read here");

  // The fields the provider signed, each taken from the bottom up, then its own signature field without the signature.
  const remaining = [...fields];
  const signed = tag("h").split(":").flatMap((name) => {
    const index = remaining.findLastIndex((field) => field.name.toLowerCase() === name.toLowerCase());
    return index < 0 ? [] : remaining.splice(index, 1).map((field) => relaxedHeader(field.name, field.value));
  });
  const header = Buffer.from([...signed, relaxedHeader(dkim.name, dkim.value.replace(/b=[^;]*$/s, "b="))].join(CRLF));
  const body = Buffer.from(relaxedBody(raw.slice(split + 4)));
  const signature = Buffer.from(tag("b"), "base64");

  if (createHash("sha256").update(body).digest("base64") !== tag("bh")) throw new Error("the body does not match the header");
  if (!createVerify("sha256").update(header).verify(keyPem, signature)) throw new Error("the provider's signature does not verify");

  const text = header.toString("latin1");
  const sequence = (name) => {
    const index = text.indexOf(`${name}:`) === 0 ? 0 : text.indexOf(`${CRLF}${name}:`) + 2;
    const end = text.indexOf(CRLF, index);
    return { index, length: (end < 0 ? text.length : end) - index };
  };
  const from = sequence("from");
  const fromField = text.slice(from.index, from.index + from.length);
  const address = /<([^>]+)>\s*$/.exec(fromField)?.[1] ?? fromField.slice(5).trim();
  const dkimSequence = sequence("dkim-signature");

  // The end of the body goes into the proof, from the last 64-byte boundary before the command. What comes before
  // is hashed here, which is why a long email costs no more to prove than a short one.
  const marker = body.indexOf('zkemail">signHash ');
  if (marker < 0) throw new Error("the email carries no command");
  const cut = Math.floor(marker / 64) * 64;
  const tail = body.subarray(cut);
  if (tail.length > MAX_BODY_LENGTH) throw new Error("the command is too far from the end of the email");
  const decoded = Buffer.from(tail.toString("latin1").replace(/=\r\n/g, ""), "latin1");
  const commandIndex = decoded.indexOf("signHash ");
  const digits = /^signHash (\d+) Code /.exec(decoded.subarray(commandIndex).toString("latin1"))[1].length;

  const modulus = BigInt(`0x${Buffer.from(createPublicKey(keyPem).export({ format: "jwk" }).n, "base64url").toString("hex")}`);
  return {
    header: { storage: padded(header, MAX_HEADER_LENGTH), len: header.length },
    body: { storage: padded(tail, MAX_BODY_LENGTH), len: tail.length },
    decoded_body: padded(decoded, MAX_BODY_LENGTH),
    pubkey: { modulus: limbs(modulus), redc: limbs((1n << (2n * 2048n + 6n)) / modulus) },
    signature: limbs(BigInt(`0x${signature.toString("hex")}`)),
    dkim_header_sequence: dkimSequence,
    body_hash_index: text.indexOf("bh=", dkimSequence.index) + 3,
    timestamp_index: text.indexOf("; t=", dkimSequence.index) + 4,
    partial_body_hash: sha256State(body.subarray(0, cut)),
    partial_body_real_length: body.length,
    from_header_sequence: from,
    from_address_sequence: { index: text.indexOf(address, from.index), length: address.length },
    at_index: address.indexOf("@"),
    command_index: commandIndex,
    digits,
  };
}
