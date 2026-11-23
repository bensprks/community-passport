// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {EmailOwner} from "./EmailOwner.sol";
import {IEmailProofVerifier} from "./IEmailProofVerifier.sol";

/// @notice Deploys one EmailOwner per member, at an address that follows from the member's `emailId` alone.
/// Anyone can deploy one: a new owner contract has no devices, and only the member's email can add the first.
contract EmailOwnerFactory {
    event OwnerCreated(bytes32 indexed emailId, address owner);

    address public immutable IMPLEMENTATION;

    constructor(IEmailProofVerifier emailVerifier, uint64 enrolDelay) {
        IMPLEMENTATION = address(new EmailOwner(emailVerifier, enrolDelay));
    }

    /// @notice Deploys the owner contract for `emailId`, or returns it if it is already there.
    function create(bytes32 emailId) external returns (address owner) {
        owner = ownerFor(emailId);
        if (owner.code.length == 0) {
            Clones.cloneDeterministic(IMPLEMENTATION, emailId);
            EmailOwner(owner).initialize(emailId);
            emit OwnerCreated(emailId, owner);
        }
    }

    function ownerFor(bytes32 emailId) public view returns (address) {
        return Clones.predictDeterministicAddress(IMPLEMENTATION, emailId);
    }
}
