# Decisions

## Alternatives considered

| Option | What it is | Why not, for this |
| --- | --- | --- |
| **A wallet vendor's shared wallet** | The vendor holds one wallet per member and lets many apps use it | It does solve "one wallet across apps". But an app other than the wallet's own typically has to send the member to the vendor's page to confirm each action, so there is no silent posting, and pricing is typically per monthly user |
| **One Lens manager key per club, no registry** | Each Account adds each club's key as a manager | A manager can call anything, for ever. One leaked club key acts as every member of that club |
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

4. **Which key vendor?** It must hold keys in a sealed server, enforce the signing rule, and see the member's approval for itself: the acceptance test in [Passport](passport.md). Not yet tested against any vendor.
5. **Is recovery after a handover needed from the start?** Today a lost passkey, with no synced copy, is a lost Account. A recovery address would fix it and adds a little contract work on the Lens side.

6. **A key vendor, or accounts rooted in an email?** The second removes the vendor and its running cost, and adds a reply per device, a proof system to trust, and about 0.27 MON per device. See [Accounts rooted in an email](email-accounts.md).

**Product**

7. **The Passport's domain.** Every passkey is tied to it for good.
8. **How long should a grant last?** 90 days here, renewed at sign-in once half is gone. A year is the registry's limit.
9. **Does a club need more than the Account's address at sign-in?** Today it gets nothing else. An email address would need the member's say-so.
10. **Account deletion.** Apple requires apps that create accounts to offer deletion. One answer for a Lens Account: the Passport forgets the member and their key, and the Account stays onchain with no owner.
11. **Should existing Lens accounts be invited in?** If yes, owners with no MON need the [Lens change](lens-changes.md).

**Money**

12. **Who funds the relayer?** About 0.16 MON per new member, so about 1,600 MON per 10,000. Sign-up needs a cap so that scripts cannot drain it.
13. **Who pays for members' actions?** Today each club pays the gas for what it does as its members: about 0.06 MON a post. Sponsoring clubs would be a separate piece.

**Contract**

14. **Upgradeable, or fixed versions that members opt into?** Today the registry is upgradeable behind a delay, and a member can leave in one tap. The alternative is a registry that can never change, with each new version a separate contract that members choose to add. That removes the upgrade risk and makes every fix a migration. Fixed versions suit a first, narrow permission well.
15. **Checking arguments.** The registry checks the contract and the function only. Likes and votes go through one Lens contract that takes the real action as an argument, so granting them needs the registry to check that argument. Not built.
16. **Retiring an app's key.** Only a member, or the key itself, can end that key's grants. When a club replaces its developer, who ends the old key's grants for every member: the guardian, the operator, or each member?
17. **A way out that does not depend on the Passport's domain.** A passkey's key is derived on the Passport's page. Offer a handover to a wallet the member controls elsewhere, and a recovery path that works if the domain is gone.
