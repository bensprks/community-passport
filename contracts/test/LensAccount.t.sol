// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Account as LensAccount} from "contracts/extensions/account/Account.sol";
import {AccountManagerPermissions} from "contracts/extensions/account/IAccount.sol";
import {SourceStamp, KeyValue} from "contracts/core/types/Types.sol";
import {NATIVE_TOKEN} from "contracts/core/types/Constants.sol";
import {IOwnable} from "contracts/core/interfaces/IOwnable.sol";
import {IGrantRegistry, Scope} from "../src/IGrantRegistry.sol";
import {RegistryTestBase} from "./helpers/RegistryTestBase.sol";
import {MockTarget} from "./helpers/Mocks.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev The registry against the real Lens Account contract, added as a manager the way the Passport adds it:
/// allowed to execute transactions, and nothing else.
contract LensAccountTest is RegistryTestBase {
    uint256 constant OWNER_KEY = 0xA11CE;
    address owner = vm.addr(OWNER_KEY);
    address club = makeAddr("CLUB");

    address accountLogic;
    LensAccount account;
    MockTarget target;
    MockToken token;
    uint64 expiry;

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployRegistry();
        accountLogic = address(new LensAccount(NATIVE_TOKEN, makeAddr("WRAPPED_NATIVE")));
        account = _deployAccount(owner, true);
        target = new MockTarget();
        token = new MockToken();
        expiry = uint64(block.timestamp + 90 days);
    }

    function _deployAccount(address accountOwner, bool withRegistry) internal returns (LensAccount) {
        address[] memory managers = new address[](withRegistry ? 1 : 0);
        AccountManagerPermissions[] memory permissions = new AccountManagerPermissions[](managers.length);
        if (withRegistry) {
            managers[0] = address(registry);
            permissions[0] = AccountManagerPermissions({
                canExecuteTransactions: true,
                canTransferTokens: false,
                canTransferNative: false,
                canSetMetadataURI: false
            });
        }
        SourceStamp memory noSource;
        bytes memory init = abi.encodeCall(
            LensAccount.initialize, (accountOwner, "", managers, permissions, noSource, new KeyValue[](0))
        );
        return LensAccount(payable(address(new ERC1967Proxy(accountLogic, init))));
    }

    /// @dev Grants `club` the given functions on `grantedAccount`, by the owner's signature, submitted by the club.
    function _grant(LensAccount grantedAccount, Scope[] memory scopes) internal {
        bytes32 scopeId = registry.defineScope(scopes);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = uint256(keccak256(abi.encode(grantedAccount, scopeId)));
        bytes memory signature = _signGrant(OWNER_KEY, address(grantedAccount), club, scopes, expiry, nonce, deadline);
        vm.prank(club);
        registry.grantWithSig(address(grantedAccount), club, scopeId, expiry, nonce, deadline, signature);
    }

    function test_Club_ActsAsTheAccount_WithinItsGrant() public {
        _grant(account, _scope(address(target), MockTarget.ping.selector));

        vm.prank(club);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (7)));
        assertEq(target.lastCaller(), address(account));
        assertEq(target.lastNumber(), 7);

        vm.prank(club);
        vm.expectRevert(IGrantRegistry.NotInScope.selector);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.other, ()));
    }

    /// Even with token functions in the grant, the Account refuses: its manager has no transfer permission.
    function test_Club_CannotMoveTheAccountsTokens() public {
        token.mint(address(account), 100e18);
        Scope[] memory scopes = new Scope[](2);
        scopes[0] = Scope(address(token), ERC20.transfer.selector);
        scopes[1] = Scope(address(token), ERC20.approve.selector);
        _grant(account, scopes);

        vm.startPrank(club);
        vm.expectRevert();
        registry.execute(address(account), address(token), abi.encodeCall(ERC20.transfer, (club, 1e18)));
        vm.expectRevert();
        registry.execute(address(account), address(token), abi.encodeCall(ERC20.approve, (club, 1e18)));
        vm.stopPrank();

        assertEq(token.balanceOf(address(account)), 100e18);
        assertEq(token.allowance(address(account), club), 0);
    }

    function test_Club_CannotMoveTheAccountsMon() public {
        vm.deal(address(account), 1 ether);
        _grant(account, _scope(address(target), MockTarget.ping.selector));

        vm.startPrank(club);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (7)));
        vm.expectRevert(IGrantRegistry.NotInScope.selector);
        registry.execute(address(account), club, "");
        vm.stopPrank();

        assertEq(address(account).balance, 1 ether);
        assertEq(address(target).balance, 0);
    }

    /// Even with the Account's own management functions in the grant, the Account refuses: only its owner may.
    function test_Club_CannotManageTheAccount() public {
        Scope[] memory scopes = new Scope[](3);
        scopes[0] = Scope(address(account), LensAccount.addAccountManager.selector);
        scopes[1] = Scope(address(account), LensAccount.removeAccountManager.selector);
        scopes[2] = Scope(address(account), IOwnable.transferOwnership.selector);
        _grant(account, scopes);
        AccountManagerPermissions memory permissions = AccountManagerPermissions(true, false, false, false);

        vm.startPrank(club);
        vm.expectRevert();
        registry.execute(
            address(account), address(account), abi.encodeCall(LensAccount.addAccountManager, (club, permissions))
        );
        vm.expectRevert();
        registry.execute(
            address(account), address(account), abi.encodeCall(LensAccount.removeAccountManager, (address(registry)))
        );
        vm.expectRevert();
        registry.execute(address(account), address(account), abi.encodeCall(IOwnable.transferOwnership, (club)));
        vm.stopPrank();

        assertEq(account.owner(), owner);
        assertFalse(account.isAccountManager(club));
        assertTrue(account.isAccountManager(address(registry)));
    }

    function test_RemovingTheRegistryFromTheAccount_EndsEveryGrantAtOnce() public {
        _grant(account, _scope(address(target), MockTarget.ping.selector));
        vm.prank(owner);
        account.removeAccountManager(address(registry));

        vm.prank(club);
        vm.expectRevert();
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (7)));
        assertEq(target.calls(), 0);
    }

    // Removing the registry alone leaves old grants waiting: they work again if it is added back. Ending every
    // grant first is what makes turning app access off final.
    function test_AddingTheRegistryBack_BringsGrantsBack_UnlessTheyWereAllEnded() public {
        _grant(account, _scope(address(target), MockTarget.ping.selector));
        AccountManagerPermissions memory executeOnly = AccountManagerPermissions(true, false, false, false);

        vm.startPrank(owner);
        account.removeAccountManager(address(registry));
        account.addAccountManager(address(registry), executeOnly);
        vm.stopPrank();
        vm.prank(club);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (7)));
        assertEq(target.calls(), 1, "the old grant is back");

        vm.startPrank(owner);
        registry.revokeAll(address(account));
        account.removeAccountManager(address(registry));
        account.addAccountManager(address(registry), executeOnly);
        vm.stopPrank();
        vm.prank(club);
        vm.expectRevert(IGrantRegistry.GrantNotActive.selector);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (7)));
    }

    function test_AnAccountThatNeverAddedTheRegistry_IsOutOfReach() public {
        LensAccount optedOut = _deployAccount(owner, false);
        _grant(optedOut, _scope(address(target), MockTarget.ping.selector));

        vm.prank(club);
        vm.expectRevert();
        registry.execute(address(optedOut), address(target), abi.encodeCall(MockTarget.ping, (7)));
        assertEq(target.calls(), 0);
    }

    /// Handing the Account to a new owner keeps its apps connected, and passes on the right to disconnect them.
    function test_TransferOwnership_KeepsGrants_AndTheNewOwnerRevokes() public {
        _grant(account, _scope(address(target), MockTarget.ping.selector));
        uint256 newOwnerKey = 0xB0B;
        vm.prank(owner);
        account.transferOwnership(vm.addr(newOwnerKey));

        vm.prank(club);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (7)));

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory oldOwnersSignature = _signRevoke(OWNER_KEY, address(account), club, 1, deadline);
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.revokeWithSig(address(account), club, 1, deadline, oldOwnersSignature);

        registry.revokeWithSig(
            address(account), club, 2, deadline, _signRevoke(newOwnerKey, address(account), club, 2, deadline)
        );
        vm.prank(club);
        vm.expectRevert(IGrantRegistry.GrantNotActive.selector);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (7)));
    }
}
