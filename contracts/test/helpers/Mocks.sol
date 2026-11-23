// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {GrantRegistry} from "../../src/GrantRegistry.sol";

/// @dev The smallest thing that behaves like a Lens Account towards the registry: an owner, and one manager that
/// can have it call anything.
contract MockAccount {
    address public owner;
    address public manager;
    uint256 public lastValue;

    constructor(address owner_, address manager_) {
        owner = owner_;
        manager = manager_;
    }

    function setOwner(address owner_) external {
        owner = owner_;
    }

    function executeTransaction(address target, uint256 value, bytes calldata data)
        external
        payable
        returns (bytes memory)
    {
        require(msg.sender == manager || msg.sender == owner, "MockAccount: not allowed");
        lastValue = value;
        (bool success, bytes memory returnData) = target.call{value: value}(data);
        require(success, "MockAccount: call failed");
        return returnData;
    }

    receive() external payable {}
}

contract MockTarget {
    address public lastCaller;
    uint256 public lastNumber;
    uint256 public calls;

    function ping(uint256 number) external returns (uint256) {
        lastCaller = msg.sender;
        lastNumber = number;
        calls++;
        return number + 1;
    }

    function other() external {
        calls++;
    }

    receive() external payable {}
}

/// @dev A contract wallet that accepts its signer's signatures (ERC-1271).
contract MockContractWallet {
    address public signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return ECDSA.recover(hash, signature) == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// @dev Stands in for a later version of the logic, to test upgrades.
contract GrantRegistryV2 is GrantRegistry {
    function version() external pure returns (uint256) {
        return 2;
    }
}
