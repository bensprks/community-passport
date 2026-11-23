// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {AttestedEmailVerifier} from "../src/email/AttestedEmailVerifier.sol";
import {EmailOwnerFactory} from "../src/email/EmailOwnerFactory.sol";

/**
 * Deploys what email-rooted accounts need, WITH THE DEVELOPMENT STAND-IN for the email proof.
 *
 *   PASSPORT_EMAIL_ATTESTOR  the key whose word the stand-in takes that a member sent an email
 *   PASSPORT_ENROL_DELAY     seconds a device added by email waits, when the member already has one (default 2 days)
 *
 * Not for real use: the attestor can add a device to any member. A real deployment passes the factory a verifier
 * that checks the mail provider's signature instead.
 */
contract DeployEmailOwners is Script {
    function run() external returns (address verifier, address factory) {
        address attestor = vm.envAddress("PASSPORT_EMAIL_ATTESTOR");
        uint64 enrolDelay = uint64(vm.envOr("PASSPORT_ENROL_DELAY", uint256(2 days)));

        vm.startBroadcast();
        verifier = address(new AttestedEmailVerifier(attestor));
        factory = address(new EmailOwnerFactory(AttestedEmailVerifier(verifier), enrolDelay));
        vm.stopBroadcast();

        console.log("Email proof verifier (development stand-in):", verifier);
        console.log("EmailOwnerFactory:", factory);
    }
}
