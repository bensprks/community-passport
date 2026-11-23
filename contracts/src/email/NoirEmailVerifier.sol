// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IEmailProofVerifier} from "./IEmailProofVerifier.sol";
import {IDKIMRegistry} from "./ZKEmailVerifier.sol";

/// @dev The contract that checks a proof made with the Noir circuit. `noir/HonkVerifier.sol` is generated from the
/// circuit, and is one of these.
interface IHonkVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

/**
 * @notice Checks that a member sent an email, with a proof made by the Noir circuit in `circuits/email_proof`.
 * Nobody's word is taken for it, and the proof can be made in the member's own browser.
 *
 * A mail provider signs every email it sends (DKIM). The proof shows, without revealing the email, that:
 *  - a key signed it, and the sender's address is at a given domain;
 *  - the sender is the address behind `emailId`;
 *  - its body carries the line "signHash <number>".
 * This contract hands the proof the member and the command it is being asked about, so a proof of some other
 * email fails. It then checks that the key is that domain's on the list of providers' keys, and that the email
 * is recent.
 *
 * `emailId` is a hash of the address and a secret code that the member's emails carry, made inside the proof.
 */
contract NoirEmailVerifier is IEmailProofVerifier {
    error UnknownMailKey();
    error EmailNotRecent();
    error InvalidProof();

    /// @notice The contract generated from the circuit.
    IHonkVerifier public immutable PROOF_VERIFIER;
    IDKIMRegistry public immutable DKIM_REGISTRY;
    /// @notice How old an email may be, by the time its mail provider put on it.
    uint256 public immutable MAX_EMAIL_AGE;

    /// @dev How far a mail provider's clock may run ahead of the chain's.
    uint256 private constant CLOCK_SLACK = 5 minutes;
    /// @dev The numbers a proof works with are below this one. A command is 256 bits, so it is taken modulo it,
    /// inside the proof and here. Finding another command that agrees there is as hard as breaking its hash.
    uint256 private constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    constructor(IHonkVerifier proofVerifier, IDKIMRegistry dkimRegistry, uint256 maxEmailAge) {
        PROOF_VERIFIER = proofVerifier;
        DKIM_REGISTRY = dkimRegistry;
        MAX_EMAIL_AGE = maxEmailAge;
    }

    /// @dev `proof` is `abi.encode(honkProof, keyHash, domain, emailNullifier, timestamp)`: the proof itself, and
    /// what it gives out besides the member and the command. `domain` is the sender's domain, 31 characters to
    /// a word, as the circuit gives it out.
    function verify(bytes32 emailId, bytes32 command, bytes calldata proof) external view override returns (bytes32) {
        (bytes memory honkProof, bytes32 keyHash, bytes32[2] memory domain, bytes32 emailNullifier, uint256 timestamp) =
            abi.decode(proof, (bytes, bytes32, bytes32[2], bytes32, uint256));

        require(DKIM_REGISTRY.isDKIMPublicKeyHashValid(_domainName(domain), keyHash), UnknownMailKey());
        require(
            timestamp <= block.timestamp + CLOCK_SLACK && timestamp + MAX_EMAIL_AGE >= block.timestamp, EmailNotRecent()
        );

        // In the order the circuit gives them out. The member and the command come from the caller, not from the
        // proof's sender: that is what ties the proof to them.
        bytes32[] memory publicInputs = new bytes32[](7);
        publicInputs[0] = keyHash;
        publicInputs[1] = domain[0];
        publicInputs[2] = domain[1];
        publicInputs[3] = emailId;
        publicInputs[4] = bytes32(uint256(command) % FIELD);
        publicInputs[5] = emailNullifier;
        publicInputs[6] = bytes32(timestamp);

        // The generated verifier reverts on most bad proofs and returns false on the rest.
        try PROOF_VERIFIER.verify(honkProof, publicInputs) returns (bool verified) {
            require(verified, InvalidProof());
        } catch {
            revert InvalidProof();
        }

        // Unique to the email, so that the caller can refuse to act on it twice.
        return emailNullifier;
    }

    /// @dev The domain as text: its characters sit in the two words lowest byte first, and it has no zero in it.
    function _domainName(bytes32[2] memory domain) internal pure returns (string memory) {
        bytes memory name = new bytes(62);
        uint256 length;
        for (uint256 word = 0; word < 2; word++) {
            uint256 packed = uint256(domain[word]);
            while (packed != 0) {
                name[length++] = bytes1(uint8(packed));
                packed >>= 8;
            }
        }
        assembly ("memory-safe") {
            mstore(name, length)
        }
        return string(name);
    }
}
