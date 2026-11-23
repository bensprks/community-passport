// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IEmailProofVerifier} from "./IEmailProofVerifier.sol";

/**
 * @notice FOR DEVELOPMENT ONLY. Stands in for a real proof that a member sent an email.
 *
 * It accepts the word of one key, the attestor, that it saw such an email. Whoever holds that key can add a
 * device to any member's owner contract, so with this verifier the attestor is a custodian by another name.
 * The real verifier checks the mail provider's own signature on the email, and trusts nobody's word.
 */
contract AttestedEmailVerifier is IEmailProofVerifier {
    error ProofExpired();
    error InvalidProof();

    address public immutable ATTESTOR;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant EMAIL_SEEN_TYPEHASH =
        keccak256("EmailSeen(bytes32 emailId,bytes32 command,bytes32 emailNullifier,uint64 validUntil)");

    constructor(address attestor) {
        ATTESTOR = attestor;
    }

    /// @dev `proof` is `abi.encode(emailNullifier, validUntil, signature)`: a value unique to the email, how long
    /// the attestation is good for, and the attestor's signature over all of it.
    function verify(bytes32 emailId, bytes32 command, bytes calldata proof) external view override returns (bytes32) {
        (bytes32 emailNullifier, uint64 validUntil, bytes memory signature) =
            abi.decode(proof, (bytes32, uint64, bytes));
        require(block.timestamp <= validUntil, ProofExpired());
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("AttestedEmailVerifier"), keccak256("1"), block.chainid, address(this)
            )
        );
        bytes32 structHash = keccak256(abi.encode(EMAIL_SEEN_TYPEHASH, emailId, command, emailNullifier, validUntil));
        (address signer, ECDSA.RecoverError recoverError,) =
            ECDSA.tryRecover(keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)), signature);
        require(recoverError == ECDSA.RecoverError.NoError && signer == ATTESTOR, InvalidProof());
        return keccak256(abi.encode(emailId, emailNullifier));
    }
}
