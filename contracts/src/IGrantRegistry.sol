// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice One function on one contract.
struct Scope {
    address target;
    bytes4 selector;
}

/// @notice Lets an app act for a Lens Account within a scope the Account's owner signed, until an expiry.
///
/// The registry is added to an Account once, as an account manager that can execute transactions and nothing else.
/// On its own that gives nobody any power: the registry only forwards a call when the caller holds a grant for that
/// Account that has not expired, and the call is to a function in the grant's scope.
interface IGrantRegistry {
    event ScopeDefined(bytes32 indexed scopeId, Scope[] scopes);
    event Granted(address indexed account, address indexed grantee, bytes32 indexed scopeId, uint64 expiry);
    event Revoked(address indexed account, address indexed grantee);
    event RevokedAll(address indexed account);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);
    event PausedSet(bool paused);

    error NotGuardian();
    error RegistryPaused();
    error InvalidAddress();
    error InvalidScope();
    error UnknownScope();
    error InvalidExpiry();
    error NotOwner();
    error NotOwnerOrGrantee();
    error SignatureExpired();
    error NonceUsed();
    error InvalidSignature();
    error GrantNotActive();
    error NotInScope();

    // Scopes

    /// @notice Stores a list of functions under its hash, so that grants can point at it. Anyone can call this, and
    /// a scope never changes once defined. Defining the same list again is a no-op.
    /// @return scopeId The EIP-712 hash of the list, see `hashScopes`.
    function defineScope(Scope[] calldata scopes) external returns (bytes32 scopeId);

    /// @notice The id of a list of functions: the hash EIP-712 gives a `Scope[]` field. It depends on the order.
    function hashScopes(Scope[] calldata scopes) external pure returns (bytes32);

    // Grants

    /// @notice Grants `grantee` the scope on `account` until `expiry`, replacing any grant it had. Only the
    /// Account's owner can call this.
    function grant(address account, address grantee, bytes32 scopeId, uint64 expiry) external;

    /// @notice The same as `grant`, for anyone to submit with the owner's EIP-712 signature over
    /// `Grant(address account,address grantee,Scope[] scopes,uint64 expiry,uint256 nonce,uint256 deadline)`.
    /// The signed message carries the whole list of functions, so the owner sees what they approve.
    function grantWithSig(
        address account,
        address grantee,
        bytes32 scopeId,
        uint64 expiry,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external;

    /// @notice Ends a grant. The Account's owner can call this, and so can the grantee itself, e.g. after its key
    /// leaked.
    function revoke(address account, address grantee) external;

    /// @notice The same as `revoke`, for anyone to submit with the owner's EIP-712 signature over
    /// `Revoke(address account,address grantee,uint256 nonce,uint256 deadline)`.
    function revokeWithSig(address account, address grantee, uint256 nonce, uint256 deadline, bytes calldata signature)
        external;

    /// @notice Ends every grant on `account` at once, including ones to grantees nobody remembers. Grants made
    /// afterwards work as usual. Only the Account's owner can call this.
    function revokeAll(address account) external;

    /// @notice The same as `revokeAll`, for anyone to submit with the owner's EIP-712 signature over
    /// `RevokeAll(address account,uint256 nonce,uint256 deadline)`.
    function revokeAllWithSig(address account, uint256 nonce, uint256 deadline, bytes calldata signature) external;

    // Acting

    /// @notice Has `account` call `target` with `data`, sending no value. The caller must hold a grant on the
    /// Account that has not expired, with the called function in its scope.
    /// @return What the call returned.
    function execute(address account, address target, bytes calldata data) external returns (bytes memory);

    // Guardian

    /// @notice Stops or resumes new grants and `execute`. Revoking always works. Only the guardian can call this.
    function setPaused(bool paused) external;

    /// @notice Hands the guardian role to another address. Only the guardian can call this.
    function setGuardian(address newGuardian) external;

    // Views

    /// @notice The grant `grantee` holds on `account`. Both values are zero if there is none, or if it was ended.
    function grantOf(address account, address grantee) external view returns (bytes32 scopeId, uint64 expiry);

    /// @notice Whether `grantee` could have `account` call that function right now.
    function isAllowed(address account, address grantee, address target, bytes4 selector) external view returns (bool);

    function isScopeDefined(bytes32 scopeId) external view returns (bool);

    function inScope(bytes32 scopeId, address target, bytes4 selector) external view returns (bool);

    function isNonceUsed(address account, uint256 nonce) external view returns (bool);

    function guardian() external view returns (address);

    function paused() external view returns (bool);

    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
