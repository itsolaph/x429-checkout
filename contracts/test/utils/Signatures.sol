// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {X429Checkout, IERC3009} from "../../src/X429Checkout.sol";

/// @notice Builds the payloads a PayBox wallet would sign: EIP-3009 for x402 `exact`, EIP-712 Join/Claim.
library Signatures {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    function authorization(
        address token,
        uint256 pk,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (X429Checkout.Authorization memory a) {
        address from = vm.addr(pk);
        bytes32 structHash =
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC3009(token).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        a = X429Checkout.Authorization(from, value, validAfter, validBefore, nonce, v, r, s);
    }

    function cancelAuthorization(address token, uint256 pk, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, vm.addr(pk), nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC3009(token).DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    function join(X429Checkout c, uint256 pk, uint32 queueId, uint128 skipPrice, bytes32 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(c.JOIN_TYPEHASH(), vm.addr(pk), queueId, skipPrice, nonce, deadline));
        return _sign(c, pk, structHash);
    }

    function claim(X429Checkout c, uint256 pk, address recipient, bytes32 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(c.CLAIM_TYPEHASH(), vm.addr(pk), recipient, nonce, deadline));
        return _sign(c, pk, structHash);
    }

    function _sign(X429Checkout c, uint256 pk, bytes32 structHash) private view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", c.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
