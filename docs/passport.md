# Passport

The server in [`apps/passport`](../apps/passport): about 1,700 lines of TypeScript. It does three jobs.

1. It is a sign-in service for clubs' apps.
2. It holds each member's key until they take it over, and signs grants with it when the member says so.
3. It gives members a page to see and disconnect their apps.

## What a club builds

A club needs a server, a key, and a registration with the Passport's operator: its name, where members are sent back to, the address of its key, and the list of Lens functions it wants.

**Sign-in** is OpenID Connect, the protocol behind "Sign in with Google". Any standard client library works, and finds the addresses below by itself from `/.well-known/openid-configuration`. The club's server:

1. Sends the member's browser to the Passport's `/auth` address with its client id, a return address, and the usual random values (`state`, `nonce`, and a PKCE challenge).
2. Gets the member back at its return address with a one-time code.
3. Swaps the code at `/token`, server to server, for an **ID token**.
4. Checks the token's signature against the Passport's public key (`/jwks`), and that it was issued by the Passport, for this club, for this sign-in, and has not expired.
5. Reads the member's Lens Account address from the token's `sub` field and starts its own session.

In a native app, step 1 opens the system browser (the standard way to do web sign-in on iOS and Android) and step 2 returns to the app.

The token says which Account the member is and nothing else. A club that wants a name or a picture reads the Account's Lens profile.

**Acting for the member** needs no call to the Passport:

```ts
import { grantRegistryAbi } from "@community-passport/grants";

await clubWallet.writeContract({
  address: registry,
  abi: grantRegistryAbi,
  functionName: "execute",
  args: [memberAccount, feed, createPostCalldata],
});
```

The club can check `isAllowed(account, clubKey, target, selector)` first. If a call fails with `GrantNotActive`, the member disconnected or the grant ran out: send them through sign-in again.

The end-to-end test, [`e2e/flow.test.ts`](../e2e/flow.test.ts), plays the club's side of all of this in about 100 lines.

## Signing in to the Passport

**Email code.** Eight digits, good for ten minutes and five guesses. At most five codes an hour go to one address, and an address takes ten wrong guesses a day across all its codes. A code only works in the browser that asked for it, and is only ever typed on the Passport's own page. No app can submit a code for a member.

**Passkey**, for members who have taken their key over. The browser derives the key from the passkey, signs a one-time challenge from the server, and the server checks that the signing address owns the member's Account onchain.

The Passport's own session lasts 30 days. A club's sign-in request is answered without a screen only while that session is live and the club's grant is live. After signing out, the next club request shows the sign-in page again.

## The consent screen

It shows the club's domain, large. A club's name is whatever it claims to be, but its domain is where the member is actually sent back to. Under it, what the club is asking for in plain words, then what it can never do, then how long the grant lasts.

Whether a member needs to see this screen is decided by the registry, not by a record the Passport keeps. If the club's grant on the member's Account is live, and matches what the club asks for today, there is no screen. If the club's list of functions has changed, the grant no longer matches and the member is asked again.

An app marks what it asks for as required or optional. Optional things are boxes that start unticked, and the grant covers only what the member ticked. Anything that reaches what the member did in other apps, such as deleting posts on a shared feed or changing who they follow, belongs there.

## The member's account page

It lists every key the registry says can act for the member, read from the registry's own events, not from the Passport's list of apps. An app that changed its key, changed what it asks for, or is no longer registered still shows, by its address, and can be removed.

"Turn off app access" ends every grant and takes the registry off the member's Account, so nothing can act through it even if the registry's logic were replaced. Connecting an app turns it back on. A member who holds their own key ends every grant with one signature; taking the registry off takes a transaction from their wallet.

## How keys are held

Each member's Account is owned by one key. Until the member takes it over, the Passport's key store holds it and applies one rule to every request, whoever is asking ([`policy.ts`](../apps/passport/src/policy.ts)):

| Request | Answer |
| --- | --- |
| Sign a grant, for the grant registry, on this chain, for this member's own Account, to a registered app's key, for functions that app is registered for, for no longer than that app's grants last | Allow |
| Sign the end of one grant, or of all of them | Allow |
| Take the registry off this member's Account, or put it back with the right to pass calls on and no other | Allow |
| Send "transfer ownership" to this member's Account or to its proxy admin, when the member signed in within the last ten minutes | Allow |
| Anything else | Refuse |

So the key cannot sign a transaction that posts, moves tokens, adds any other manager or calls any other contract. It cannot sign a grant to a key that is not a registered app's, or for a function that app is not registered for. It cannot sign a message for any other site.

In production a key vendor holds the keys in a sealed server and enforces the rule there. [`keystore.ts`](../apps/passport/src/keystore.ts) is the interface a vendor adapter implements. The key store in this repository is for development: it runs inside the server, so whoever controls the server controls the keys. The vendor must be able to:

- Enforce the table above: pin signing to the registry and the chain, and check each grant's key, functions and length against the list of registered apps.
- **See the member's approval for itself.** The rule above cannot tell a member who tapped Allow from a server that says they did. The vendor has to check an approval that the Passport's server cannot produce by itself, for example a code the vendor sends to the member, bound to what is being approved: for a grant, the Account, the app's key, the functions, the expiry, the chain and the registry; for a handover, the exact new owner and both contracts that move. Proof that someone holds the new owner's key shows possession, not that the member chose it.
- Refuse a change to the rule from the Passport's server alone.

This is the acceptance test for a vendor. Until one passes it, a compromised Passport server can connect members to registered apps, or hand Accounts over, without them.

## Taking the key over

On the account page a member can choose "Secure it with a passkey".

The browser side is built on [Mera](https://github.com/category-labs/mera), Category Labs' library for accounts that come from a passkey. Mera creates the passkey and derives a key from a secret only that passkey can produce. It runs in the page, with nothing to install, and a passkey that syncs gives the same key on each of the member's devices. The Passport adds what goes around it: checking that the browser holds the key, moving the Account to it, and relaying what it signs.

1. The browser creates a passkey for the Passport's domain and derives a key from it. That key exists only in the page's memory, for as long as a signature takes.
2. The browser proves it holds the key by signing a one-time challenge.
3. The Passport transfers the Account's **proxy admin** to the new key, then the **Account** itself. A Lens Account has both: see [Changes to Lens](lens-changes.md).
4. The Passport deletes its copy of the old key and ends the member's sessions on other devices.

The member's new key is written down before anything moves, and each step asks the chain what is already done. So a handover that is cut short (a failed transaction, a server restart) is finished the next time, with the same passkey. Once anything has moved to one passkey's key, no other key can finish it.

After that:

- Connecting an app takes the member's fingerprint: the browser signs the grant and the Passport only relays it.
- The Passport cannot sign anything for this member.
- An email code alone does not sign them in.
- Their grants and their Account address are unchanged, so every club still sees the same member.
- If they lose the passkey, and it was not synced, the Account cannot be recovered.

## What production still needs

| Gap | Note |
| --- | --- |
| Key vendor adapter | Replaces the development key store. The choice of vendor is open: see [Decisions](decisions.md) |
| Real email | Any transactional email service |
| Limits per network address, and a cap on new Accounts per hour | Each new member costs the relayer about 0.14 MON, so sign-up needs protection from scripts |
| A real database | The demo uses a local file. Creating an Account and handing one over are already written so that two servers cannot do the same one at once |
| An indexer | The account page finds a member's grants in the registry's events. A node will not scan its whole history on request |
| A way to retire an app's key | Today only a member, or the key itself, can end that key's grants. Replacing a club's developer needs a way to end them all |
| Self-service for clubs | Today the operator edits a file. Someone has to review each club's list of functions and write its plain-language labels |
| Recovery after a handover | For example a recovery address set while the member still has the passkey |
| Sign-in with a wallet | For members who already hold a key. The server side is the same as for a passkey |
| Monitoring | The relayer's balance. Grants signed per hour, as an alarm on misuse |
| A security review | Of the server, and an audit of the registry |
