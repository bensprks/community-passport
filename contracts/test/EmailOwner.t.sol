// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Account as LensAccount} from "contracts/extensions/account/Account.sol";
import {AccountManagerPermissions} from "contracts/extensions/account/IAccount.sol";
import {SourceStamp, KeyValue} from "contracts/core/types/Types.sol";
import {NATIVE_TOKEN} from "contracts/core/types/Constants.sol";
import {IOwnable} from "contracts/core/interfaces/IOwnable.sol";
import {IGrantRegistry, Scope} from "../src/IGrantRegistry.sol";
import {AttestedEmailVerifier} from "../src/email/AttestedEmailVerifier.sol";
import {EmailOwner} from "../src/email/EmailOwner.sol";
import {EmailOwnerFactory} from "../src/email/EmailOwnerFactory.sol";
import {RegistryTestBase} from "./helpers/RegistryTestBase.sol";
import {MockTarget} from "./helpers/Mocks.sol";
import {Passkeys} from "./helpers/Passkeys.sol";

/// @dev A member's Lens Account is owned by an EmailOwner. Passkeys are made and used here the way a browser
/// would: a P-256 key signs what WebAuthn says it signs, with the value to approve as the challenge.
contract EmailOwnerTest is RegistryTestBase, Passkeys {
    uint256 constant ATTESTOR_KEY = 0xA77E57;
    uint256 constant PHONE = 0x1111;
    uint256 constant LAPTOP = 0x2222;
    uint256 constant THIEF = 0x3333;
    uint64 constant ENROL_DELAY = 2 days;
    bytes32 constant EMAIL_ID = keccak256("maya@example.com and her secret");

    address club = makeAddr("CLUB");
    address relayer = makeAddr("RELAYER");

    AttestedEmailVerifier verifier;
    EmailOwnerFactory factory;
    EmailOwner owner;
    LensAccount account;
    MockTarget target;
    uint256 nextEmail = 1;

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployRegistry();
        verifier = new AttestedEmailVerifier(vm.addr(ATTESTOR_KEY));
        factory = new EmailOwnerFactory(verifier, ENROL_DELAY);
        owner = EmailOwner(factory.create(EMAIL_ID));
        account = _deployAccount(address(owner));
        target = new MockTarget();
    }

    // Creating

    function test_Create_IsAtAPredictableAddress_AndHarmlessToRepeat() public {
        assertEq(address(owner), factory.ownerFor(EMAIL_ID));
        assertEq(owner.emailId(), EMAIL_ID);
        assertEq(owner.keyCount(), 0);
        assertEq(factory.create(EMAIL_ID), address(owner));

        vm.expectRevert();
        owner.initialize(keccak256("someone else"));
        EmailOwner logic = EmailOwner(factory.IMPLEMENTATION());
        vm.expectRevert();
        logic.initialize(EMAIL_ID);
    }

    // Adding devices

    function test_Enrol_TheFirstDeviceWorksAtOnce_SubmittedByAnyone() public {
        (bytes32 qx, bytes32 qy) = _publicKey(PHONE);
        bytes memory proof = _emailProof(owner, owner.enrolCommand(qx, qy), ATTESTOR_KEY);

        vm.prank(relayer);
        bytes32 keyId = owner.enrol(qx, qy, proof);

        assertTrue(owner.isActive(keyId));
        assertEq(owner.keyCount(), 1);
        assertEq(
            owner.isValidSignature(keccak256("hello"), _passkeySign(PHONE, keccak256("hello"))), bytes4(0x1626ba7e)
        );
    }

    function test_Enrol_ALaterDeviceWaitsOutTheDelay() public {
        _enrol(PHONE);
        bytes32 laptopId = _enrol(LAPTOP);
        bytes32 hash = keccak256("hello");

        assertFalse(owner.isActive(laptopId));
        assertEq(owner.isValidSignature(hash, _passkeySign(LAPTOP, hash)), bytes4(0xffffffff));

        vm.warp(block.timestamp + ENROL_DELAY);
        assertTrue(owner.isActive(laptopId));
        assertEq(owner.isValidSignature(hash, _passkeySign(LAPTOP, hash)), bytes4(0x1626ba7e));
    }

    function test_Enrol_RevertsWhen_TheEmailProofIsNotForThisKeyOrThisMember() public {
        (bytes32 qx, bytes32 qy) = _publicKey(PHONE);
        (bytes32 thiefX, bytes32 thiefY) = _publicKey(THIEF);

        // An email that approved another key.
        bytes memory proof = _emailProof(owner, owner.enrolCommand(qx, qy), ATTESTOR_KEY);
        vm.expectRevert(AttestedEmailVerifier.InvalidProof.selector);
        owner.enrol(thiefX, thiefY, proof);

        // An email from another member, approving the same key on their own owner contract.
        EmailOwner other = EmailOwner(factory.create(keccak256("noor@example.com and her secret")));
        proof = _emailProof(other, other.enrolCommand(qx, qy), ATTESTOR_KEY);
        vm.expectRevert(AttestedEmailVerifier.InvalidProof.selector);
        owner.enrol(qx, qy, proof);

        // Not vouched for by the attestor.
        proof = _emailProof(owner, owner.enrolCommand(qx, qy), THIEF);
        vm.expectRevert(AttestedEmailVerifier.InvalidProof.selector);
        owner.enrol(qx, qy, proof);
    }

    function test_Enrol_RevertsWhen_TheSameEmailIsUsedAgain() public {
        (bytes32 qx, bytes32 qy) = _publicKey(PHONE);
        bytes memory proof = _emailProof(owner, owner.enrolCommand(qx, qy), ATTESTOR_KEY);
        bytes32 keyId = owner.enrol(qx, qy, proof);

        vm.expectRevert(EmailOwner.AlreadyEnrolled.selector);
        owner.enrol(qx, qy, proof);

        // Not even once the device is gone: bringing it back takes a new email.
        owner.remove(
            keyId,
            1,
            block.timestamp + 1 hours,
            _passkeySign(PHONE, owner.removeDigest(keyId, 1, block.timestamp + 1 hours))
        );
        vm.expectRevert(EmailOwner.ProofUsed.selector);
        owner.enrol(qx, qy, proof);
    }

    function test_Enrol_RevertsWhen_TheProofIsOldOrTheKeyIsNotAKey() public {
        (bytes32 qx, bytes32 qy) = _publicKey(PHONE);
        bytes memory proof = _emailProof(owner, owner.enrolCommand(qx, qy), ATTESTOR_KEY);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(AttestedEmailVerifier.ProofExpired.selector);
        owner.enrol(qx, qy, proof);

        vm.expectRevert(EmailOwner.InvalidKey.selector);
        owner.enrol(bytes32(uint256(1)), bytes32(uint256(2)), proof);
    }

    // Removing devices

    function test_Remove_ADeviceThatWorksStopsAStolenInboxInTime() public {
        _enrol(PHONE);
        // Someone who got into the inbox adds their own device. It does not work yet.
        bytes32 thiefId = _enrol(THIEF);
        uint256 deadline = block.timestamp + 1 hours;

        // The thief's device cannot remove the member's while it waits.
        bytes32 phoneId = _keyId(PHONE);
        bytes memory byThief = _passkeySign(THIEF, owner.removeDigest(phoneId, 1, deadline));
        vm.expectRevert(EmailOwner.InvalidSignature.selector);
        owner.remove(phoneId, 1, deadline, byThief);

        // The member's device removes the thief's.
        bytes memory byPhone = _passkeySign(PHONE, owner.removeDigest(thiefId, 2, deadline));
        vm.prank(relayer);
        owner.remove(thiefId, 2, deadline, byPhone);

        vm.warp(block.timestamp + ENROL_DELAY);
        assertFalse(owner.isActive(thiefId));
        assertEq(owner.keyCount(), 1);
    }

    function test_Remove_RevertsWhen_ReplayedExpiredOrUnknown() public {
        bytes32 phoneId = _enrol(PHONE);
        bytes32 laptopId = _keyId(LAPTOP);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory signature = _passkeySign(PHONE, owner.removeDigest(laptopId, 1, deadline));
        vm.expectRevert(EmailOwner.UnknownKey.selector);
        owner.remove(laptopId, 1, deadline, signature);

        signature = _passkeySign(PHONE, owner.removeDigest(phoneId, 2, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(EmailOwner.SignatureExpired.selector);
        owner.remove(phoneId, 2, deadline, signature);

        vm.warp(deadline);
        owner.remove(phoneId, 2, deadline, signature);
        vm.expectRevert(EmailOwner.NonceUsed.selector);
        owner.remove(phoneId, 2, deadline, signature);
    }

    // Signing as the owner

    function test_IsValidSignature_OnlyForAWorkingDeviceOverThatExactHash() public {
        _enrol(PHONE);
        bytes32 hash = keccak256("hello");
        bytes memory signature = _passkeySign(PHONE, hash);

        assertEq(owner.isValidSignature(hash, signature), bytes4(0x1626ba7e));
        assertEq(owner.isValidSignature(keccak256("something else"), signature), bytes4(0xffffffff));
        // A key that was never added, signing correctly.
        assertEq(owner.isValidSignature(hash, _passkeySign(THIEF, hash)), bytes4(0xffffffff));
        // A passkey that did not check the member (no fingerprint, no PIN).
        assertEq(owner.isValidSignature(hash, _passkeySign(PHONE, hash, 0x01)), bytes4(0xffffffff));
    }

    // With the registry and a real Lens Account

    function test_Grant_SignedByAPasskey_LetsTheClubActAsTheAccount() public {
        _enrol(PHONE);
        Scope[] memory scopes = _scope(address(target), MockTarget.ping.selector);
        bytes32 scopeId = registry.defineScope(scopes);
        uint64 expiry = uint64(block.timestamp + 90 days);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 digest =
            _digest(keccak256(abi.encode(GRANT_TYPEHASH, address(account), club, scopeId, expiry, 1, deadline)));

        // Before any passkey signs, nothing: the relayer that created everything has no say.
        bytes memory byThief = _passkeySign(THIEF, digest);
        vm.expectRevert(IGrantRegistry.InvalidSignature.selector);
        registry.grantWithSig(address(account), club, scopeId, expiry, 1, deadline, byThief);

        vm.prank(relayer);
        registry.grantWithSig(address(account), club, scopeId, expiry, 1, deadline, _passkeySign(PHONE, digest));

        vm.prank(club);
        registry.execute(address(account), address(target), abi.encodeCall(MockTarget.ping, (7)));
        assertEq(target.lastCaller(), address(account));
    }

    function test_Execute_LetsTheMemberMoveTheirAccountToAKeyOfTheirOwn() public {
        _enrol(PHONE);
        address newOwner = makeAddr("A_WALLET_THE_MEMBER_HOLDS");
        bytes memory data = abi.encodeCall(IOwnable.transferOwnership, (newOwner));
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory signature = _passkeySign(PHONE, owner.executeDigest(address(account), data, 1, deadline));

        // Not to somewhere else than what was signed.
        vm.expectRevert(EmailOwner.InvalidSignature.selector);
        owner.execute(address(account), abi.encodeCall(IOwnable.transferOwnership, (relayer)), 1, deadline, signature);

        vm.prank(relayer);
        owner.execute(
            address(account),
            data,
            2,
            deadline,
            _passkeySign(PHONE, owner.executeDigest(address(account), data, 2, deadline))
        );
        assertEq(account.owner(), newOwner);
    }

    // Helpers

    function _deployAccount(address accountOwner) internal returns (LensAccount) {
        address[] memory managers = new address[](1);
        AccountManagerPermissions[] memory permissions = new AccountManagerPermissions[](1);
        managers[0] = address(registry);
        permissions[0] = AccountManagerPermissions({
            canExecuteTransactions: true, canTransferTokens: false, canTransferNative: false, canSetMetadataURI: false
        });
        SourceStamp memory noSource;
        address logic = address(new LensAccount(NATIVE_TOKEN, makeAddr("WRAPPED_NATIVE")));
        bytes memory init = abi.encodeCall(
            LensAccount.initialize, (accountOwner, "", managers, permissions, noSource, new KeyValue[](0))
        );
        return LensAccount(payable(address(new ERC1967Proxy(logic, init))));
    }

    function _keyId(uint256 privateKey) internal view returns (bytes32) {
        (bytes32 qx, bytes32 qy) = _publicKey(privateKey);
        return owner.keyIdOf(qx, qy);
    }

    /// @dev Adds a device with a fresh email, vouched for by the attestor.
    function _enrol(uint256 privateKey) internal returns (bytes32) {
        (bytes32 qx, bytes32 qy) = _publicKey(privateKey);
        return owner.enrol(qx, qy, _emailProof(owner, owner.enrolCommand(qx, qy), ATTESTOR_KEY));
    }

    /// @dev What the stand-in verifier takes as proof: the attestor's word that it saw the member's email.
    function _emailProof(EmailOwner forOwner, bytes32 command, uint256 attestorKey) internal returns (bytes memory) {
        bytes32 emailNullifier = bytes32(nextEmail++);
        uint64 validUntil = uint64(block.timestamp + 1 hours);
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AttestedEmailVerifier"),
                keccak256("1"),
                block.chainid,
                address(verifier)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("EmailSeen(bytes32 emailId,bytes32 command,bytes32 emailNullifier,uint64 validUntil)"),
                forOwner.emailId(),
                command,
                emailNullifier,
                validUntil
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(attestorKey, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
        return abi.encode(emailNullifier, validUntil, abi.encodePacked(r, s, v));
    }
}
