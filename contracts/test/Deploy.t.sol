// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {GrantRegistry} from "../src/GrantRegistry.sol";
import {GrantRegistryV2} from "./helpers/Mocks.sol";

/// @dev The deployment the script makes: who can upgrade the registry, and how long it takes.
contract DeployTest is Test {
    bytes32 constant ERC1967_ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    uint256 constant DELAY = 7 days;

    address admin = makeAddr("ADMIN");
    address guardian = makeAddr("GUARDIAN");

    GrantRegistry registry;
    TimelockController timelock;
    ProxyAdmin proxyAdmin;

    function setUp() public {
        (address registryAddress, address timelockAddress) = new Deploy().deploy(admin, guardian, DELAY);
        registry = GrantRegistry(registryAddress);
        timelock = TimelockController(payable(timelockAddress));
        proxyAdmin = ProxyAdmin(address(uint160(uint256(vm.load(registryAddress, ERC1967_ADMIN_SLOT)))));
    }

    function test_Deploy_WiresTheRoles() public view {
        assertEq(registry.guardian(), guardian);
        assertFalse(registry.paused());
        assertEq(proxyAdmin.owner(), address(timelock));
        assertEq(timelock.getMinDelay(), DELAY);
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), admin));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), admin));
        // Nobody can grant themselves a role or shorten the delay, except through the timelock itself.
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), admin));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(this)));
    }

    function test_Upgrade_TakesTheDelay() public {
        address newLogic = address(new GrantRegistryV2());
        bytes memory upgrade =
            abi.encodeCall(ProxyAdmin.upgradeAndCall, (ITransparentUpgradeableProxy(address(registry)), newLogic, ""));

        vm.startPrank(admin);
        timelock.schedule(address(proxyAdmin), 0, upgrade, bytes32(0), bytes32(0), DELAY);

        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert();
        timelock.execute(address(proxyAdmin), 0, upgrade, bytes32(0), bytes32(0));

        vm.warp(block.timestamp + 1);
        timelock.execute(address(proxyAdmin), 0, upgrade, bytes32(0), bytes32(0));
        vm.stopPrank();

        assertEq(GrantRegistryV2(address(registry)).version(), 2);
        assertEq(registry.guardian(), guardian);
    }

    function test_Upgrade_RevertsWhen_NotThroughTheTimelock() public {
        address newLogic = address(new GrantRegistryV2());

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        proxyAdmin.upgradeAndCall(ITransparentUpgradeableProxy(address(registry)), newLogic, "");

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        proxyAdmin.upgradeAndCall(ITransparentUpgradeableProxy(address(registry)), newLogic, "");
    }

    function test_Schedule_RevertsWhen_ShorterThanTheDelayOrNotTheAdmin() public {
        bytes memory call = abi.encodeCall(Ownable.transferOwnership, (admin));

        vm.prank(admin);
        vm.expectRevert();
        timelock.schedule(address(proxyAdmin), 0, call, bytes32(0), bytes32(0), DELAY - 1);

        vm.prank(guardian);
        vm.expectRevert();
        timelock.schedule(address(proxyAdmin), 0, call, bytes32(0), bytes32(0), DELAY);
    }
}
