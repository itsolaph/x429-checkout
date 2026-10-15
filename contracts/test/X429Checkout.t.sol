// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {X429Checkout} from "../src/X429Checkout.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {CheckoutTestBase} from "./utils/CheckoutTestBase.sol";
import {Signatures} from "./utils/Signatures.sol";

contract X429CheckoutTest is CheckoutTestBase {
    MockUSDC internal token;

    function _fund(address to, uint256 amount) internal override {
        token.mint(to, amount);
    }

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockUSDC();
        _setUpCheckout(address(token));
    }

    // ------------------------------------------------------------------ queues and operator

    function test_createQueue_validates() public {
        vm.expectRevert(X429Checkout.InvalidMaxLength.selector);
        checkout.createQueue(0, 0, "");
        vm.expectRevert(X429Checkout.InvalidMaxLength.selector);
        checkout.createQueue(257, 0, "");
        vm.expectRevert(X429Checkout.InvalidFee.selector);
        checkout.createQueue(10, 1001, "");
        uint32 id = checkout.createQueue(10, 1000, "x");
        assertEq(checkout.queueInfo(id).operator, address(this));
        assertEq(checkout.queueCount(), 2);
    }

    function test_setFee_onlyOperator_capped() public {
        vm.expectRevert(X429Checkout.NotOperator.selector);
        checkout.setFee(qid, 10);
        vm.startPrank(operator);
        vm.expectRevert(X429Checkout.InvalidFee.selector);
        checkout.setFee(qid, 1001);
        checkout.setFee(qid, 0);
        vm.stopPrank();
        assertEq(checkout.queueInfo(qid).feeBps, 0);
    }

    function test_unknownQueue() public {
        vm.expectRevert(X429Checkout.UnknownQueue.selector);
        checkout.queueInfo(99);
        vm.expectRevert(X429Checkout.UnknownQueue.selector);
        checkout.join(99, 1);
    }

    // ------------------------------------------------------------------ join

    function test_joinWithSig_isGaslessForTheOwner() public {
        uint64 id = _joinWithSig(rivalPks[0], 4_000);
        (address owner,,,,,,,,,) = checkout.tickets(id);
        assertEq(owner, rivals[0]);
        assertEq(checkout.activeTicket(qid, rivals[0]), id);
        assertEq(checkout.positionOf(id), 1);
        assertEq(rivals[0].balance, 0);
    }

    function test_joinWithSig_rejectsReplayExpiryAndForgery() public {
        bytes32 nonce = keccak256("n");
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = Signatures.join(checkout, rivalPks[0], qid, 4_000, nonce, deadline);

        // wrong owner for the signature
        vm.expectRevert(X429Checkout.InvalidSignature.selector);
        checkout.joinWithSig(rivals[1], qid, 4_000, nonce, deadline, sig);
        // tampered price
        vm.expectRevert(X429Checkout.InvalidSignature.selector);
        checkout.joinWithSig(rivals[0], qid, 1, nonce, deadline, sig);

        checkout.joinWithSig(rivals[0], qid, 4_000, nonce, deadline, sig);
        vm.expectRevert(X429Checkout.NonceAlreadyUsed.selector);
        checkout.joinWithSig(rivals[0], qid, 4_000, nonce, deadline, sig);

        bytes32 n2 = keccak256("n2");
        bytes memory late = Signatures.join(checkout, rivalPks[1], qid, 4_000, n2, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(X429Checkout.SignatureExpired.selector);
        checkout.joinWithSig(rivals[1], qid, 4_000, n2, deadline, late);
    }

    function test_join_onePerOwnerPerQueue() public {
        vm.startPrank(rivals[0]);
        checkout.join(qid, 1);
        vm.expectRevert(X429Checkout.AlreadyWaiting.selector);
        checkout.join(qid, 1);
        vm.stopPrank();
        // a different queue is fine
        uint32 other = checkout.createQueue(4, 0, "");
        vm.prank(rivals[0]);
        checkout.join(other, 1);
    }

    function test_join_queueFull() public {
        uint32 small = checkout.createQueue(2, 0, "");
        vm.prank(rivals[0]);
        checkout.join(small, 1);
        vm.prank(rivals[1]);
        checkout.join(small, 1);
        vm.prank(rivals[2]);
        vm.expectRevert(X429Checkout.QueueFull.selector);
        checkout.join(small, 1);
    }

    function test_cancelNonce_blocksRelay() public {
        bytes32 nonce = keccak256("n");
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = Signatures.join(checkout, rivalPks[0], qid, 4_000, nonce, deadline);
        vm.prank(rivals[0]);
        checkout.cancelNonce(nonce);
        vm.expectRevert(X429Checkout.NonceAlreadyUsed.selector);
        checkout.joinWithSig(rivals[0], qid, 4_000, nonce, deadline, sig);
    }

    // ------------------------------------------------------------------ skip

    function test_skip_joinAndSkipToFront_paysEveryRival() public {
        _assertJoinAndSkipToFront();
    }

    function test_skip_existingTicket_toMiddle() public {
        _rivalsJoin();
        _joinWithSig(payerPk, 1_000); // payer is #7
        (, uint32 passes, uint256 compensation, uint256 fee) = checkout.quoteSkip(qid, payer, 4);
        assertEq(passes, 3);
        assertEq(compensation, 7_000 + 8_000 + 9_000);
        (uint64 id, uint256 cost,) = _skip(4, 0, _auth(payerPk, compensation + fee, keccak256("p")));
        assertEq(cost, compensation + fee);
        assertEq(checkout.positionOf(id), 4);
        assertEq(checkout.claimable(rivals[0]), 0);
        assertEq(checkout.claimable(rivals[2]), 0);
        assertEq(checkout.claimable(rivals[3]), 7_000);
        assertEq(checkout.claimable(rivals[5]), 9_000);
        (,,,,,,,, uint128 earned, uint128 paid) = checkout.tickets(id);
        assertEq(earned, 0);
        assertEq(paid, compensation);
        address[] memory o = _owners();
        assertEq(o[2], rivals[2]);
        assertEq(o[3], payer);
        assertEq(o[4], rivals[3]);
        assertEq(o[6], rivals[5]);
    }

    function test_skip_costAboveSignedValue_revertsAndNothingMoves() public {
        _rivalsJoin();
        (,, uint256 compensation, uint256 fee) = checkout.quoteSkip(qid, payer, 1);
        X429Checkout.Authorization memory a = _auth(payerPk, compensation + fee - 1, keccak256("p"));
        uint256 before = token.balanceOf(payer);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(X429Checkout.CostExceedsPayment.selector, compensation + fee, a.value));
        checkout.skip(qid, 1, 0, a);
        assertEq(token.balanceOf(payer), before);
        assertEq(checkout.activeTicket(qid, payer), 0);
        assertFalse(token.authorizationState(payer, a.nonce), "authorization stays usable");
        assertFalse(checkout.paymentSettled(payer, a.nonce));
    }

    function test_skip_expiredAuthorization_reverts() public {
        _rivalsJoin();
        X429Checkout.Authorization memory a = Signatures.authorization(
            address(token), payerPk, address(checkout), 1_000_000, 0, block.timestamp - 1, keccak256("old")
        );
        vm.prank(operator);
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        checkout.skip(qid, 1, 0, a);
        assertEq(checkout.activeTicket(qid, payer), 0);
    }

    function test_skip_replay_reverts() public {
        _rivalsJoin();
        X429Checkout.Authorization memory a = _auth(payerPk, 1_000_000, keccak256("p"));
        _skip(3, 0, a);
        vm.prank(operator);
        vm.expectRevert(X429Checkout.PaymentAlreadySettled.selector);
        checkout.skip(qid, 1, 0, a);
    }

    function test_skip_onlyOperator() public {
        _rivalsJoin();
        X429Checkout.Authorization memory a = _auth(payerPk, 1_000_000, keccak256("p"));
        vm.prank(relayer);
        vm.expectRevert(X429Checkout.NotOperator.selector);
        checkout.skip(qid, 1, 0, a);
    }

    function test_skip_wrongSigner_reverts() public {
        _rivalsJoin();
        X429Checkout.Authorization memory a = _auth(payerPk, 1_000_000, keccak256("p"));
        a.from = rivals[5]; // #6: the skip itself is possible, only the signature is wrong
        vm.prank(operator);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        checkout.skip(qid, 1, 0, a);
    }

    function test_skip_nothingToPass_and_tooMany() public {
        _rivalsJoin();
        X429Checkout.Authorization memory a0 = _auth(payerPk, 1, keccak256("a"));
        vm.prank(operator);
        vm.expectRevert(X429Checkout.InvalidPosition.selector);
        checkout.skip(qid, 0, 0, a0);
        // rival 0 is already #1
        X429Checkout.Authorization memory a1 = _auth(rivalPks[0], 1, keccak256("b"));
        vm.prank(operator);
        vm.expectRevert(X429Checkout.NothingToPass.selector);
        checkout.skip(qid, 1, 0, a1);

        // 65 passes are over the cap
        uint32 big = checkout.createQueue(100, 0, "");
        for (uint256 i = 0; i < 65; ++i) {
            vm.prank(address(uint160(0x1000 + i)));
            checkout.join(big, 1);
        }
        X429Checkout.Authorization memory a = _auth(payerPk, 1_000_000, keccak256("c"));
        vm.expectRevert(abi.encodeWithSelector(X429Checkout.TooManyPasses.selector, uint32(65)));
        checkout.skip(big, 1, 0, a);
        checkout.skip(big, 2, 0, a); // 64 passes are fine
        assertEq(checkout.positionOf(checkout.activeTicket(big, payer)), 2);
    }

    function test_skip_zeroFee_andFreeTickets() public {
        vm.prank(operator);
        checkout.setFee(qid, 0);
        vm.prank(rivals[0]);
        checkout.join(qid, 0);
        vm.prank(rivals[1]);
        checkout.join(qid, 0);
        (, uint256 cost, uint256 refund) = _skip(1, 0, _auth(payerPk, 5, keccak256("p")));
        assertEq(cost, 0);
        assertEq(refund, 5);
        assertEq(token.balanceOf(address(checkout)), 0);
    }

    function test_skip_refundIsPushedInSameTx() public {
        _rivalsJoin();
        X429Checkout.Authorization memory a = _auth(payerPk, 1_000_000, keccak256("p"));
        uint256 before = token.balanceOf(payer);
        (, uint256 cost, uint256 refund) = _skip(1, 0, a);
        assertEq(refund, 1_000_000 - cost);
        assertEq(token.balanceOf(payer), before - cost);
        assertEq(checkout.claimable(payer), 0, "nothing left to claim");
    }

    function test_push_fallsBackToClaimable() public {
        _rivalsJoin();
        X429Checkout.Authorization memory a = _auth(payerPk, 1_000_000, keccak256("p"));
        // front-run the authorization, then blocklist the payer so the refund push fails
        token.transferWithAuthorization(
            a.from, address(checkout), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s
        );
        token.blacklist(payer, true);
        (, uint256 cost, uint256 refund) = _skip(1, 0, a);
        assertEq(refund, 1_000_000 - cost);
        assertEq(checkout.claimable(payer), refund);
        assertEq(token.balanceOf(address(checkout)), _contractOwes());
    }

    // ------------------------------------------------------------------ front-run

    function test_frontRun_isDetectedAndApplied() public {
        _rivalsJoin();
        X429Checkout.Authorization memory a = _auth(payerPk, 1_000_000, keccak256("p"));
        // someone sees the X-PAYMENT and submits it straight to USDC
        vm.prank(relayer);
        token.transferWithAuthorization(a.from, address(checkout), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        assertEq(token.balanceOf(address(checkout)), 1_000_000);
        assertEq(_contractOwes(), 0);

        vm.expectEmit(true, true, false, true, address(checkout));
        emit X429Checkout.PaymentReceived(payer, a.nonce, a.value, true);
        (uint64 id, uint256 cost, uint256 refund) = _skip(1, 0, a);
        assertEq(checkout.positionOf(id), 1);
        assertEq(cost + refund, a.value);
        assertEq(token.balanceOf(address(checkout)), _contractOwes());

        vm.prank(operator);
        vm.expectRevert(X429Checkout.PaymentAlreadySettled.selector);
        checkout.skip(qid, 1, 0, a);
    }

    function test_frontRun_impossibleSkip_isRefundedInFull() public {
        _rivalsJoin();
        (,, uint256 compensation, uint256 fee) = checkout.quoteSkip(qid, payer, 1);
        X429Checkout.Authorization memory a = _auth(payerPk, compensation + fee - 1, keccak256("p"));
        uint256 before = token.balanceOf(payer);
        token.transferWithAuthorization(a.from, address(checkout), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        vm.expectEmit(true, true, false, true, address(checkout));
        emit X429Checkout.PaymentRefunded(payer, a.nonce, a.value, X429Checkout.RefundReason.CostExceedsPayment);
        (, uint256 cost, uint256 refund) = _skip(1, 0, a);
        assertEq(cost, 0);
        assertEq(refund, a.value);
        assertEq(token.balanceOf(payer), before, "nothing stuck");
        assertEq(token.balanceOf(address(checkout)), 0);
        assertEq(checkout.activeTicket(qid, payer), 0);
    }

    function test_frontRun_cancelledAuthorization_isNotPaid() public {
        _rivalsJoin();
        X429Checkout.Authorization memory a = _auth(payerPk, 1_000_000, keccak256("p"));
        (uint8 v, bytes32 r, bytes32 s) = Signatures.cancelAuthorization(address(token), payerPk, a.nonce);
        token.cancelAuthorization(payer, a.nonce, v, r, s);
        vm.prank(operator);
        vm.expectRevert(X429Checkout.PaymentNotReceived.selector);
        checkout.skip(qid, 1, 0, a);
    }

    function test_frontRun_forgedSignature_rejected() public {
        _rivalsJoin();
        X429Checkout.Authorization memory a = _auth(payerPk, 1_000_000, keccak256("p"));
        token.transferWithAuthorization(a.from, address(checkout), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        X429Checkout.Authorization memory forged = a;
        forged.value = 2_000_000;
        vm.prank(operator);
        vm.expectRevert(X429Checkout.InvalidSignature.selector);
        checkout.skip(qid, 1, 0, forged);
    }

    // ------------------------------------------------------------------ serve, leave, claim, fees

    function test_serve_fromHeadOnly_byOperator() public {
        _assertJoinAndSkipToFront();
        vm.expectRevert(X429Checkout.NotOperator.selector);
        checkout.serve(qid, 1);
        uint64 id = checkout.activeTicket(qid, payer);
        vm.prank(operator);
        assertEq(checkout.serve(qid, 1), 1);
        (,, X429Checkout.Status status,,,,,,,) = checkout.tickets(id);
        assertEq(uint8(status), uint8(X429Checkout.Status.Served));
        assertEq(checkout.activeTicket(qid, payer), 0);
        assertEq(_owners()[0], rivals[0]);
        vm.prank(operator);
        assertEq(checkout.serve(qid, 10), 6);
        vm.prank(operator);
        assertEq(checkout.serve(qid, 1), 0);
        assertEq(checkout.queueInfo(qid).served, 7);
    }

    function test_leave_keepsEarnings() public {
        _assertJoinAndSkipToFront();
        uint64 id = checkout.activeTicket(qid, rivals[2]);
        vm.expectRevert(X429Checkout.NotTicketOwner.selector);
        checkout.leave(id);
        vm.prank(rivals[2]);
        checkout.leave(id);
        assertEq(checkout.claimable(rivals[2]), 6_000);
        assertEq(checkout.positionOf(id), 0);
        assertEq(checkout.queueInfo(qid).length, 6);
        vm.prank(rivals[2]);
        vm.expectRevert(X429Checkout.NotWaiting.selector);
        checkout.leave(id);
    }

    function test_claimWithSig_gasless_andReplayRejected() public {
        _assertJoinAndSkipToFront();
        _assertRivalsClaim();
        // replaying the first claim fails on the nonce, and nothing more leaves the contract
        bytes32 nonce = keccak256(abi.encode("claim", uint256(0)));
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = Signatures.claim(checkout, rivalPks[0], rivals[0], nonce, deadline);
        uint256 held = token.balanceOf(address(checkout));
        vm.expectRevert(X429Checkout.NonceAlreadyUsed.selector);
        checkout.claimWithSig(rivals[0], rivals[0], nonce, deadline, sig);
        assertEq(token.balanceOf(address(checkout)), held);
    }

    function test_claimWithSig_toSignedRecipientOnly() public {
        _assertJoinAndSkipToFront();
        address cold = makeAddr("cold");
        bytes32 nonce = keccak256("c");
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = Signatures.claim(checkout, rivalPks[1], cold, nonce, deadline);
        vm.expectRevert(X429Checkout.InvalidSignature.selector);
        checkout.claimWithSig(rivals[1], relayer, nonce, deadline, sig);
        checkout.claimWithSig(rivals[1], cold, nonce, deadline, sig);
        assertEq(token.balanceOf(cold), 5_000);
    }

    function test_claim_direct_and_nothingToClaim() public {
        _assertJoinAndSkipToFront();
        vm.prank(rivals[0]);
        assertEq(checkout.claim(rivals[0]), 4_000);
        vm.prank(rivals[0]);
        vm.expectRevert(X429Checkout.NothingToClaim.selector);
        checkout.claim(rivals[0]);
    }

    function test_withdrawFees_operatorOnly() public {
        _assertJoinAndSkipToFront();
        uint256 fee = checkout.queueInfo(qid).feesAccrued;
        vm.expectRevert(X429Checkout.NotOperator.selector);
        checkout.withdrawFees(qid, relayer);
        vm.prank(operator);
        assertEq(checkout.withdrawFees(qid, operator), fee);
        assertEq(token.balanceOf(operator), fee);
        assertEq(checkout.totalFees(), 0);
        assertEq(token.balanceOf(address(checkout)), _contractOwes());
    }

    // ------------------------------------------------------------------ fuzz

    /// @dev Any set of prices and any target: the payer is charged exactly the sum of the prices it
    ///      passes plus the fee, every passed ticket gets exactly its own price, and the books balance.
    function testFuzz_skip_paysEachPassedTicketItsPrice(uint128[8] memory prices, uint8 targetSeed, uint16 feeBps)
        public
    {
        feeBps = uint16(bound(feeBps, 0, 1000));
        vm.prank(operator);
        checkout.setFee(qid, feeBps);
        address[] memory owners = new address[](8);
        for (uint256 i = 0; i < 8; ++i) {
            prices[i] = uint128(bound(prices[i], 0, 1_000_000)); // up to 1 USDC each
            owners[i] = address(uint160(0x5000 + i));
            vm.prank(owners[i]);
            checkout.join(qid, prices[i]);
        }
        uint32 target = uint32(bound(targetSeed, 1, 8));
        uint256 expected;
        for (uint256 i = target - 1; i < 8; ++i) {
            expected += prices[i];
        }
        uint256 fee = expected * feeBps / 10_000;
        _fund(payer, expected + fee);
        uint256 before = token.balanceOf(payer);
        (, uint256 cost, uint256 refund) = _skip(target, 0, _auth(payerPk, expected + fee + 7, keccak256("f")));
        assertEq(cost, expected + fee);
        assertEq(refund, 7);
        assertEq(token.balanceOf(payer), before - cost);
        for (uint256 i = 0; i < 8; ++i) {
            assertEq(checkout.claimable(owners[i]), i + 1 >= target ? prices[i] : 0);
        }
        assertEq(checkout.positionOf(checkout.activeTicket(qid, payer)), target);
        assertEq(token.balanceOf(address(checkout)), _contractOwes());
    }

    function testFuzz_quoteMatchesSkip(uint8 n, uint8 targetSeed) public {
        n = uint8(bound(n, 1, 40));
        for (uint256 i = 0; i < n; ++i) {
            vm.prank(address(uint160(0x7000 + i)));
            checkout.join(qid, uint128(1_000 + i * 37));
        }
        uint32 target = uint32(bound(targetSeed, 1, n));
        (uint32 fromPos, uint32 passes, uint256 compensation, uint256 fee) = checkout.quoteSkip(qid, payer, target);
        assertEq(fromPos, n + 1);
        assertEq(passes, n + 1 - target);
        (, uint256 cost,) = _skip(target, 0, _auth(payerPk, compensation + fee, keccak256("q")));
        assertEq(cost, compensation + fee);
    }
}
