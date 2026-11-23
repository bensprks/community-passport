# Decisions

## Alternatives considered

| Option | What it is | Why not, for this |
| --- | --- | --- |
| **One wallet vendor's shared wallet** (for example Privy's global wallets) | The vendor holds one wallet per member and lets many apps use it | It does solve "one wallet across apps". But every action from a club's app needs a confirmation window on the wallet provider's domain, so there is no silent posting. Being the provider is an enterprise feature, priced per monthly user |
| **One Lens manager key per club, no registry** | Each Account adds each club's key as a manager | A manager can call anything, for ever. One leaked club key acts as every member of that club. This is the shape of what went wrong at Cardex on Abstract in February 2025: one session key shared by all users leaked, and about $400,000 was taken from about 9,000 wallets |
| **Passkeys only, no custody** | Every member's key comes from a passkey from day one. This is what [Mera](https://github.com/category-labs/mera) provides: an account from a passkey, with no custodian and nothing to install | A passkey belongs to one domain. Clubs on their own domains cannot use it (browsers allow about five related domains). So it still needs a central sign-in page, and it gives up email-only sign-up and any recovery. Mera is therefore the way out of custody in this design, not the way in |
| **Smart-account session keys** (ERC-7715, Smart Sessions, Kernel permissions) | Mature systems with the same shape: approve once, a contract checks each call | They live inside a particular kind of smart account. A Lens Account is not one, and cannot load them. The registry is the same idea, attached the one way a Lens Account allows |
| **Scoped managers inside the Lens Account** | Change `Account` itself to support functions and expiry per manager | A larger change to audited code that every account runs. The registry gets the same result and touches nothing |
| **Sign in with a wallet at each club** | Each club asks for a wallet signature | Most members will not have a wallet. And one signature phished at one club would be good at all of them |

## What this design costs

- Someone has to run a service that people's sign-in depends on, and hold keys through a vendor until members take them. See "Limits" in [Design](design.md).
- One new contract to audit and to govern.
- Clubs need a server with a funded key. A club with only a static site cannot act for members.

## Open questions

**Control**

1. **Who holds the registry's admin and guardian roles?** A multisig for the admin, with named signers. The guardian can be a faster, smaller group, since it can only pause. Is 7 days the right delay?
2. **Who registers clubs?** Someone has to check each club's list of functions and write the plain-language labels members see. The simplest start is one standard list for a normal club (post, edit, delete, follow, unfollow), with anything else reviewed by hand.
3. **Which contracts may grants name?** The global feed and graph, plus each club's own feed and group as they are created. Never a token.

**Keys**

4. **Which key vendor?** It must hold keys in a sealed server, pin signing to the registry and a list of contracts, and check the member's sign-in itself before a handover. Not yet tested against any vendor.
5. **Is recovery after a handover needed from the start?** Today a lost passkey, with no synced copy, is a lost Account. A recovery address would fix it and adds a little contract work on the Lens side.

**Product**

6. **The Passport's domain.** Every passkey is tied to it for good.
7. **How long should a grant last?** 90 days here, renewed at sign-in once half is gone. A year is the registry's limit.
8. **Does a club need more than the Account's address at sign-in?** Today it gets nothing else. An email address would need the member's say-so.
9. **Account deletion.** Apple requires apps that create accounts to offer deletion. One answer for a Lens Account: the Passport forgets the member and their key, and the Account stays onchain with no owner.
10. **Should existing Lens accounts be invited in?** If yes, owners with no MON need the [Lens change](lens-changes.md).

**Money**

11. **Who funds the relayer?** About 0.16 MON per new member, so about 1,600 MON per 10,000. Sign-up needs a cap so that scripts cannot drain it.
12. **Who pays for members' actions?** Today each club pays the gas for what it does as its members: about 0.06 MON a post. Sponsoring clubs would be a separate piece.

**Contract**

13. **Add "disconnect everything" to the registry?** One call that ends every grant on an Account. It would make a handover a clean start and close a gap: today grants come back if a member removes the registry and later adds it again. About 30 lines. Recommended, and best done before an audit.
