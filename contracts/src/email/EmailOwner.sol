// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {IEmailProofVerifier} from "./IEmailProofVerifier.sol";

/**
 * @notice Owns one member's Lens Account in place of a key that somebody would have to hold for them.
 *
 * The member's email address is the root. A proof that they sent an email is the only way to add a device.
 * Each device has a passkey, and a passkey's signature is what this contract accepts day to day: when the grant
 * registry asks whether the Account's owner signed a grant, it is asking this contract (ERC-1271).
 *
 * - The first device is added as soon as the email is proven.
 * - A later device added by email only starts working after a delay. Any device that already works can remove
 *   it in that time, so a stolen inbox alone does not take the Account over.
 * - Nothing here can be done by whoever runs the sign-in service. It relays, and it cannot forge an email.
 *
 * One of these is deployed per member, as a minimal clone, by EmailOwnerFactory.
 */
contract EmailOwner is Initializable {
    struct DeviceKey {
        bytes32 qx;
        bytes32 qy;
        // When the key starts working. Zero means there is no such key.
        uint64 activeFrom;
    }

    event DeviceEnrolled(bytes32 indexed keyId, bytes32 qx, bytes32 qy, uint64 activeFrom);
    event DeviceRemoved(bytes32 indexed keyId);
    event Executed(address indexed target, bytes data);

    error InvalidKey();
    error AlreadyEnrolled();
    error UnknownKey();
    error ProofUsed();
    error SignatureExpired();
    error NonceUsed();
    error InvalidSignature();

    /// @notice What checks that the member sent an email.
    IEmailProofVerifier public immutable EMAIL_VERIFIER;
    /// @notice How long a device added by email waits before it works, when the member already has a device.
    uint64 public immutable ENROL_DELAY;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant ENROL_TYPEHASH = keccak256("Enrol(bytes32 qx,bytes32 qy)");
    bytes32 private constant REMOVE_TYPEHASH = keccak256("Remove(bytes32 keyId,uint256 nonce,uint256 deadline)");
    bytes32 private constant EXECUTE_TYPEHASH =
        keccak256("Execute(address target,bytes data,uint256 nonce,uint256 deadline)");

    /// @notice Stands for the member's email address, see IEmailProofVerifier.
    bytes32 public emailId;
    /// @notice How many devices the member has, counting ones still waiting out the delay.
    uint256 public keyCount;
    mapping(bytes32 keyId => DeviceKey) private _keys;
    mapping(bytes32 proofId => bool) private _proofUsed;
    mapping(uint256 nonce => bool) private _nonceUsed;

    constructor(IEmailProofVerifier emailVerifier, uint64 enrolDelay) {
        EMAIL_VERIFIER = emailVerifier;
        ENROL_DELAY = enrolDelay;
        _disableInitializers();
    }

    function initialize(bytes32 emailId_) external initializer {
        emailId = emailId_;
    }

    // Devices

    /// @notice Adds a device's passkey, given a proof that the member sent an email approving `enrolCommand`.
    /// Anyone can submit it.
    function enrol(bytes32 qx, bytes32 qy, bytes calldata emailProof) external returns (bytes32 keyId) {
        require(P256.isValidPublicKey(qx, qy), InvalidKey());
        keyId = keyIdOf(qx, qy);
        require(_keys[keyId].activeFrom == 0, AlreadyEnrolled());

        bytes32 proofId = EMAIL_VERIFIER.verify(emailId, enrolCommand(qx, qy), emailProof);
        require(!_proofUsed[proofId], ProofUsed());
        _proofUsed[proofId] = true;

        // With no device yet there is nobody to object, so the first one works at once.
        uint64 activeFrom = uint64(block.timestamp) + (keyCount == 0 ? 0 : ENROL_DELAY);
        _keys[keyId] = DeviceKey({qx: qx, qy: qy, activeFrom: activeFrom});
        keyCount++;
        emit DeviceEnrolled(keyId, qx, qy, activeFrom);
    }

    /// @notice What the member's email has to approve to add this passkey. It names this chain and this contract,
    /// so an email is good for one member's owner contract only.
    function enrolCommand(bytes32 qx, bytes32 qy) public view virtual returns (bytes32) {
        return _typedDigest(keccak256(abi.encode(ENROL_TYPEHASH, qx, qy)));
    }

    /// @notice Removes a device, working or still waiting, with the signature of a device that works. A device can
    /// remove itself.
    function remove(bytes32 keyId, uint256 nonce, uint256 deadline, bytes calldata signature) external {
        _useDeviceSignature(keccak256(abi.encode(REMOVE_TYPEHASH, keyId, nonce, deadline)), nonce, deadline, signature);
        require(_keys[keyId].activeFrom != 0, UnknownKey());
        delete _keys[keyId];
        keyCount--;
        emit DeviceRemoved(keyId);
    }

    // Acting as the owner

    /// @notice Whether `signature` is a working device's passkey signature over `hash` (ERC-1271). This is how the
    /// grant registry learns that the Account's owner approved a grant.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _isDeviceSignature(hash, signature) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    /// @notice Has this contract call `target`, with the signature of a device that works. It is how the member
    /// uses what only the Account's owner can do, such as moving the Account to another owner. It sends no value.
    function execute(address target, bytes calldata data, uint256 nonce, uint256 deadline, bytes calldata signature)
        external
        returns (bytes memory)
    {
        _useDeviceSignature(
            keccak256(abi.encode(EXECUTE_TYPEHASH, target, keccak256(data), nonce, deadline)),
            nonce,
            deadline,
            signature
        );
        emit Executed(target, data);
        return Address.functionCall(target, data);
    }

    // Views

    function keyIdOf(bytes32 qx, bytes32 qy) public pure returns (bytes32) {
        return keccak256(abi.encode(qx, qy));
    }

    function deviceKey(bytes32 keyId) external view returns (bytes32 qx, bytes32 qy, uint64 activeFrom) {
        DeviceKey storage key = _keys[keyId];
        return (key.qx, key.qy, key.activeFrom);
    }

    /// @notice Whether that device's passkey is accepted right now.
    function isActive(bytes32 keyId) public view returns (bool) {
        uint64 activeFrom = _keys[keyId].activeFrom;
        return activeFrom != 0 && activeFrom <= block.timestamp;
    }

    function isNonceUsed(uint256 nonce) external view returns (bool) {
        return _nonceUsed[nonce];
    }

    /// @notice The digest a device signs to remove a device.
    function removeDigest(bytes32 keyId, uint256 nonce, uint256 deadline) external view returns (bytes32) {
        return _typedDigest(keccak256(abi.encode(REMOVE_TYPEHASH, keyId, nonce, deadline)));
    }

    /// @notice The digest a device signs to have this contract make a call.
    function executeDigest(address target, bytes calldata data, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _typedDigest(keccak256(abi.encode(EXECUTE_TYPEHASH, target, keccak256(data), nonce, deadline)));
    }

    // Internal

    function _useDeviceSignature(bytes32 structHash, uint256 nonce, uint256 deadline, bytes calldata signature)
        internal
    {
        require(block.timestamp <= deadline, SignatureExpired());
        require(!_nonceUsed[nonce], NonceUsed());
        _nonceUsed[nonce] = true;
        require(_isDeviceSignature(_typedDigest(structHash), signature), InvalidSignature());
    }

    /// @dev `signature` is `abi.encode(keyId, WebAuthnAuth)`: which device, and what its passkey returned when
    /// asked to sign `hash` as the challenge. The passkey must have checked the member (a fingerprint, a PIN).
    function _isDeviceSignature(bytes32 hash, bytes calldata signature) internal view returns (bool) {
        (bytes32 keyId, WebAuthn.WebAuthnAuth memory auth) = abi.decode(signature, (bytes32, WebAuthn.WebAuthnAuth));
        if (!isActive(keyId)) {
            return false;
        }
        DeviceKey storage key = _keys[keyId];
        return WebAuthn.verify(abi.encodePacked(hash), auth, key.qx, key.qy, true);
    }

    /// @dev Commits to this chain and this contract.
    function _typedDigest(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("EmailOwner"), keccak256("1"), block.chainid, address(this))
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
