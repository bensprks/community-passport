import type { Address } from "viem";
import type { Post } from "./lens.ts";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// Deliberately unlike the Passport's pages, so that it is plain which site is on screen.
const STYLE = `
:root { --ink: #2b2118; --muted: #7a6a58; --line: #e3d6c3; --bg: #faf5ec; --panel: #fffdf8; --accent: #1f5f4a; --no: #a3332b; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.55 Georgia, "Times New Roman", serif; padding: 16px; }
header { max-width: 620px; margin: 24px auto 16px; display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
header strong { font-size: 26px; letter-spacing: -0.01em; } header span { color: var(--muted); font-size: 14px; font-family: system-ui, sans-serif; }
main { max-width: 620px; margin: 0 auto; display: grid; gap: 16px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 20px; display: grid; gap: 12px; }
h1, h2 { margin: 0; font-weight: 600; } h1 { font-size: 22px; } h2 { font-size: 17px; }
p { margin: 0; } .muted { color: var(--muted); font-size: 14px; font-family: system-ui, sans-serif; }
code { font-size: 13px; overflow-wrap: anywhere; }
form { margin: 0; display: grid; gap: 10px; }
textarea, button { font: inherit; border-radius: 4px; border: 1px solid var(--line); padding: 10px 12px; }
textarea { background: #fff; color: var(--ink); resize: vertical; min-height: 76px; width: 100%; }
button { cursor: pointer; background: var(--accent); color: #fff; border-color: var(--accent); font-family: system-ui, sans-serif; font-weight: 600; font-size: 15px; }
button.quiet { background: none; color: var(--ink); border-color: var(--line); font-weight: 500; }
.row { display: flex; gap: 10px; flex-wrap: wrap; } .row form { display: block; }
.note { border-left: 3px solid var(--accent); padding: 8px 12px; background: #f1f7f3; font-family: system-ui, sans-serif; font-size: 15px; }
.note.no { border-color: var(--no); background: #fbf0ee; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
li { border-top: 1px solid var(--line); padding-top: 10px; display: grid; gap: 2px; } li:first-child { border-top: 0; padding-top: 0; }
footer { max-width: 620px; margin: 16px auto 32px; }
`;

export type Notice = { kind: "ok" | "no"; text: string };

function page(title: string, body: string, clubName: string, clubKey: Address): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(clubName)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><strong>${escapeHtml(clubName)}</strong><span>a demo club app</span></header>
<main>
${body}
</main>
<footer class="muted">This app has its own key, <code>${clubKey}</code>, and pays the gas for what it does as you. It never sees your email, your Passport session or the key to your account.</footer>
</body>
</html>`;
}

/** Lens post ids and transaction hashes are long: the two ends are enough to tell them apart on a page. */
const short = (value: string) => (value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value);

const notice = (message?: Notice) =>
  message ? `<p class="note${message.kind === "no" ? " no" : ""}" role="status">${escapeHtml(message.text)}</p>` : "";

export function welcomePage(clubName: string, clubKey: Address, message?: Notice): string {
  return page(
    "Welcome",
    `<section>
<h1>This month: <em>Middlemarch</em></h1>
<p>Sign in to post your review. Reviews are posted to Lens under your own account.</p>
${notice(message)}
<form method="post" action="/login"><button>Sign in with Community Passport</button></form>
<p class="muted">You'll be sent to the Passport to sign in, and back here afterwards.</p>
</section>`,
    clubName,
    clubKey,
  );
}

export function memberPage(view: {
  clubName: string;
  clubKey: Address;
  account: Address;
  /** Until when this app is connected, or undefined if the member has disconnected it. */
  connectedUntil: Date | undefined;
  posts: readonly Post[];
  passportUrl: string;
  message?: Notice;
}): string {
  const connected = view.connectedUntil
    ? `<p class="muted">Connected through the Passport until ${view.connectedUntil.toISOString().slice(0, 10)}. <a href="${escapeHtml(view.passportUrl)}/account">Manage or disconnect it there.</a></p>`
    : `<p class="note no">You disconnected this app at the Passport, so it can no longer post as you.</p>
<form method="post" action="/login"><button>Connect again</button></form>`;
  const posts = view.posts.map(
    (post) => `<li><span>${escapeHtml(post.text)}</span>
<span class="muted">Read back from Lens: post <code>${short(String(post.id))}</code>, author <code>${post.author}</code>, transaction <code>${short(post.transaction)}</code></span></li>`,
  );
  return page(
    "Your reviews",
    `${notice(view.message)}
<section>
<h1>Signed in</h1>
<p class="muted">Your Lens Account, as the Passport told us: <code>${view.account}</code></p>
${connected}
</section>
<section>
<h2>Post a review</h2>
<form method="post" action="/post">
  <textarea name="text" maxlength="280" placeholder="What did you think of Middlemarch?" required></textarea>
  <div class="row"><button>Post to Lens as me</button></div>
</form>
<p class="muted">No prompt appears: this app posts with its own key, within what you allowed.</p>
</section>
<section>
<h2>What this app posted for you</h2>
<ul>${posts.join("\n") || '<li><span class="muted">Nothing yet.</span></li>'}</ul>
</section>
<section>
<h2>What this app can't do</h2>
<p class="muted">Press this and the app tries to make itself a full manager of your Account, which you never allowed.</p>
<div class="row">
  <form method="post" action="/overreach"><button class="quiet">Try to take over my account</button></form>
  <form method="post" action="/logout"><button class="quiet">Sign out of this app</button></form>
</div>
</section>`,
    view.clubName,
    view.clubKey,
  );
}
