// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {GrantRegistry} from "../src/GrantRegistry.sol";

/**
 * Deploys the registry behind a proxy whose upgrades go through a delay.
 *
 *   PASSPORT_ADMIN          who can schedule and run upgrades, e.g. a multisig
 *   PASSPORT_GUARDIAN       who can pause and resume the registry
 *   PASSPORT_UPGRADE_DELAY  seconds between scheduling an upgrade and running it (default 7 days)
 *
 * Who controls what afterwards:
 *
 *   admin ──schedules, waits, executes──▶ timelock ──owns──▶ ProxyAdmin ──upgrades──▶ registry proxy
 *   guardian ──pauses and resumes──▶ registry
 *
 * The timelock has no other admin, so its delay and its roles can only change through the timelock itself.
 */
contract Deploy is Script {
    function run() external returns (address registry, address timelock) {
        address admin = vm.envAddress("PASSPORT_ADMIN");
        address guardian = vm.envAddress("PASSPORT_GUARDIAN");
        uint256 upgradeDelay = vm.envOr("PASSPORT_UPGRADE_DELAY", uint256(7 days));

        vm.startBroadcast();
        (registry, timelock) = deploy(admin, guardian, upgradeDelay);
        vm.stopBroadcast();

        console.log("GrantRegistry (add this as account manager):", registry);
        console.log("Upgrade timelock:", timelock);
    }

    function deploy(address admin, address guardian, uint256 upgradeDelay)
        public
        returns (address registry, address timelock)
    {
        address[] memory adminOnly = new address[](1);
        adminOnly[0] = admin;
        timelock = address(new TimelockController(upgradeDelay, adminOnly, adminOnly, address(0)));
        // The proxy deploys its own ProxyAdmin, owned by the timelock.
        registry = address(
            new TransparentUpgradeableProxy(
                address(new GrantRegistry()), timelock, abi.encodeCall(GrantRegistry.initialize, (guardian))
            )
        );
    }
}
