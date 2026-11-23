# Changes to Lens

Short version: **none are needed** for accounts the Passport creates. **One small change** lets existing accounts join without their owner paying gas. It is open as a draft.

## What the design uses from Lens as it is

| Lens feature | How it is used |
| --- | --- |
| Account managers | An Account adds the grant registry as a manager that may execute transactions, with no token permission |
| The account factory takes managers at creation | The Passport creates each new Account with the registry already in place, in one transaction |
| `executeTransaction` | The registry passes each allowed call to the Account through it, with no MON attached |
| Ownership transfer | Moving an Account to a member's own key |

The registry is a separate contract. It needs no permission from Lens, and nothing about it is special to Lens: to an Account it is one more manager, which the owner can remove.

## The one change: add or remove a manager by signature

**The gap.** Only an Account's owner can add a manager, in a transaction the owner sends and pays for. An owner with no MON cannot. Many owners of accounts carried over from Lens Chain will have none.

**The change.** Two functions on `Account` that do what `addAccountManager` and `removeAccountManager` do, for anyone to submit with the owner's signature. A relayer pays the gas.

**The draft:** [monad-developers/lens-monad-protocol#20](https://github.com/monad-developers/lens-monad-protocol/pull/20). 65 lines in `Account.sol`, 19 tests. The signature names the chain and the Account, works once, and has a deadline. Every existing check on managers and permissions applies unchanged. One mapping is appended to the Account's storage.

**With it,** an existing member's path into the Passport would be: connect their wallet on the Passport's page, sign one message that adds the registry, and from then on approve apps with signatures. They keep their key throughout. The Passport never holds it. (Signing in to the Passport with a wallet is not built in this version. With a passkey-derived key it is.)

**Without it,** the same path works today for any owner who has a little MON: one transaction from their wallet.

Nothing in this repository depends on the change.

## Worth knowing: an Account has two owners

Each Lens Account is a proxy. Besides the Account's owner there is a second contract, the Account's **proxy admin**, which can change the code the Account runs. It has its own owner: whoever owned the Account when it was created.

- Transferring the Account does **not** transfer its proxy admin.
- While Lens's upgrade lock is on, a proxy admin's owner can do nothing with it. If the lock is ever switched off, they could change the Account's code.

So a real handover is two transfers, and the Passport does both: the proxy admin first, then the Account ([`app.ts`](../apps/passport/src/app.ts), tested end to end). The same applies to any Lens Account that changes hands some other way.

This is not something the draft changes. A possible later improvement is to make the two move together.

## Not needed

- No change to feeds, graphs, groups, usernames or rules.
- No change to the account factory.
- No new permission for the registry anywhere in Lens.
- Nothing is added to accounts carried over from Lens Chain. An account has the registry only if its owner adds it.
