// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GrantRegistry} from "../src/GrantRegistry.sol";
import {IGrantRegistry, Scope} from "../src/IGrantRegistry.sol";
import {RegistryTestBase} from "./helpers/RegistryTestBase.sol";
import {MockAccount, MockTarget, MockContractWallet, GrantRegistryV2} from "./helpers/Mocks.sol";

contract GrantRegistryTest is RegistryTestBase {
    uint256 constant OWNER_KEY = 0xA11CE;
    address owner = vm.addr(OWNER_KEY);
    address club = makeAddr("CLUB");
    address stranger = makeAddr("STRANGER");

    MockAccount account;
    MockTarget target;
    Scope[] scopes;
    bytes32 scopeId;
    uint64 expiry;

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployRegistry();
        account = new MockAccount(owner, address(registry));
        target = new MockTarget();
        scopes.push(Scope(address(target), MockTarget.ping.selector));
        scopeId = registry.defineScope(scopes);
        expiry = uint64(block.timestamp + 90 days);
    }

    function _grant() internal {
        vm.prank(owner);
        registry.grant(address(account), club, scopeId, expiry);
    }

    // Scopes

    function test_DefineScope_StoresEachFunction() public view {
        assertEq(scopeId, _hashScopes(scopes));
        assertTrue(registry.isScopeDefined(scopeId));
        assertTrue(registry.inScope(scopeId, address(target), MockTarget.ping.selector));
        assertFalse(registry.inScope(scopeId, address(target), MockTarget.other.selector));
        assertFalse(registry.inScope(scopeId, stranger, MockTarget.ping.selector));
    }

    function test_DefineScope_Again_IsANoOp() public {
        vm.recordLogs();
        assertEq(registry.defineScope(scopes), scopeId);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_DefineScope_IdDependsOnTheWholeList() public {
        Scope[] memory wider = new Scope[](2);
        wider[0] = scopes[0];
        wider[1] = Scope(address(target), MockTarget.other.selector);
        bytes32 widerId = registry.defineScope(wider);
        assertTrue(widerId != scopeId);
        assertFalse(registry.inScope(scopeId, address(target), MockTarget.other.selector));
        assertTrue(registry.inScope(widerId, address(target), MockTarget.other.selector));
    }

    function test_DefineScope_RevertsWhen_EmptyTooLongOrZeroTarget() public {
        vm.expectRevert(IGrantRegistry.InvalidScope.selector);
        registry.defineScope(new Scope[](0));

        Scope[] memory tooLong = new Scope[](registry.MAX_SCOPE_SIZE() + 1);
        vm.expectRevert(IGrantRegistry.InvalidScope.selector);
        registry.defineScope(tooLong);

        vm.expectRevert(IGrantRegistry.InvalidScope.selector);
        registry.defineScope(_scope(address(0), MockTarget.ping.selector));
    }

    // Granting

    function test_Grant_ByOwner() public {
        vm.expectEmit(address(registry));
        emit IGrantRegistry.Granted(address(account), club, scopeId, expiry);
        _grant();
        (bytes32 grantedScope, uint64 grantedExpiry) = registry.grantOf(address(account), club);
        assertEq(grantedScope, scopeId);
        assertEq(grantedExpiry, expiry);
        assertTrue(registry.isAllowed(address(account), club, address(target), MockTarget.ping.selector));
    }

    function test_Grant_RevertsWhen_CallerIsNotTheOwner() public {
        vm.prank(club);
        vm.expectRevert(IGrantRegistry.NotOwner.selector);
        registry.grant(address(account), club, scopeId, expiry);
    }

    function test_Grant_RevertsWhen_ScopeIsUnknown() public {
        vm.prank(owner);
        vm.expectRevert(IGrantRegistry.UnknownScope.selector);
        registry.grant(address(account), club, keccak256("unknown"), expiry);
    }

    function test_Grant_RevertsWhen_GranteeIsZero() public {
        vm.prank(owner);
        vm.expectRevert(IGrantRegistry.InvalidAddress.selector);
        registry.grant(address(account), address(0), scopeId, expiry);
    }

    function test_Grant_RevertsWhen_ExpiryIsPastOrTooFar() public {
        uint64 latest = uint64(block.timestamp) + registry.MAX_GRANT_DURATION();
        vm.startPrank(owner);
        vm.expectRevert(IGrantRegistry.InvalidExpiry.selector);
        registry.grant(address(account), club, scopeId, uint64(block.timestamp));

        vm.expectRevert(IGrantRegistry.InvalidExpiry.selector);
        registry.grant(address(account), club, scopeId, latest + 1);

        registry.grant(address(account), club, scopeId, latest);
        vm.stopPrank();
    }

    function test_Grant_ReplacesTheEarlierOne() public {
        _grant();
        bytes32 otherScope = registry.defineScope(_scope(address(target), MockTarget.other.selector));
        vm.prank(owner);
        registry.grant(address(account), club, otherScope, expiry);

        assertFalse(registry.isAllowed(address(account), club, address(target), MockTarget.ping.selector));
        assertTrue(registry.isAllowed(address(account), club, address(target), MockTarget.other.selector));
    }

    function test_GrantWithSig_SubmittedByAnyone() public {
        bytes memory signature =
            _signGrant(OWNER_KEY, address(account), club, scopes, expiry, 7, block.timestamp + 1 hours);
        vm.prank(stranger);
        registry.grantWithSig(address(account), club, scopeId, expiry, 7, block.timestamp + 1 hours, signature);

        assertTrue(registry.isAllowed(address(account), club, address(target), MockTarget.ping.selector));
        assertTrue(registry.isNonceUsed(address(account), 7));
    }

    function test_GrantWithSig_NoncesNeedNoOrder() public {
        uint256 deadline = block.timestamp + 1 hours;
        registry.grantWithSig(
            address(account),
            club,
            scopeId,
            expiry,
            2,
            deadline,
            _signGrant(OWNER_KEY, address(account), club, scopes, expiry, 2, deadline)
        );
        registry.grantWithSig(
            address(account),
            stranger,
            scopeId,
            expiry,
            1,
            deadline,
            _signGrant(OWNER_KEY, address(account), stranger, scopes, expiry, 1, deadline)
        );
    }

    function test_GrantWithSig_RevertsWhen_Replayed() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signGrant(OWNER_KEY, address(account), club, scopes, expiry, 7, deadline);
        registry.grantWithSig(address(account), club, scopeId, expiry, 7, deadline, signature);

        vm.expectRevert(IGrantRegistry.NonceUsed.selector);
        registry.grantWithSig(address(account), club, scopeId, expiry, 7, deadline, signature);
    }

    function test_GrantWithSig_RevertsWhen_PastItsDeadline() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signGrant(OWNER_KEY, address(account), club, scopes, expiry, 7, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(IGrantRegistry.SignatureExpired.selector);
        registry.grantWithSig(address(account), club, scopeId, expiry, 7, deadline, signature);
    }

    function test_GrantWithSig_RevertsWhen_NotSignedByTheOwner() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signGrant(0xBAD, address(account), club, scopes, expiry, 7, deadline);
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.grantWithSig(address(account), club, scopeId, expiry, 7, deadline, signature);
    }

    /// Each field the owner signed is bound: changing any one of them makes the signature invalid.
    function test_GrantWithSig_RevertsWhen_AnyFieldDiffersFromWhatWasSigned() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signGrant(OWNER_KEY, address(account), club, scopes, expiry, 7, deadline);
        bytes32 widerScope = registry.defineScope(_scope(address(target), MockTarget.other.selector));
        MockAccount otherAccount = new MockAccount(owner, address(registry));

        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.grantWithSig(address(otherAccount), club, scopeId, expiry, 7, deadline, signature);
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.grantWithSig(address(account), stranger, scopeId, expiry, 7, deadline, signature);
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.grantWithSig(address(account), club, widerScope, expiry, 7, deadline, signature);
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.grantWithSig(address(account), club, scopeId, expiry + 1, 7, deadline, signature);
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.grantWithSig(address(account), club, scopeId, expiry, 8, deadline, signature);
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.grantWithSig(address(account), club, scopeId, expiry, 7, deadline + 1, signature);
    }

    function test_GrantWithSig_RevertsWhen_SignedForAnotherChainOrRegistry() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signGrant(OWNER_KEY, address(account), club, scopes, expiry, 7, deadline);

        vm.chainId(block.chainid + 1);
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.grantWithSig(address(account), club, scopeId, expiry, 7, deadline, signature);
        vm.chainId(block.chainid - 1);

        GrantRegistry first = registry;
        _deployRegistry();
        registry.defineScope(scopes);
        MockAccount accountOnSecond = new MockAccount(owner, address(registry));
        assertTrue(address(registry) != address(first));
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.grantWithSig(address(accountOnSecond), club, scopeId, expiry, 7, deadline, signature);
    }

    function test_GrantWithSig_OwnerIsAContractWallet() public {
        MockContractWallet wallet = new MockContractWallet(owner);
        account.setOwner(address(wallet));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signGrant(OWNER_KEY, address(account), club, scopes, expiry, 7, deadline);
        registry.grantWithSig(address(account), club, scopeId, expiry, 7, deadline, signature);
        assertTrue(registry.isAllowed(address(account), club, address(target), MockTarget.ping.selector));
    }

    // An EIP-7702 account has code at its address while its key still signs. Its code need not answer ERC-1271.
    function test_GrantWithSig_OwnerIsAKeyWithCodeAtItsAddress() public {
        vm.etch(owner, address(target).code);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signGrant(OWNER_KEY, address(account), club, scopes, expiry, 7, deadline);
        registry.grantWithSig(address(account), club, scopeId, expiry, 7, deadline, signature);
        assertTrue(registry.isAllowed(address(account), club, address(target), MockTarget.ping.selector));

        // Someone else's signature is still refused.
        signature = _signGrant(0xBAD, address(account), stranger, scopes, expiry, 8, deadline);
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.grantWithSig(address(account), stranger, scopeId, expiry, 8, deadline, signature);
    }

    // Acting

    function test_Execute_ForwardsTheCallAsTheAccountWithNoValue() public {
        _grant();
        vm.deal(address(account), 1 ether);
        vm.prank(club);
        bytes memory returned =
            registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (41)));

        assertEq(abi.decode(returned, (uint256)), 42);
        assertEq(target.lastCaller(), address(account));
        assertEq(target.lastNumber(), 41);
        assertEq(account.lastValue(), 0);
        assertEq(address(target).balance, 0);
    }

    function test_Execute_RevertsWhen_NoGrant() public {
        vm.prank(club);
        vm.expectRevert(IGrantRegistry.GrantNotActive.selector);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (1)));
    }

    function test_Execute_RevertsWhen_CallerHoldsNoGrantOnThatAccount() public {
        _grant();
        MockAccount otherAccount = new MockAccount(owner, address(registry));
        vm.prank(club);
        vm.expectRevert(IGrantRegistry.GrantNotActive.selector);
        registry.execute(address(otherAccount), address(target), abi.encodeCall(MockTarget.ping, (1)));

        vm.prank(stranger);
        vm.expectRevert(IGrantRegistry.GrantNotActive.selector);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (1)));
    }

    function test_Execute_WorksUntilTheExpiryAndNotAfter() public {
        _grant();
        vm.warp(expiry - 1);
        vm.prank(club);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (1)));

        vm.warp(expiry);
        assertFalse(registry.isAllowed(address(account), club, address(target), MockTarget.ping.selector));
        vm.prank(club);
        vm.expectRevert(IGrantRegistry.GrantNotActive.selector);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (1)));
    }

    function test_Execute_RevertsWhen_FunctionOrTargetIsOutOfScope() public {
        _grant();
        MockTarget otherTarget = new MockTarget();
        vm.startPrank(club);
        vm.expectRevert(IGrantRegistry.NotInScope.selector);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.other, ()));

        vm.expectRevert(IGrantRegistry.NotInScope.selector);
        registry.execute(address(account), address(otherTarget), abi.encodeCall(MockTarget.ping, (1)));
        vm.stopPrank();
    }

    function test_Execute_RevertsWhen_DataHasNoSelector() public {
        _grant();
        vm.startPrank(club);
        vm.expectRevert(IGrantRegistry.NotInScope.selector);
        registry.execute(address(account), address(target), "");

        vm.expectRevert(IGrantRegistry.NotInScope.selector);
        registry.execute(address(account), address(target), hex"112233");
        vm.stopPrank();
    }

    function testFuzz_Execute_OnlyEverCallsAFunctionInScope(address anyTarget, bytes calldata data) public {
        _grant();
        bool inScope = anyTarget == address(target) && data.length >= 4 && bytes4(data[:4]) == MockTarget.ping.selector;
        vm.assume(!inScope);
        vm.prank(club);
        vm.expectRevert(IGrantRegistry.NotInScope.selector);
        registry.execute(address(account), anyTarget, data);
    }

    function testFuzz_Grant_ExpiryIsAlwaysWithinAYear(uint64 anyExpiry) public {
        bool valid = anyExpiry > block.timestamp && anyExpiry - block.timestamp <= registry.MAX_GRANT_DURATION();
        vm.prank(owner);
        if (!valid) vm.expectRevert(IGrantRegistry.InvalidExpiry.selector);
        registry.grant(address(account), club, scopeId, anyExpiry);
    }

    // Revoking

    function test_Revoke_ByOwner() public {
        _grant();
        vm.expectEmit(address(registry));
        emit IGrantRegistry.Revoked(address(account), club);
        vm.prank(owner);
        registry.revoke(address(account), club);

        (, uint64 grantedExpiry) = registry.grantOf(address(account), club);
        assertEq(grantedExpiry, 0);
        vm.prank(club);
        vm.expectRevert(IGrantRegistry.GrantNotActive.selector);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (1)));
    }

    function test_RevokeAll_EndsEveryGrantAndLetsNewOnesBeMade() public {
        _grant();
        address otherClub = makeAddr("OTHER_CLUB");
        vm.prank(owner);
        registry.grant(address(account), otherClub, scopeId, expiry);

        vm.expectEmit(address(registry));
        emit IGrantRegistry.RevokedAll(address(account));
        vm.prank(owner);
        registry.revokeAll(address(account));

        (bytes32 grantedScope, uint64 grantedExpiry) = registry.grantOf(address(account), club);
        assertEq(grantedScope, bytes32(0));
        assertEq(grantedExpiry, 0);
        assertFalse(registry.isAllowed(address(account), otherClub, address(target), MockTarget.ping.selector));
        vm.prank(club);
        vm.expectRevert(IGrantRegistry.GrantNotActive.selector);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (1)));

        // A grant made afterwards works, and the old one to the other club stays ended.
        _grant();
        vm.prank(club);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (1)));
        assertFalse(registry.isAllowed(address(account), otherClub, address(target), MockTarget.ping.selector));
    }

    function test_RevokeAll_RevertsWhen_CallerIsNotTheOwner() public {
        _grant();
        vm.prank(club);
        vm.expectRevert(IGrantRegistry.NotOwner.selector);
        registry.revokeAll(address(account));
    }

    function test_RevokeAllWithSig_SubmittedByAnyone() public {
        _grant();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signRevokeAll(OWNER_KEY, address(account), 9, deadline);
        vm.prank(stranger);
        registry.revokeAllWithSig(address(account), 9, deadline, signature);
        assertFalse(registry.isAllowed(address(account), club, address(target), MockTarget.ping.selector));

        // Not by someone else's signature, and a signature to end one grant does not end them all.
        _grant();
        signature = _signRevokeAll(0xBAD, address(account), 10, deadline);
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.revokeAllWithSig(address(account), 10, deadline, signature);
        signature = _signRevoke(OWNER_KEY, address(account), club, 11, deadline);
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.revokeAllWithSig(address(account), 11, deadline, signature);
    }

    function test_Revoke_ByTheGranteeItself() public {
        _grant();
        vm.prank(club);
        registry.revoke(address(account), club);
        assertFalse(registry.isAllowed(address(account), club, address(target), MockTarget.ping.selector));
    }

    function test_Revoke_RevertsWhen_CallerIsNeitherOwnerNorGrantee() public {
        _grant();
        vm.prank(stranger);
        vm.expectRevert(IGrantRegistry.NotOwnerOrGrantee.selector);
        registry.revoke(address(account), club);
    }

    function test_RevokeWithSig_SubmittedByAnyone() public {
        _grant();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signRevoke(OWNER_KEY, address(account), club, 9, deadline);
        vm.prank(stranger);
        registry.revokeWithSig(address(account), club, 9, deadline, signature);
        assertFalse(registry.isAllowed(address(account), club, address(target), MockTarget.ping.selector));

        vm.expectRevert(IGrantRegistry.NonceUsed.selector);
        registry.revokeWithSig(address(account), club, 9, deadline, signature);
    }

    function test_RevokeWithSig_RevertsWhen_NotSignedByTheOwner() public {
        _grant();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signRevoke(0xBAD, address(account), club, 9, deadline);
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.revokeWithSig(address(account), club, 9, deadline, signature);
    }

    /// A grant signature can't be passed off as a revocation, or the other way round.
    function test_Signatures_AreNotInterchangeableBetweenGrantAndRevoke() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory revokeSignature = _signRevoke(OWNER_KEY, address(account), club, 9, deadline);
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.grantWithSig(address(account), club, scopeId, expiry, 9, deadline, revokeSignature);
    }

    // Changing owner

    function test_OwnerChange_KeepsGrantsAndVoidsTheOldOwnersSignatures() public {
        _grant();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory oldOwnersSignature = _signGrant(OWNER_KEY, address(account), stranger, scopes, expiry, 7, deadline);

        address newOwner = makeAddr("NEW_OWNER");
        account.setOwner(newOwner);

        assertTrue(registry.isAllowed(address(account), club, address(target), MockTarget.ping.selector));
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.grantWithSig(address(account), stranger, scopeId, expiry, 7, deadline, oldOwnersSignature);
        vm.prank(owner);
        vm.expectRevert(IGrantRegistry.NotOwnerOrGrantee.selector);
        registry.revoke(address(account), club);

        vm.prank(newOwner);
        registry.revoke(address(account), club);
    }

    // Guardian

    function test_Pause_StopsGrantsAndExecuteButNotRevoking() public {
        _grant();
        vm.expectEmit(address(registry));
        emit IGrantRegistry.PausedSet(true);
        vm.prank(guardian);
        registry.setPaused(true);

        assertFalse(registry.isAllowed(address(account), club, address(target), MockTarget.ping.selector));
        vm.prank(club);
        vm.expectRevert(IGrantRegistry.RegistryPaused.selector);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (1)));

        vm.prank(owner);
        vm.expectRevert(IGrantRegistry.RegistryPaused.selector);
        registry.grant(address(account), stranger, scopeId, expiry);

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signGrant(OWNER_KEY, address(account), stranger, scopes, expiry, 7, deadline);
        vm.expectRevert(IGrantRegistry.RegistryPaused.selector);
        registry.grantWithSig(address(account), stranger, scopeId, expiry, 7, deadline, signature);

        vm.prank(owner);
        registry.revoke(address(account), club);

        vm.prank(guardian);
        registry.setPaused(false);
        vm.prank(club);
        vm.expectRevert(IGrantRegistry.GrantNotActive.selector);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (1)));
    }

    function test_Guardian_OnlyTheGuardianPausesOrHandsOver() public {
        vm.startPrank(stranger);
        vm.expectRevert(IGrantRegistry.NotGuardian.selector);
        registry.setPaused(true);
        vm.expectRevert(IGrantRegistry.NotGuardian.selector);
        registry.setGuardian(stranger);
        vm.stopPrank();

        vm.startPrank(guardian);
        vm.expectRevert(IGrantRegistry.InvalidAddress.selector);
        registry.setGuardian(address(0));
        registry.setGuardian(stranger);
        vm.stopPrank();
        assertEq(registry.guardian(), stranger);

        vm.prank(guardian);
        vm.expectRevert(IGrantRegistry.NotGuardian.selector);
        registry.setPaused(true);
    }

    // Deployment and upgrades

    function test_Initialize_OnlyOnceAndNeverOnTheLogicContract() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        registry.initialize(stranger);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        GrantRegistry(registryImpl).initialize(stranger);
    }

    function test_Storage_LivesAtItsNamespacedLocation() public view {
        bytes32 location = keccak256(abi.encode(uint256(keccak256("community-passport.storage.GrantRegistry")) - 1))
            & ~bytes32(uint256(0xff));
        assertEq(address(uint160(uint256(vm.load(address(registry), location)))), guardian);
    }

    function test_Upgrade_KeepsTheAddressTheGrantsAndTheSignatures() public {
        _grant();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _signGrant(OWNER_KEY, address(account), stranger, scopes, expiry, 7, deadline);

        address newLogic = address(new GrantRegistryV2());
        vm.prank(upgrader);
        proxyAdmin.upgradeAndCall(ITransparentUpgradeableProxy(address(registry)), newLogic, "");

        assertEq(GrantRegistryV2(address(registry)).version(), 2);
        assertEq(registry.guardian(), guardian);
        assertTrue(registry.isAllowed(address(account), club, address(target), MockTarget.ping.selector));
        registry.grantWithSig(address(account), stranger, scopeId, expiry, 7, deadline, signature);
    }

    function test_Upgrade_RevertsWhen_CallerIsNotTheProxyAdminsOwner() public {
        address newLogic = address(new GrantRegistryV2());
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        proxyAdmin.upgradeAndCall(ITransparentUpgradeableProxy(address(registry)), newLogic, "");
    }
}
