// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {EmailOwner} from "../src/email/EmailOwner.sol";
import {IEmailProofVerifier} from "../src/email/IEmailProofVerifier.sol";
import {IHonkVerifier, NoirEmailVerifier} from "../src/email/NoirEmailVerifier.sol";
import {IDKIMRegistry} from "../src/email/ZKEmailVerifier.sol";
import {HonkVerifier} from "../src/email/noir/HonkVerifier.sol";
import {NoirEmailFixture as Fixture} from "./fixtures/noir/NoirEmailFixture.sol";
import {Passkeys} from "./helpers/Passkeys.sol";
import {EmailOwnerWithFixedCommand, MailKeyList} from "./ZKEmailVerifier.t.sol";

/**
 * @dev A real proof, made with the Noir circuit, of a real email sent from Gmail, checked by the contract
 * generated from that circuit. `circuits/scripts/prove.mjs` makes the proof and writes it to the fixture.
 */
contract NoirEmailVerifierTest is Passkeys {
    uint256 constant PHONE = 0x1111;

    MailKeyList mailKeys;
    NoirEmailVerifier verifier;
    bytes proof;

    function setUp() public {
        // An hour after the email was sent.
        vm.warp(Fixture.TIMESTAMP + 1 hours);
        mailKeys = new MailKeyList();
        mailKeys.add("gmail.com", Fixture.KEY_HASH);
        verifier = new NoirEmailVerifier(IHonkVerifier(address(new HonkVerifier())), mailKeys, 1 days);
        proof = _proof(Fixture.PROOF, Fixture.KEY_HASH, Fixture.DOMAIN_0, Fixture.NULLIFIER, Fixture.TIMESTAMP);
    }

    function test_ARealEmail_IsAccepted_ForWhatItApproves() public view {
        assertEq(verifier.verify(Fixture.EMAIL_ID, Fixture.APPROVED, proof), Fixture.NULLIFIER);
    }

    function test_RevertsWhen_AskedAboutAnotherCommandOrAnotherMember() public {
        vm.expectRevert(NoirEmailVerifier.InvalidProof.selector);
        verifier.verify(Fixture.EMAIL_ID, bytes32(uint256(Fixture.APPROVED) + 1), proof);

        vm.expectRevert(NoirEmailVerifier.InvalidProof.selector);
        verifier.verify(bytes32(uint256(Fixture.EMAIL_ID) ^ 1), Fixture.APPROVED, proof);
    }

    function test_RevertsWhen_TheMailProvidersKeyIsNotOnTheList() public {
        NoirEmailVerifier strict = new NoirEmailVerifier(verifier.PROOF_VERIFIER(), new MailKeyList(), 1 days);
        vm.expectRevert(NoirEmailVerifier.UnknownMailKey.selector);
        strict.verify(Fixture.EMAIL_ID, Fixture.APPROVED, proof);

        // The right key, listed for another domain only.
        MailKeyList elsewhere = new MailKeyList();
        elsewhere.add("example.com", Fixture.KEY_HASH);
        strict = new NoirEmailVerifier(verifier.PROOF_VERIFIER(), elsewhere, 1 days);
        vm.expectRevert(NoirEmailVerifier.UnknownMailKey.selector);
        strict.verify(Fixture.EMAIL_ID, Fixture.APPROVED, proof);
    }

    function test_RevertsWhen_TheEmailIsOld_OrFromTheFuture() public {
        vm.warp(Fixture.TIMESTAMP + 1 days + 1);
        vm.expectRevert(NoirEmailVerifier.EmailNotRecent.selector);
        verifier.verify(Fixture.EMAIL_ID, Fixture.APPROVED, proof);

        vm.warp(Fixture.TIMESTAMP - 1 hours);
        vm.expectRevert(NoirEmailVerifier.EmailNotRecent.selector);
        verifier.verify(Fixture.EMAIL_ID, Fixture.APPROVED, proof);
    }

    /// What is claimed about the email is part of what the proof proves. Change any of it and the proof fails.
    function test_RevertsWhen_AnythingClaimedAboutTheEmailIsChanged() public {
        bytes32 flipped = bytes32(uint256(Fixture.NULLIFIER) ^ 1);
        _expectInvalid(_proof(Fixture.PROOF, Fixture.KEY_HASH, Fixture.DOMAIN_0, flipped, Fixture.TIMESTAMP));
        // A later time, to pass an old email off as a recent one.
        _expectInvalid(
            _proof(Fixture.PROOF, Fixture.KEY_HASH, Fixture.DOMAIN_0, Fixture.NULLIFIER, Fixture.TIMESTAMP + 60)
        );

        // Another provider's key, listed, and another domain, listed with Gmail's key.
        bytes32 otherKey = bytes32(uint256(Fixture.KEY_HASH) ^ 1);
        mailKeys.add("gmail.com", otherKey);
        _expectInvalid(_proof(Fixture.PROOF, otherKey, Fixture.DOMAIN_0, Fixture.NULLIFIER, Fixture.TIMESTAMP));
        mailKeys.add("hmail.com", Fixture.KEY_HASH);
        bytes32 otherDomain = bytes32(uint256(Fixture.DOMAIN_0) + 1);
        _expectInvalid(_proof(Fixture.PROOF, Fixture.KEY_HASH, otherDomain, Fixture.NULLIFIER, Fixture.TIMESTAMP));

        // And the proof itself.
        bytes memory tampered = Fixture.PROOF;
        tampered[400] = bytes1(uint8(tampered[400]) ^ 1);
        _expectInvalid(_proof(tampered, Fixture.KEY_HASH, Fixture.DOMAIN_0, Fixture.NULLIFIER, Fixture.TIMESTAMP));
    }

    // Through the owner contract

    function test_ARealEmail_AddsADevice_AndThatDevicesPasskeyThenSigns() public {
        EmailOwner owner = _ownerFor(Fixture.EMAIL_ID);
        (bytes32 qx, bytes32 qy) = _publicKey(PHONE);

        vm.prank(makeAddr("RELAYER"));
        bytes32 keyId = owner.enrol(qx, qy, proof);

        assertTrue(owner.isActive(keyId));
        bytes32 hash = keccak256("a grant");
        assertEq(owner.isValidSignature(hash, _passkeySign(PHONE, hash)), bytes4(0x1626ba7e));

        // The same email adds nothing more.
        (bytes32 otherX, bytes32 otherY) = _publicKey(0x2222);
        vm.expectRevert(EmailOwner.ProofUsed.selector);
        owner.enrol(otherX, otherY, proof);
    }

    function test_ARealEmail_AddsNothingToAnotherMembersAccount() public {
        EmailOwner someoneElse = _ownerFor(keccak256("another member") >> 8);
        (bytes32 qx, bytes32 qy) = _publicKey(PHONE);
        vm.expectRevert(NoirEmailVerifier.InvalidProof.selector);
        someoneElse.enrol(qx, qy, proof);
    }

    function _proof(bytes memory honkProof, bytes32 keyHash, bytes32 domain0, bytes32 nullifier, uint256 timestamp)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(honkProof, keyHash, [domain0, Fixture.DOMAIN_1], nullifier, timestamp);
    }

    function _expectInvalid(bytes memory changed) internal {
        vm.expectRevert(NoirEmailVerifier.InvalidProof.selector);
        verifier.verify(Fixture.EMAIL_ID, Fixture.APPROVED, changed);
    }

    /// @dev See EmailOwnerWithFixedCommand: the email approves a fixed number, so the owner contract is told that
    /// this number means "add this passkey".
    function _ownerFor(bytes32 forEmail) internal returns (EmailOwner owner) {
        owner = EmailOwner(
            Clones.clone(
                address(new EmailOwnerWithFixedCommand(IEmailProofVerifier(verifier), 2 days, Fixture.APPROVED))
            )
        );
        owner.initialize(forEmail);
    }
}
