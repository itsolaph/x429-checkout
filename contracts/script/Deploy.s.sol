// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {X429Checkout} from "../src/X429Checkout.sol";

/// @notice Deploys X429Checkout and opens one queue owned by the operator.
///
///   DEPLOYER_PRIVATE_KEY  pays for the deployment
///   OPERATOR_PRIVATE_KEY  creates the queue and becomes its operator (defaults to the deployer)
///   USDC                  token address (default: native USDC on Base)
///   QUEUE_MAX_LENGTH      default 64
///   QUEUE_FEE_BPS         default 0
///   QUEUE_META            free-form JSON describing the service
///
/// Prints X429_CONTRACT=0x… and X429_QUEUE_ID=… for scripts.
contract Deploy is Script {
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external returns (X429Checkout checkout, uint32 queueId) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 operatorKey = vm.envOr("OPERATOR_PRIVATE_KEY", deployerKey);
        address usdc = vm.envOr("USDC", BASE_USDC);
        uint32 maxLength = uint32(vm.envOr("QUEUE_MAX_LENGTH", uint256(64)));
        uint16 feeBps = uint16(vm.envOr("QUEUE_FEE_BPS", uint256(0)));
        string memory meta = vm.envOr("QUEUE_META", string('{"name":"x429 checkout"}'));

        vm.startBroadcast(deployerKey);
        checkout = new X429Checkout(IERC20(usdc));
        vm.stopBroadcast();

        vm.startBroadcast(operatorKey);
        queueId = checkout.createQueue(maxLength, feeBps, meta);
        vm.stopBroadcast();

        console.log(string.concat("X429_CONTRACT=", vm.toString(address(checkout))));
        console.log(string.concat("X429_QUEUE_ID=", vm.toString(uint256(queueId))));
        console.log(string.concat("X429_OPERATOR=", vm.toString(vm.addr(operatorKey))));
    }
}
