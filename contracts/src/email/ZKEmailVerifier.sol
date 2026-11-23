// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Bytes} from "@openzeppelin/contracts/utils/Bytes.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IVerifier, EmailProof} from "@zk-email/email-tx-builder/src/interfaces/IVerifier.sol";
import {IEmailProofVerifier} from "./IEmailProofVerifier.sol";

/// @dev The onchain list of the keys mail providers sign with, as ZK Email defines it.
interface IDKIMRegistry {
    function isDKIMPublicKeyHashValid(string memory domainName, bytes32 publicKeyHash) external view returns (bool);
}

/**
 * @notice Checks that a member sent an email, with ZK Email. Nobody's word is taken for it.
 *
 * A mail provider signs every email it sends (DKIM). The proof shows, without revealing the email, that:
 *  - the provider of the sender's domain signed it, with a key on the list of providers' keys;
 *  - the sender is the address behind `emailId`;
 *  - its body carries the line "signHash <number>".
 * This contract then checks that the number is the command being approved, and that the email is recent.
 *
 * `emailId` is ZK Email's "account salt": a hash of the address and a secret code, which the member's emails carry.
 */
contract ZKEmailVerifier is IEmailProofVerifier {
    error WrongEmail();
    error WrongCommand();
    error CodeMissing();
    error UnknownMailKey();
    error EmailNotRecent();
    error InvalidProof();

    /// @notice ZK Email's verifier, which checks the proof itself.
    IVerifier public immutable PROOF_VERIFIER;
    IDKIMRegistry public immutable DKIM_REGISTRY;
    /// @notice How old an email may be, by the time its mail provider put on it.
    uint256 public immutable MAX_EMAIL_AGE;

    /// @dev How far a mail provider's clock may run ahead of the chain's.
    uint256 private constant CLOCK_SLACK = 5 minutes;

    constructor(IVerifier proofVerifier, IDKIMRegistry dkimRegistry, uint256 maxEmailAge) {
        PROOF_VERIFIER = proofVerifier;
        DKIM_REGISTRY = dkimRegistry;
        MAX_EMAIL_AGE = maxEmailAge;
    }

    /// @dev `proof` is `abi.encode(skippedPrefix, EmailProof)`: ZK Email's proof of the email, and how many
    /// characters a mail program put in front of the command line, for example when quoting a reply.
    function verify(bytes32 emailId, bytes32 command, bytes calldata proof) external view override returns (bytes32) {
        (uint256 skippedPrefix, EmailProof memory email) = abi.decode(proof, (uint256, EmailProof));

        require(email.accountSalt == emailId, WrongEmail());
        // The member's email has to carry their secret code, which shows they hold it and can use the account
        // again without whoever relayed this email.
        require(email.isCodeExist, CodeMissing());
        bytes memory shown = bytes(email.maskedCommand);
        require(
            skippedPrefix <= shown.length
                && Strings.equal(
                    string(Bytes.slice(shown, skippedPrefix)),
                    string.concat("signHash ", Strings.toString(uint256(command)))
                ),
            WrongCommand()
        );
        require(DKIM_REGISTRY.isDKIMPublicKeyHashValid(email.domainName, email.publicKeyHash), UnknownMailKey());
        require(
            email.timestamp <= block.timestamp + CLOCK_SLACK && email.timestamp + MAX_EMAIL_AGE >= block.timestamp,
            EmailNotRecent()
        );
        require(PROOF_VERIFIER.verifyEmailProof(email), InvalidProof());

        // Unique to the email, so that the caller can refuse to act on it twice.
        return email.emailNullifier;
    }
}
