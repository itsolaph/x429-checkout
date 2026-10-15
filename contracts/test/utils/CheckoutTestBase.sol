// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {X429Checkout} from "../../src/X429Checkout.sol";
import {Signatures} from "./Signatures.sol";

/// @notice Shared fixture: an operator with one queue, six rivals that joined gaslessly, and a payer.
///         Unit tests run it against MockUSDC, fork tests against the real USDC on Base.
abstract contract CheckoutTestBase is Test {
    X429Checkout internal checkout;
    IERC20 internal usdc;
    uint32 internal qid;

    address internal operator = makeAddr("operator");
    address internal relayer = makeAddr("relayer"); // anyone relaying joins/claims
    uint256 internal payerPk = 0xA11CE;
    address internal payer;
    uint256[] internal rivalPks;
    address[] internal rivals;

    uint16 internal constant FEE_BPS = 500; // 5%
    uint128 internal constant BASE_PRICE = 4_000; // 0.004 USDC

    /// @dev Give `to` `amount` USDC.
    function _fund(address to, uint256 amount) internal virtual;

    function _setUpCheckout(address token) internal {
        usdc = IERC20(token);
        checkout = new X429Checkout(usdc);
        vm.prank(operator);
        qid = checkout.createQueue(64, FEE_BPS, '{"name":"test"}');
        payer = vm.addr(payerPk);
        _fund(payer, 10_000_000); // 10 USDC
        for (uint256 i = 0; i < 6; ++i) {
            uint256 pk = 0xB0B0 + i;
            rivalPks.push(pk);
            rivals.push(vm.addr(pk));
        }
    }

    /// @dev Rival i joins with price BASE_PRICE + i * 1000 (0.004 .. 0.009 USDC), relayed by `relayer`.
    function _rivalsJoin() internal {
        for (uint256 i = 0; i < rivals.length; ++i) {
            _joinWithSig(rivalPks[i], BASE_PRICE + uint128(i) * 1_000);
            vm.warp(block.timestamp + 1);
        }
    }

    function _joinWithSig(uint256 pk, uint128 price) internal returns (uint64) {
        bytes32 nonce = keccak256(abi.encode("join", pk, price, block.timestamp));
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = Signatures.join(checkout, pk, qid, price, nonce, deadline);
        vm.prank(relayer);
        return checkout.joinWithSig(vm.addr(pk), qid, price, nonce, deadline, sig);
    }

    function _auth(uint256 pk, uint256 value, bytes32 nonce) internal view returns (X429Checkout.Authorization memory) {
        return Signatures.authorization(
            address(usdc), pk, address(checkout), value, block.timestamp - 1, block.timestamp + 120, nonce
        );
    }

    function _skip(uint32 target, uint128 newPrice, X429Checkout.Authorization memory a)
        internal
        returns (uint64 ticketId, uint256 cost, uint256 refund)
    {
        vm.prank(operator);
        return checkout.skip(qid, target, newPrice, a);
    }

    function _owners() internal view returns (address[] memory owners) {
        X429Checkout.TicketView[] memory list = checkout.getQueue(qid, 0, 256);
        owners = new address[](list.length);
        for (uint256 i = 0; i < list.length; ++i) {
            owners[i] = list[i].owner;
        }
    }

    function _contractOwes() internal view returns (uint256) {
        return checkout.totalClaimable() + checkout.totalFees();
    }

    /// @dev The headline flow: six rivals waiting, a newcomer pays to go straight to #1.
    function _assertJoinAndSkipToFront() internal {
        _rivalsJoin();
        (uint32 fromPos, uint32 passes, uint256 compensation, uint256 fee) = checkout.quoteSkip(qid, payer, 1);
        assertEq(fromPos, 7);
        assertEq(passes, 6);
        assertEq(compensation, 4_000 + 5_000 + 6_000 + 7_000 + 8_000 + 9_000); // 0.039 USDC
        assertEq(fee, compensation * FEE_BPS / 10_000);
        uint256 cost = compensation + fee;
        uint256 ceiling = cost * 12 / 10; // the 20% slippage buffer from the 402

        uint256 payerBefore = usdc.balanceOf(payer);
        (uint64 ticketId, uint256 charged, uint256 refund) =
            _skip(1, 2_000, _auth(payerPk, ceiling, keccak256("pay-1")));

        assertEq(charged, cost);
        assertEq(refund, ceiling - cost);
        assertEq(usdc.balanceOf(payer), payerBefore - cost, "payer pays exactly the cost");
        assertEq(checkout.positionOf(ticketId), 1);
        assertEq(_owners()[0], payer);
        for (uint256 i = 0; i < rivals.length; ++i) {
            assertEq(checkout.claimable(rivals[i]), BASE_PRICE + i * 1_000, "each rival gets its own price");
            assertEq(checkout.positionOf(checkout.activeTicket(qid, rivals[i])), i + 2);
        }
        assertEq(usdc.balanceOf(address(checkout)), _contractOwes());
        assertEq(checkout.queueInfo(qid).feesAccrued, fee);
    }

    /// @dev Rivals claim gaslessly through a relayer; the relayer gets nothing, the rivals get every unit.
    function _assertRivalsClaim() internal {
        for (uint256 i = 0; i < rivals.length; ++i) {
            uint256 owed = checkout.claimable(rivals[i]);
            bytes32 nonce = keccak256(abi.encode("claim", i));
            uint256 deadline = block.timestamp + 600;
            bytes memory sig = Signatures.claim(checkout, rivalPks[i], rivals[i], nonce, deadline);
            uint256 before = usdc.balanceOf(rivals[i]);
            vm.prank(relayer);
            checkout.claimWithSig(rivals[i], rivals[i], nonce, deadline, sig);
            assertEq(usdc.balanceOf(rivals[i]), before + owed);
            assertEq(checkout.claimable(rivals[i]), 0);
        }
        assertEq(usdc.balanceOf(address(checkout)), _contractOwes());
    }
}
