import type { Club } from "./clubs.ts";
import { clubDomain } from "./clubs.ts";
import type { User } from "./db.ts";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const STYLE = `
:root { color-scheme: light dark; --ink: #151a26; --muted: #5b6475; --line: #d4dae5; --bg: #f3f5f9; --panel: #fff; --ok: #12704a; --no: #b02e28; }
@media (prefers-color-scheme: dark) { :root { --ink: #e6eaf3; --muted: #9ba6bb; --line: #2a3243; --bg: #0e1117; --panel: #161b25; --ok: #63d0a0; --no: #ff8f86; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; padding: 16px; }
main { width: 100%; max-width: 420px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 24px; display: grid; gap: 14px; }
h1 { font-size: 22px; margin: 0; overflow-wrap: anywhere; }
p, ul { margin: 0; } .muted { color: var(--muted); font-size: 14px; }
ul { list-style: none; padding: 0; display: grid; gap: 8px; }
li { border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; display: flex; gap: 10px; justify-content: space-between; align-items: center; }
li.ok::before { content: "✓"; color: var(--ok); font-weight: 700; } li.no::before { content: "✕"; color: var(--no); font-weight: 700; }
li.ok, li.no { justify-content: flex-start; }
form { display: grid; gap: 10px; margin: 0; } .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
input, button { font: inherit; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
button { cursor: pointer; font-weight: 600; } button.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
button.link { border: 0; background: none; color: var(--no); padding: 0; }
.error { color: var(--no); } code { font-size: 13px; overflow-wrap: anywhere; }
`;

function page(title: string, body: string, script = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Community Passport</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
${script ? '<script src="/assets/passkey.js" defer></script>' : ""}
</body>
</html>`;
}

const error = (message?: string) => (message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : "");

export function loginPage(returnTo: string, message?: string): string {
  return page(
    "Sign in",
    `<h1>Sign in</h1>
<p class="muted">One account for every community app. We'll email you an 8-digit code.</p>
${error(message)}
<form method="post" action="/login/email">
  <input type="hidden" name="return" value="${escapeHtml(returnTo)}">
  <input type="email" name="email" placeholder="you@example.com" autocomplete="email" required autofocus>
  <button class="primary">Email me a code</button>
</form>
<button type="button" data-passkey="login" data-return="${escapeHtml(returnTo)}">Sign in with a passkey</button>
<p class="error" data-passkey-error hidden></p>`,
    true,
  );
}

export function codePage(email: string, returnTo: string, message?: string): string {
  return page(
    "Enter your code",
    `<h1>Enter your code</h1>
<p class="muted">We sent an 8-digit code to ${escapeHtml(email)}. Only ever type it on this site.</p>
${error(message)}
<form method="post" action="/login/code">
  <input type="hidden" name="return" value="${escapeHtml(returnTo)}">
  <input name="code" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" autocomplete="one-time-code" required autofocus>
  <button class="primary">Sign in</button>
</form>`,
  );
}

/** Shown when an email code is right but the account's owner is the member's own passkey. */
export function passkeyRequiredPage(returnTo: string): string {
  return page(
    "Use your passkey",
    `<h1>Use your passkey</h1>
<p class="muted">You secured this account with a passkey, so an email code alone can't sign in to it.</p>
<button type="button" class="primary" data-passkey="login" data-return="${escapeHtml(returnTo)}">Sign in with your passkey</button>
<p class="error" data-passkey-error hidden></p>`,
    true,
  );
}

export function consentPage(uid: string, club: Club, user: User, renewing: boolean): string {
  const selfCustody = user.custody === "self";
  const allow = selfCustody
    ? `<button type="button" class="primary" data-passkey="grant" data-uid="${escapeHtml(uid)}">Allow with passkey</button>`
    : `<form method="post" action="/interaction/${escapeHtml(uid)}/allow"><button class="primary">Allow</button></form>`;
  return page(
    `Connect ${club.name}`,
    `<p class="muted">${escapeHtml(club.name)} ${renewing ? "wants to stay connected" : "wants to connect"}</p>
<h1>${escapeHtml(clubDomain(club))}</h1>
<p>It will be able to:</p>
<ul>
  <li class="ok">See which account is yours</li>
  ${[...new Set(club.permissions.map((permission) => permission.label))].map((label) => `<li class="ok">${escapeHtml(label)}</li>`).join("\n  ")}
  <li class="no">Move money</li>
  <li class="no">Take or change your account</li>
</ul>
<p class="muted">For ${club.grantDays} days, renewed when you sign in. You can disconnect it at any time.</p>
<div class="row">
  <form method="post" action="/interaction/${escapeHtml(uid)}/deny"><button>Cancel</button></form>
  ${allow}
</div>
<p class="error" data-passkey-error hidden></p>`,
    selfCustody,
  );
}

export type Connection = { club: Club; expiry: Date };

export function accountPage(user: User, connections: Connection[], message?: string): string {
  const selfCustody = user.custody === "self";
  const rows = connections.map(({ club, expiry }) => {
    const remove = selfCustody
      ? `<button type="button" class="link" data-passkey="revoke" data-client="${escapeHtml(club.clientId)}">Remove</button>`
      : `<form method="post" action="/account/revoke"><input type="hidden" name="client" value="${escapeHtml(club.clientId)}"><button class="link">Remove</button></form>`;
    return `<li><span>${escapeHtml(club.name)}<br><span class="muted">${escapeHtml(clubDomain(club))} · until ${expiry.toISOString().slice(0, 10)}</span></span>${remove}</li>`;
  });
  return page(
    "Your account",
    `<h1>Your account</h1>
<p class="muted">${escapeHtml(user.email)}<br><code>${escapeHtml(user.account)}</code></p>
${error(message)}
<p>Connected apps</p>
<ul>${rows.join("\n") || '<li><span class="muted">None yet.</span></li>'}</ul>
<p class="error" data-passkey-error hidden></p>
${
  selfCustody
    ? '<p class="muted">Your passkey controls this account. We can\'t act for you or recover it.</p>'
    : '<p class="muted">We hold the key to this account for you.</p><form method="get" action="/account/passkey"><button>Secure it with a passkey</button></form>'
}
<form method="post" action="/logout"><button>Sign out</button></form>`,
    selfCustody,
  );
}

/**
 * `handover` says where a move to the member's own key stands: not begun, begun with nothing moved yet (they
 * may still start over), or part of the Account already moved (only the passkey they made can finish it).
 */
export function passkeyPage(user: User, handover: "new" | "begun" | "moved"): string {
  if (handover !== "new") {
    return page(
      "Finish securing your account",
      `<h1>Finish securing your account</h1>
<p>You made a passkey for this account, but the move to it did not finish.</p>
<button type="button" class="primary" data-passkey="resume">Finish with that passkey</button>
${handover === "begun" ? `<button type="button" data-passkey="create" data-name="${escapeHtml(user.email)}">Make a new passkey instead</button>` : ""}
<p class="error" data-passkey-error hidden></p>`,
      true,
    );
  }
  return page(
    "Secure with a passkey",
    `<h1>Secure your account with a passkey</h1>
<p>Your account moves to a key only your passkey can make. After that:</p>
<ul>
  <li class="ok">Connecting an app takes your fingerprint</li>
  <li class="ok">We can no longer act for you</li>
  <li class="no">We can't recover it if you lose the passkey</li>
</ul>
<p class="muted">Use a passkey that syncs (iCloud Keychain, Google Password Manager, 1Password). This can't be undone by us.</p>
<button type="button" class="primary" data-passkey="create" data-name="${escapeHtml(user.email)}">Create a passkey and move my account</button>
<p class="error" data-passkey-error hidden></p>
<form method="get" action="/account"><button>Not now</button></form>`,
    true,
  );
}

export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><form method="get" action="/account"><button>Your account</button></form>`);
}
