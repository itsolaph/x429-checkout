// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {X429Checkout} from "../src/X429Checkout.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {CheckoutTestBase} from "./utils/CheckoutTestBase.sol";

/// @notice The x402-only user side: joins paid with an EIP-3009 authorization (`joinPaid`) and
///         compensation pushed to its owner by the operator (`payout`, `payoutBatch`).
contract X429CheckoutPaidTest is CheckoutTestBase {
    MockUSDC internal token;
    uint128 internal constant JOIN_FEE = 1_000; // 0.001 USDC

    function _fund(address to, uint256 amount) internal override {
        token.mint(to, amount);
    }

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockUSDC();
        _setUpCheckout(address(token));
        vm.prank(operator);
        checkout.setJoinFee(qid, JOIN_FEE);
        for (uint256 i = 0; i < rivals.length; ++i) {
            token.mint(rivals[i], 100_000); // 0.1 USDC each, enough for a join
        }
    }

    function _joinPaid(uint256 pk, uint128 price, uint256 value, bytes32 nonce)
        internal
        returns (uint64 ticketId, uint256 fee, uint256 refund)
    {
        X429Checkout.Authorization memory a = _auth(pk, value, nonce);
        vm.prank(operator);
        return checkout.joinPaid(qid, price, a);
    }

    function _rivalsJoinPaid() internal {
        for (uint256 i = 0; i < rivals.length; ++i) {
            _joinPaid(rivalPks[i], BASE_PRICE + uint128(i) * 1_000, JOIN_FEE, keccak256(abi.encode("join", i)));
            vm.warp(block.timestamp + 1);
        }
    }

    // ------------------------------------------------------------------ join fee

    function test_setJoinFee_onlyOperator_capped() public {
        vm.expectRevert(X429Checkout.NotOperator.selector);
        checkout.setJoinFee(qid, 1);
        vm.startPrank(operator);
        vm.expectRevert(X429Checkout.InvalidFee.selector);
        checkout.setJoinFee(qid, 1_000_001);
        checkout.setJoinFee(qid, 1_000_000);
        vm.stopPrank();
        assertEq(checkout.joinFee(qid), 1_000_000);
    }

    // ------------------------------------------------------------------ joinPaid

    function test_joinPaid_createsTicketForPayer_feeToOperator_refundsRest() public {
        uint256 before = token.balanceOf(rivals[0]);
        (uint64 id, uint256 fee, uint256 refund) = _joinPaid(rivalPks[0], 4_000, 5_000, keccak256("j"));
        (address owner,,,,,,, uint128 price,,) = checkout.tickets(id);
        assertEq(owner, rivals[0], "identity = authorization.from");
        assertEq(price, 4_000);
        assertEq(checkout.positionOf(id), 1);
        assertEq(fee, JOIN_FEE);
        assertEq(refund, 5_000 - JOIN_FEE);
        assertEq(token.balanceOf(rivals[0]), before - JOIN_FEE, "charged exactly the join fee");
        assertEq(checkout.queueInfo(qid).feesAccrued, JOIN_FEE);
        assertEq(token.balanceOf(address(checkout)), _contractOwes());
        assertEq(rivals[0].balance, 0, "no ETH needed");
    }

    function test_joinPaid_onlyOperator() public {
        X429Checkout.Authorization memory a = _auth(rivalPks[0], JOIN_FEE, keccak256("j"));
        vm.prank(relayer);
        vm.expectRevert(X429Checkout.NotOperator.selector);
        checkout.joinPaid(qid, 4_000, a);
        assertEq(token.authorizationState(rivals[0], a.nonce), false);
    }

    function test_joinPaid_replay_reverts() public {
        X429Checkout.Authorization memory a = _auth(rivalPks[0], JOIN_FEE, keccak256("j"));
        vm.startPrank(operator);
        checkout.joinPaid(qid, 4_000, a);
        vm.expectRevert(X429Checkout.PaymentAlreadySettled.selector);
        checkout.joinPaid(qid, 4_000, a);
        vm.expectRevert(X429Checkout.PaymentAlreadySettled.selector);
        checkout.skip(qid, 1, 0, a);
        vm.stopPrank();
    }

    function test_joinPaid_alreadyWaiting_revertsAndNothingMoves() public {
        _joinPaid(rivalPks[0], 4_000, JOIN_FEE, keccak256("j1"));
        uint256 before = token.balanceOf(rivals[0]);
        X429Checkout.Authorization memory a = _auth(rivalPks[0], JOIN_FEE, keccak256("j2"));
        vm.prank(operator);
        vm.expectRevert(X429Checkout.AlreadyWaiting.selector);
        checkout.joinPaid(qid, 4_000, a);
        assertEq(token.balanceOf(rivals[0]), before);
        assertEq(token.authorizationState(rivals[0], a.nonce), false, "authorization stays usable");
    }

    function test_joinPaid_belowJoinFee_reverts() public {
        X429Checkout.Authorization memory a = _auth(rivalPks[0], JOIN_FEE - 1, keccak256("j"));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(X429Checkout.JoinFeeNotCovered.selector, JOIN_FEE, JOIN_FEE - 1));
        checkout.joinPaid(qid, 4_000, a);
    }

    function test_joinPaid_queueFull_reverts() public {
        vm.startPrank(operator);
        uint32 small = checkout.createQueue(1, 0, "");
        checkout.setJoinFee(small, JOIN_FEE);
        checkout.joinPaid(small, 1, _auth(rivalPks[0], JOIN_FEE, keccak256("a")));
        X429Checkout.Authorization memory a = _auth(rivalPks[1], JOIN_FEE, keccak256("b"));
        vm.expectRevert(X429Checkout.QueueFull.selector);
        checkout.joinPaid(small, 1, a);
        vm.stopPrank();
    }

    function test_joinPaid_frontRun_isApplied() public {
        X429Checkout.Authorization memory a = _auth(rivalPks[0], 3_000, keccak256("j"));
        vm.prank(relayer);
        token.transferWithAuthorization(a.from, address(checkout), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        uint256 before = token.balanceOf(rivals[0]);
        vm.prank(operator);
        (uint64 id, uint256 fee, uint256 refund) = checkout.joinPaid(qid, 4_000, a);
        assertEq(checkout.positionOf(id), 1);
        assertEq(fee, JOIN_FEE);
        assertEq(token.balanceOf(rivals[0]), before + refund, "refund pushed");
        assertEq(token.balanceOf(address(checkout)), _contractOwes());
    }

    function test_joinPaid_frontRun_impossible_isRefundedInFull() public {
        _joinPaid(rivalPks[0], 4_000, JOIN_FEE, keccak256("j1"));
        X429Checkout.Authorization memory a = _auth(rivalPks[0], 3_000, keccak256("j2"));
        uint256 before = token.balanceOf(rivals[0]);
        token.transferWithAuthorization(a.from, address(checkout), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        vm.expectEmit(true, true, false, true, address(checkout));
        emit X429Checkout.PaymentRefunded(rivals[0], a.nonce, a.value, X429Checkout.RefundReason.AlreadyWaiting);
        vm.prank(operator);
        (uint64 id,, uint256 refund) = checkout.joinPaid(qid, 4_000, a);
        assertEq(id, 0);
        assertEq(refund, a.value);
        assertEq(token.balanceOf(rivals[0]), before, "nothing stuck");
        assertEq(token.balanceOf(address(checkout)), _contractOwes());
    }

    // ------------------------------------------------------------------ payout

    function test_payout_sendsOwnClaimableToOwnerOnly() public {
        _assertJoinAndSkipToFront();
        uint256 owed = checkout.claimable(rivals[2]);
        assertGt(owed, 0);
        uint256 before = token.balanceOf(rivals[2]);
        uint256 opBefore = token.balanceOf(operator);
        vm.expectEmit(true, false, false, true, address(checkout));
        emit X429Checkout.PaidOut(rivals[2], owed);
        vm.prank(operator);
        assertEq(checkout.payout(rivals[2]), owed);
        assertEq(token.balanceOf(rivals[2]), before + owed);
        assertEq(token.balanceOf(operator), opBefore, "operator gets nothing");
        assertEq(checkout.claimable(rivals[2]), 0);
        assertEq(token.balanceOf(address(checkout)), _contractOwes());
        vm.prank(operator);
        assertEq(checkout.payout(rivals[2]), 0, "nothing owed: no-op");
    }

    function test_payout_onlyOperator() public {
        _assertJoinAndSkipToFront();
        vm.prank(relayer);
        vm.expectRevert(X429Checkout.NotOperator.selector);
        checkout.payout(rivals[0]);
        address[] memory owners = new address[](1);
        owners[0] = rivals[0];
        vm.prank(rivals[0]);
        vm.expectRevert(X429Checkout.NotOperator.selector);
        checkout.payoutBatch(owners);
    }

    function test_payout_blocklistedOwner_keepsClaimable() public {
        _assertJoinAndSkipToFront();
        uint256 owed = checkout.claimable(rivals[0]);
        token.blacklist(rivals[0], true);
        address[] memory owners = new address[](2);
        owners[0] = rivals[0];
        owners[1] = rivals[1];
        uint256 owed1 = checkout.claimable(rivals[1]);
        vm.prank(operator);
        uint256 total = checkout.payoutBatch(owners);
        assertEq(total, owed1, "the batch goes on past a refused transfer");
        assertEq(checkout.claimable(rivals[0]), owed, "still claimable");
        assertEq(checkout.claimable(rivals[1]), 0);
        assertEq(token.balanceOf(address(checkout)), _contractOwes());
    }

    function test_payoutBatch_tooLarge_reverts() public {
        address[] memory owners = new address[](65);
        vm.prank(operator);
        vm.expectRevert(X429Checkout.BatchTooLarge.selector);
        checkout.payoutBatch(owners);
    }

    function test_claim_stillWorksAsFallback() public {
        _assertJoinAndSkipToFront();
        uint256 owed = checkout.claimable(rivals[3]);
        vm.prank(rivals[3]);
        checkout.claim(rivals[3]);
        assertEq(token.balanceOf(rivals[3]), 100_000 + owed);
        vm.prank(operator);
        assertEq(checkout.payout(rivals[3]), 0, "already claimed");
    }

    // ------------------------------------------------------------------ the whole x402-only flow

    function test_x402Only_rivalsJoinPaid_payerSkips_rivalsPaidAutomatically() public {
        _rivalsJoinPaid();
        assertEq(checkout.queueInfo(qid).feesAccrued, JOIN_FEE * 6);
        (,, uint256 compensation, uint256 fee) = checkout.quoteSkip(qid, payer, 1);
        uint256 ceiling = (compensation + fee) * 12 / 10;
        (uint64 id, uint256 cost,) = _skip(1, 2_000, _auth(payerPk, ceiling, keccak256("skip")));
        assertEq(checkout.positionOf(id), 1);

        address[] memory owners = new address[](rivals.length);
        uint256[] memory before = new uint256[](rivals.length);
        for (uint256 i = 0; i < rivals.length; ++i) {
            owners[i] = rivals[i];
            before[i] = token.balanceOf(rivals[i]);
        }
        vm.prank(operator);
        uint256 total = checkout.payoutBatch(owners);
        assertEq(total, compensation);
        for (uint256 i = 0; i < rivals.length; ++i) {
            assertEq(token.balanceOf(rivals[i]), before[i] + BASE_PRICE + i * 1_000, "each rival gets its own price");
            assertEq(token.balanceOf(rivals[i]), 100_000 - JOIN_FEE + BASE_PRICE + i * 1_000);
            assertEq(rivals[i].balance, 0);
        }
        assertEq(checkout.totalClaimable(), 0);
        assertEq(token.balanceOf(address(checkout)), checkout.totalFees());
        assertEq(checkout.totalFees(), JOIN_FEE * 6 + cost - compensation);
    }
}
