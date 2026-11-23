// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {EmailAuthMsg} from "@zk-email/email-tx-builder/src/interfaces/IEmailTypes.sol";
import {EmailProof} from "@zk-email/email-tx-builder/src/interfaces/IVerifier.sol";
import {Verifier} from "@zk-email/email-tx-builder/src/utils/Verifier.sol";
import {EmailAuthMsgFixtures} from "@zk-email/email-tx-builder/test/fixtures/EmailAuthMsgFixtures.sol";
import {Groth16Verifier} from "@zk-email/email-tx-builder/test/fixtures/Groth16Verifier.sol";
import {EmailOwner} from "../src/email/EmailOwner.sol";
import {IEmailProofVerifier} from "../src/email/IEmailProofVerifier.sol";
import {IDKIMRegistry, ZKEmailVerifier} from "../src/email/ZKEmailVerifier.sol";
import {Passkeys} from "./helpers/Passkeys.sol";

/// @dev The list of mail providers' keys, with only what the test puts on it.
contract MailKeyList is IDKIMRegistry {
    mapping(bytes32 => bool) known;

    function add(string memory domainName, bytes32 publicKeyHash) external {
        known[keccak256(abi.encode(domainName, publicKeyHash))] = true;
    }

    function isDKIMPublicKeyHashValid(string memory domainName, bytes32 publicKeyHash) external view returns (bool) {
        return known[keccak256(abi.encode(domainName, publicKeyHash))];
    }
}

/// @dev An owner contract for which one fixed number means "add this passkey". ZK Email's published proofs are of
/// real emails that approve a fixed number each, and no passkey can be found to match it. Everything else is the
/// owner contract as it is.
contract EmailOwnerWithFixedCommand is EmailOwner {
    bytes32 immutable COMMAND;

    constructor(IEmailProofVerifier emailVerifier, uint64 enrolDelay, bytes32 command)
        EmailOwner(emailVerifier, enrolDelay)
    {
        COMMAND = command;
    }

    function enrolCommand(bytes32, bytes32) public view override returns (bytes32) {
        return COMMAND;
    }
}

/**
 * @dev Real proofs, of real emails that people sent from Gmail, checked by ZK Email's verifier.
 *
 * The proofs are the ones ZK Email publish with their own tests: each is a reply whose body says
 * "signHash <number>". They verify against ZK Email's test verification key, so their test verifier is used here.
 */
contract ZKEmailVerifierTest is Passkeys {
    uint256 constant PHONE = 0x1111;

    Verifier zkEmail;
    MailKeyList mailKeys;
    ZKEmailVerifier verifier;

    /// The reply ZK Email publish as their first case: who sent it, what it approves, and the proof.
    EmailProof email;
    bytes32 emailId;
    bytes32 approved;
    bytes proof;

    function setUp() public {
        EmailAuthMsg memory fixture = EmailAuthMsgFixtures.getCase1();
        email = fixture.proof;
        emailId = email.accountSalt;
        approved = abi.decode(fixture.commandParams[0], (bytes32));
        proof = abi.encode(uint256(0), email);
        // An hour after the email was sent.
        vm.warp(email.timestamp + 1 hours);

        zkEmail = Verifier(
            address(
                new ERC1967Proxy(
                    address(new Verifier()),
                    abi.encodeCall(Verifier.initialize, (address(this), address(new Groth16Verifier())))
                )
            )
        );
        mailKeys = new MailKeyList();
        mailKeys.add("gmail.com", email.publicKeyHash);
        verifier = new ZKEmailVerifier(zkEmail, mailKeys, 1 days);
    }

    function test_ARealEmail_IsAccepted_ForWhatItApproves() public view {
        assertEq(email.domainName, "gmail.com");
        assertEq(verifier.verify(emailId, approved, proof), email.emailNullifier);
    }

    function test_ASecondRealEmail_FromAnotherMember_IsAccepted() public {
        EmailAuthMsg memory other = EmailAuthMsgFixtures.getCase2();
        vm.warp(other.proof.timestamp + 1 hours);
        bytes32 otherApproved = abi.decode(other.commandParams[0], (bytes32));
        bytes memory otherProof = abi.encode(uint256(0), other.proof);

        assertEq(verifier.verify(other.proof.accountSalt, otherApproved, otherProof), other.proof.emailNullifier);
        // One member's email says nothing for another.
        vm.expectRevert(ZKEmailVerifier.WrongEmail.selector);
        verifier.verify(emailId, otherApproved, otherProof);
    }

    function test_RevertsWhen_TheEmailApprovedSomethingElse() public {
        vm.expectRevert(ZKEmailVerifier.WrongCommand.selector);
        verifier.verify(emailId, bytes32(uint256(approved) + 1), proof);
    }

    function test_RevertsWhen_TheMailProvidersKeyIsNotOnTheList() public {
        ZKEmailVerifier strict = new ZKEmailVerifier(zkEmail, new MailKeyList(), 1 days);
        vm.expectRevert(ZKEmailVerifier.UnknownMailKey.selector);
        strict.verify(emailId, approved, proof);
    }

    function test_RevertsWhen_TheEmailIsOld_OrFromTheFuture() public {
        vm.warp(email.timestamp + 1 days + 1);
        vm.expectRevert(ZKEmailVerifier.EmailNotRecent.selector);
        verifier.verify(emailId, approved, proof);

        vm.warp(email.timestamp - 1 hours);
        vm.expectRevert(ZKEmailVerifier.EmailNotRecent.selector);
        verifier.verify(emailId, approved, proof);
    }

    /// What is claimed about the email is part of what the proof proves. Change any of it and the proof fails.
    function test_RevertsWhen_AnythingClaimedAboutTheEmailIsChanged() public {
        EmailProof memory changed = email;
        changed.emailNullifier = bytes32(uint256(email.emailNullifier) ^ 1);
        _expectInvalid(emailId, approved, changed);

        changed = email;
        changed.timestamp = email.timestamp + 1;
        _expectInvalid(emailId, approved, changed);

        // Claiming the email approved another number, and asking for that number.
        changed = email;
        changed.maskedCommand = string.concat("signHash ", vm.toString(uint256(approved) + 1));
        _expectInvalid(emailId, bytes32(uint256(approved) + 1), changed);

        // Claiming it came from another member.
        changed = email;
        changed.accountSalt = bytes32(uint256(emailId) ^ 1);
        _expectInvalid(changed.accountSalt, approved, changed);

        changed = email;
        changed.isCodeExist = false;
        vm.expectRevert(ZKEmailVerifier.CodeMissing.selector);
        verifier.verify(emailId, approved, abi.encode(uint256(0), changed));
    }

    function test_RevertsWhen_TheCommandIsOnlyPartOfWhatWasSent() public {
        // Skipping characters is for what a mail program puts in front. It cannot turn one number into another.
        vm.expectRevert(ZKEmailVerifier.WrongCommand.selector);
        verifier.verify(emailId, approved, abi.encode(uint256(1), email));
    }

    // Through the owner contract

    function test_ARealEmail_AddsADevice_AndThatDevicesPasskeyThenSigns() public {
        EmailOwner owner = _ownerFor(emailId, approved);
        (bytes32 qx, bytes32 qy) = _publicKey(PHONE);

        vm.prank(makeAddr("RELAYER"));
        bytes32 keyId = owner.enrol(qx, qy, proof);

        assertTrue(owner.isActive(keyId));
        bytes32 hash = keccak256("a grant");
        assertEq(owner.isValidSignature(hash, _passkeySign(PHONE, hash)), bytes4(0x1626ba7e));
    }

    function test_ARealEmail_WorksOnce() public {
        EmailOwner owner = _ownerFor(emailId, approved);
        (bytes32 qx, bytes32 qy) = _publicKey(PHONE);
        owner.enrol(qx, qy, proof);

        (bytes32 otherX, bytes32 otherY) = _publicKey(0x2222);
        vm.expectRevert(EmailOwner.ProofUsed.selector);
        owner.enrol(otherX, otherY, proof);
    }

    function test_ARealEmail_AddsNothingToAnotherMembersAccount() public {
        EmailOwner someoneElse = _ownerFor(keccak256("another member"), approved);
        (bytes32 qx, bytes32 qy) = _publicKey(PHONE);
        vm.expectRevert(ZKEmailVerifier.WrongEmail.selector);
        someoneElse.enrol(qx, qy, proof);
    }

    function _expectInvalid(bytes32 forEmail, bytes32 command, EmailProof memory changed) internal {
        vm.expectRevert(ZKEmailVerifier.InvalidProof.selector);
        verifier.verify(forEmail, command, abi.encode(uint256(0), changed));
    }

    function _ownerFor(bytes32 forEmail, bytes32 command) internal returns (EmailOwner owner) {
        owner = EmailOwner(Clones.clone(address(new EmailOwnerWithFixedCommand(verifier, 2 days, command))));
        owner.initialize(forEmail);
    }
}
