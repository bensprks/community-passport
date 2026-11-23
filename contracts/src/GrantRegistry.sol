// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IGrantRegistry, Scope} from "./IGrantRegistry.sol";

/// @dev The two functions of a Lens Account the registry uses.
interface ILensAccount {
    function owner() external view returns (address);

    function executeTransaction(address target, uint256 value, bytes calldata data)
        external
        payable
        returns (bytes memory);
}

/**
 * @notice See IGrantRegistry.
 *
 * What the registry can never do, whatever is granted:
 * - send value: `execute` always forwards 0;
 * - call a function outside a scope the Account's owner approved;
 * - act once a grant expired or was revoked;
 * - anything an account manager without transfer permissions cannot, e.g. manage the Account's managers or owner.
 *
 * Deployed behind a TransparentUpgradeableProxy, so the address Accounts add as their manager stays the same when
 * the logic is upgraded. Nothing in the logic can upgrade it, and the guardian can only pause and resume.
 */
contract GrantRegistry is IGrantRegistry, Initializable {
    struct GrantData {
        bytes32 scopeId;
        uint64 expiry;
    }

    struct Storage {
        address guardian;
        bool paused;
        mapping(bytes32 scopeId => bool) scopeDefined;
        // Each function of a scope, as its target and selector packed together, see _functionKey.
        mapping(bytes32 scopeId => mapping(bytes32 functionKey => bool)) inScope;
        mapping(address account => mapping(address grantee => GrantData)) grants;
        // Owners pick any unused number, so that signatures can be submitted in any order.
        mapping(address account => mapping(uint256 nonce => bool)) nonceUsed;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("community-passport.storage.GrantRegistry")) - 1)) & ~0xff
    bytes32 private constant STORAGE_LOCATION = 0x3d53b95c24a4e0c2e2fab880a904a81d0afef539a653a6fedc3808df17c9a900;

    /// @notice Grants last a year at most, so that one nobody renews ends by itself.
    uint64 public constant MAX_GRANT_DURATION = 365 days;
    uint256 public constant MAX_SCOPE_SIZE = 32;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("GrantRegistry");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant SCOPE_TYPEHASH = keccak256("Scope(address target,bytes4 selector)");
    bytes32 private constant GRANT_TYPEHASH = keccak256(
        "Grant(address account,address grantee,Scope[] scopes,uint64 expiry,uint256 nonce,uint256 deadline)"
        "Scope(address target,bytes4 selector)"
    );
    bytes32 private constant REVOKE_TYPEHASH =
        keccak256("Revoke(address account,address grantee,uint256 nonce,uint256 deadline)");

    function $storage() private pure returns (Storage storage _storage) {
        assembly {
            _storage.slot := STORAGE_LOCATION
        }
    }

    modifier onlyGuardian() {
        require(msg.sender == $storage().guardian, NotGuardian());
        _;
    }

    modifier whenNotPaused() {
        require(!$storage().paused, RegistryPaused());
        _;
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address guardian_) external initializer {
        _setGuardian(guardian_);
    }

    // Scopes

    function defineScope(Scope[] calldata scopes) external override returns (bytes32 scopeId) {
        require(scopes.length != 0 && scopes.length <= MAX_SCOPE_SIZE, InvalidScope());
        scopeId = hashScopes(scopes);
        Storage storage $ = $storage();
        if ($.scopeDefined[scopeId]) {
            return scopeId;
        }
        $.scopeDefined[scopeId] = true;
        for (uint256 i = 0; i < scopes.length; i++) {
            require(scopes[i].target != address(0), InvalidScope());
            $.inScope[scopeId][_functionKey(scopes[i].target, scopes[i].selector)] = true;
        }
        emit ScopeDefined(scopeId, scopes);
    }

    function hashScopes(Scope[] calldata scopes) public pure override returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](scopes.length);
        for (uint256 i = 0; i < scopes.length; i++) {
            hashes[i] = keccak256(abi.encode(SCOPE_TYPEHASH, scopes[i].target, scopes[i].selector));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    // Grants

    function grant(address account, address grantee, bytes32 scopeId, uint64 expiry) external override {
        require(msg.sender == ILensAccount(account).owner(), NotOwner());
        _grant(account, grantee, scopeId, expiry);
    }

    function grantWithSig(
        address account,
        address grantee,
        bytes32 scopeId,
        uint64 expiry,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external override {
        // `scopeId` is the hash EIP-712 gives the message's `scopes` field, so the owner signed the list itself.
        bytes32 structHash = keccak256(abi.encode(GRANT_TYPEHASH, account, grantee, scopeId, expiry, nonce, deadline));
        _useOwnerSignature(account, structHash, nonce, deadline, signature);
        _grant(account, grantee, scopeId, expiry);
    }

    function revoke(address account, address grantee) external override {
        require(msg.sender == grantee || msg.sender == ILensAccount(account).owner(), NotOwnerOrGrantee());
        _revoke(account, grantee);
    }

    function revokeWithSig(address account, address grantee, uint256 nonce, uint256 deadline, bytes calldata signature)
        external
        override
    {
        bytes32 structHash = keccak256(abi.encode(REVOKE_TYPEHASH, account, grantee, nonce, deadline));
        _useOwnerSignature(account, structHash, nonce, deadline, signature);
        _revoke(account, grantee);
    }

    // Acting

    function execute(address account, address target, bytes calldata data)
        external
        override
        whenNotPaused
        returns (bytes memory)
    {
        Storage storage $ = $storage();
        GrantData storage grantData = $.grants[account][msg.sender];
        // An expiry of 0 means there is no grant.
        require(grantData.expiry > block.timestamp, GrantNotActive());
        // Calls without a function selector, e.g. plain transfers, are never in a scope.
        require(data.length >= 4 && $.inScope[grantData.scopeId][_functionKey(target, bytes4(data[:4]))], NotInScope());
        return ILensAccount(account).executeTransaction(target, 0, data);
    }

    // Guardian

    function setPaused(bool paused_) external override onlyGuardian {
        $storage().paused = paused_;
        emit PausedSet(paused_);
    }

    function setGuardian(address newGuardian) external override onlyGuardian {
        _setGuardian(newGuardian);
    }

    // Views

    function grantOf(address account, address grantee) external view override returns (bytes32 scopeId, uint64 expiry) {
        GrantData storage grantData = $storage().grants[account][grantee];
        return (grantData.scopeId, grantData.expiry);
    }

    function isAllowed(address account, address grantee, address target, bytes4 selector)
        external
        view
        override
        returns (bool)
    {
        Storage storage $ = $storage();
        GrantData storage grantData = $.grants[account][grantee];
        return
            !$.paused && grantData.expiry > block.timestamp
                && $.inScope[grantData.scopeId][_functionKey(target, selector)];
    }

    function isScopeDefined(bytes32 scopeId) external view override returns (bool) {
        return $storage().scopeDefined[scopeId];
    }

    function inScope(bytes32 scopeId, address target, bytes4 selector) external view override returns (bool) {
        return $storage().inScope[scopeId][_functionKey(target, selector)];
    }

    function isNonceUsed(address account, uint256 nonce) external view override returns (bool) {
        return $storage().nonceUsed[account][nonce];
    }

    function guardian() external view override returns (address) {
        return $storage().guardian;
    }

    function paused() external view override returns (bool) {
        return $storage().paused;
    }

    /// @dev Computed on each call, so that it is right behind a proxy and after a chain fork.
    function DOMAIN_SEPARATOR() public view override returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    // Internal

    function _grant(address account, address grantee, bytes32 scopeId, uint64 expiry) internal whenNotPaused {
        Storage storage $ = $storage();
        require(grantee != address(0), InvalidAddress());
        require($.scopeDefined[scopeId], UnknownScope());
        require(expiry > block.timestamp && expiry - block.timestamp <= MAX_GRANT_DURATION, InvalidExpiry());
        $.grants[account][grantee] = GrantData({scopeId: scopeId, expiry: expiry});
        emit Granted(account, grantee, scopeId, expiry);
    }

    function _revoke(address account, address grantee) internal {
        delete $storage().grants[account][grantee];
        emit Revoked(account, grantee);
    }

    /// @dev Checks the Account's current owner signed `structHash`, and spends the nonce. The owner can be a
    /// contract (ERC-1271). The digest commits to this chain and this address, and `structHash` to the Account.
    function _useOwnerSignature(
        address account,
        bytes32 structHash,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        Storage storage $ = $storage();
        require(block.timestamp <= deadline, SignatureExpired());
        require(!$.nonceUsed[account][nonce], NonceUsed());
        $.nonceUsed[account][nonce] = true;
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        require(_isSignedBy(ILensAccount(account).owner(), digest, signature), InvalidSignature());
    }

    /// @dev A plain key's signature first, also when the owner's address has code (an EIP-7702 account whose key
    /// still signs). Otherwise the owner is asked as a contract wallet (ERC-1271).
    function _isSignedBy(address signer, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        (address recovered, ECDSA.RecoverError recoverError,) = ECDSA.tryRecoverCalldata(digest, signature);
        return (recoverError == ECDSA.RecoverError.NoError && recovered == signer)
            || SignatureChecker.isValidERC1271SignatureNowCalldata(signer, digest, signature);
    }

    function _setGuardian(address newGuardian) internal {
        require(newGuardian != address(0), InvalidAddress());
        Storage storage $ = $storage();
        emit GuardianChanged($.guardian, newGuardian);
        $.guardian = newGuardian;
    }

    // The target in the first 20 bytes, then the selector.
    function _functionKey(address target, bytes4 selector) internal pure returns (bytes32) {
        return bytes32(bytes20(target)) | (bytes32(selector) >> 160);
    }
}
