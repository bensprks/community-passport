// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {GrantRegistry} from "../../src/GrantRegistry.sol";
import {IGrantRegistry, Scope} from "../../src/IGrantRegistry.sol";

/// @dev Deploys the registry as it is deployed for real, behind a transparent proxy, and signs its messages the
/// way a wallet would. The hashing here is written out again on purpose, so it checks the contract's.
abstract contract RegistryTestBase is Test {
    bytes32 constant SCOPE_TYPEHASH = keccak256("Scope(address target,bytes4 selector)");
    bytes32 constant GRANT_TYPEHASH = keccak256(
        "Grant(address account,address grantee,Scope[] scopes,uint64 expiry,uint256 nonce,uint256 deadline)Scope(address target,bytes4 selector)"
    );
    bytes32 constant REVOKE_TYPEHASH =
        keccak256("Revoke(address account,address grantee,uint256 nonce,uint256 deadline)");

    bytes32 constant ERC1967_ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    GrantRegistry registry;
    address registryImpl;
    ProxyAdmin proxyAdmin;
    address guardian = makeAddr("GUARDIAN");
    address upgrader = makeAddr("UPGRADER");

    /// @dev The proxy deploys its own ProxyAdmin, owned by `upgrader`, and keeps its address in the ERC-1967 admin slot.
    function _deployRegistry() internal {
        registryImpl = address(new GrantRegistry());
        registry = GrantRegistry(
            address(
                new TransparentUpgradeableProxy(
                    registryImpl, upgrader, abi.encodeCall(GrantRegistry.initialize, (guardian))
                )
            )
        );
        proxyAdmin = ProxyAdmin(address(uint160(uint256(vm.load(address(registry), ERC1967_ADMIN_SLOT)))));
    }

    function _scope(address target, bytes4 selector) internal pure returns (Scope[] memory scopes) {
        scopes = new Scope[](1);
        scopes[0] = Scope(target, selector);
    }

    function _hashScopes(Scope[] memory scopes) internal pure returns (bytes32) {
        bytes memory packed;
        for (uint256 i = 0; i < scopes.length; i++) {
            packed = bytes.concat(packed, keccak256(abi.encode(SCOPE_TYPEHASH, scopes[i].target, scopes[i].selector)));
        }
        return keccak256(packed);
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("GrantRegistry"),
                keccak256("1"),
                block.chainid,
                address(registry)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _sign(uint256 privateKey, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, _digest(structHash));
        return abi.encodePacked(r, s, v);
    }

    function _signGrant(
        uint256 privateKey,
        address account,
        address grantee,
        Scope[] memory scopes,
        uint64 expiry,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        return _sign(
            privateKey,
            keccak256(abi.encode(GRANT_TYPEHASH, account, grantee, _hashScopes(scopes), expiry, nonce, deadline))
        );
    }

    function _signRevoke(uint256 privateKey, address account, address grantee, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(privateKey, keccak256(abi.encode(REVOKE_TYPEHASH, account, grantee, nonce, deadline)));
    }
}
