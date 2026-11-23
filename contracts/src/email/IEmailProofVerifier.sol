// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Checks a proof that the holder of an email address sent an email approving a command.
///
/// `emailId` stands for the address without revealing it: a hash of the address and a secret only its holder and
/// their relayer know. `command` is the 32-byte value the email approves.
interface IEmailProofVerifier {
    /// @notice Reverts unless `proof` shows that the address behind `emailId` approved `command`, recently enough.
    /// @return proofId A value unique to the email that was proven, so that the caller can refuse to act on the
    /// same email twice.
    function verify(bytes32 emailId, bytes32 command, bytes calldata proof) external view returns (bytes32 proofId);
}
