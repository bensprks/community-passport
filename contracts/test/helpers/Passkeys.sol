// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/// @dev Passkeys for tests, made and used the way a browser would: a P-256 key signs what WebAuthn says a passkey
/// signs, with the value to approve as the challenge.
abstract contract Passkeys is Test {
    uint256 constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    function _publicKey(uint256 privateKey) internal pure returns (bytes32, bytes32) {
        (uint256 x, uint256 y) = vm.publicKeyP256(privateKey);
        return (bytes32(x), bytes32(y));
    }

    function _passkeySign(uint256 privateKey, bytes32 hash) internal pure returns (bytes memory) {
        return _passkeySign(privateKey, hash, 0x05);
    }

    /// @dev What a passkey returns when a page asks it to sign `hash` as the challenge, packed the way EmailOwner
    /// reads it. `flags` 0x05 is "the member was present and was checked".
    function _passkeySign(uint256 privateKey, bytes32 hash, bytes1 flags) internal pure returns (bytes memory) {
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(hash)),
            '","origin":"https://passport.example","crossOrigin":false}'
        );
        bytes memory authenticatorData = abi.encodePacked(sha256("passport.example"), flags, uint32(0));
        (bytes32 r, bytes32 s) =
            vm.signP256(privateKey, sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON)))));
        // Passkeys return either of two equivalent values of s. Contracts accept the lower one.
        if (uint256(s) > P256_N / 2) {
            s = bytes32(P256_N - uint256(s));
        }
        (bytes32 qx, bytes32 qy) = _publicKey(privateKey);
        return abi.encode(
            keccak256(abi.encode(qx, qy)),
            WebAuthn.WebAuthnAuth({
                r: r,
                s: s,
                challengeIndex: 23,
                typeIndex: 1,
                authenticatorData: authenticatorData,
                clientDataJSON: clientDataJSON
            })
        );
    }
}
