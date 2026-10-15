// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {X429Checkout} from "../src/X429Checkout.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Signatures} from "./utils/Signatures.sol";

/// @notice Drives the contract with random joins, skips (normal and front-run), serves, leaves, claims
///         and fee withdrawals, and keeps ghost books to check against.
contract Handler is Test {
    X429Checkout public immutable checkout;
    MockUSDC public immutable token;
    uint32 public immutable qid;
    address public immutable operator;

    uint256[] internal pks;
    address[] public actors;

    /// USDC that reached the contract through a front-run and is waiting for the operator to settle it.
    uint256 public ghostInFlight;
    /// Set if any passed ticket was credited anything other than exactly its posted price.
    bool public ghostUnderpaid;
    /// Set if a payer was charged anything other than (sum of passed prices + fee).
    bool public ghostOvercharged;
    uint256 public ghostSkips;
    uint256 public ghostFrontRuns;

    X429Checkout.Authorization[] internal pending;
    uint256 internal nonceCounter;

    constructor(X429Checkout c, MockUSDC t, uint32 q, address op) {
        checkout = c;
        token = t;
        qid = q;
        operator = op;
        for (uint256 i = 0; i < 10; ++i) {
            uint256 pk = 0xC0FFEE + i;
            pks.push(pk);
            actors.push(vm.addr(pk));
            t.mint(vm.addr(pk), 1_000_000_000); // 1000 USDC each
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function join(uint256 who, uint128 price) external {
        who = bound(who, 0, actors.length - 1);
        price = uint128(bound(price, 0, 50_000));
        vm.prank(actors[who]);
        checkout.join(qid, price);
    }

    function joinWithSig(uint256 who, uint128 price) external {
        who = bound(who, 0, actors.length - 1);
        price = uint128(bound(price, 0, 50_000));
        bytes32 nonce = bytes32(++nonceCounter);
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = Signatures.join(checkout, pks[who], qid, price, nonce, deadline);
        checkout.joinWithSig(actors[who], qid, price, nonce, deadline, sig);
    }

    function skip(uint256 who, uint32 target, uint256 buffer, uint128 newPrice) external {
        who = bound(who, 0, actors.length - 1);
        X429Checkout.Queue memory q = checkout.queueInfo(qid);
        if (q.length == 0) return;
        target = uint32(bound(target, 1, q.length));
        (, uint32 passes, uint256 compensation, uint256 fee) = _quote(actors[who], target);
        if (passes == 0 || passes > 64) return;
        uint256 value = compensation + fee + bound(buffer, 0, 100_000);
        X429Checkout.Authorization memory a = _authorization(who, value);
        _skipAndCheck(a, target, uint128(bound(newPrice, 0, 50_000)));
    }

    /// Someone submits the authorization straight to USDC; the operator has not settled it yet.
    function frontRun(uint256 who, uint256 value) external {
        who = bound(who, 0, actors.length - 1);
        value = bound(value, 1, 500_000);
        X429Checkout.Authorization memory a = _authorization(who, value);
        token.transferWithAuthorization(
            a.from, address(checkout), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s
        );
        pending.push(a);
        ghostInFlight += value;
    }

    /// The operator settles a front-run payment: it is applied if possible, else refunded in full.
    function settleFrontRun(uint256 idx, uint32 target, uint128 newPrice) external {
        if (pending.length == 0) return;
        idx = bound(idx, 0, pending.length - 1);
        X429Checkout.Authorization memory a = pending[idx];
        pending[idx] = pending[pending.length - 1];
        pending.pop();
        X429Checkout.Queue memory q = checkout.queueInfo(qid);
        target = uint32(bound(target, 1, q.length + 1));
        ghostInFlight -= a.value;
        ghostFrontRuns++;
        _skipAndCheck(a, target, uint128(bound(newPrice, 0, 50_000)));
    }

    function serve(uint32 count) external {
        count = uint32(bound(count, 1, 3));
        vm.prank(operator);
        checkout.serve(qid, count);
    }

    function leave(uint256 who) external {
        who = bound(who, 0, actors.length - 1);
        uint64 id = checkout.activeTicket(qid, actors[who]);
        if (id == 0) return;
        vm.prank(actors[who]);
        checkout.leave(id);
    }

    function claim(uint256 who) external {
        who = bound(who, 0, actors.length - 1);
        if (checkout.claimable(actors[who]) == 0) return;
        vm.prank(actors[who]);
        checkout.claim(actors[who]);
    }

    function withdrawFees() external {
        vm.prank(operator);
        checkout.withdrawFees(qid, operator);
    }

    function setFee(uint16 bps) external {
        vm.prank(operator);
        checkout.setFee(qid, uint16(bound(bps, 0, 1000)));
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 30));
    }

    // ------------------------------------------------------------------ helpers

    function _quote(address owner, uint32 target) internal view returns (uint32, uint32, uint256, uint256) {
        try checkout.quoteSkip(qid, owner, target) returns (uint32 f, uint32 p, uint256 c, uint256 fee) {
            return (f, p, c, fee);
        } catch {
            return (0, 0, 0, 0);
        }
    }

    function _authorization(uint256 who, uint256 value) internal returns (X429Checkout.Authorization memory) {
        return Signatures.authorization(
            address(token),
            pks[who],
            address(checkout),
            value,
            block.timestamp - 1,
            block.timestamp + 3600,
            bytes32(++nonceCounter)
        );
    }

    /// Records every owner's claimable before the skip and checks each passed ticket got exactly its price.
    function _skipAndCheck(X429Checkout.Authorization memory a, uint32 target, uint128 newPrice) internal {
        X429Checkout.TicketView[] memory before = checkout.getQueue(qid, 0, 256);
        uint256[] memory claimBefore = new uint256[](before.length);
        for (uint256 i = 0; i < before.length; ++i) {
            claimBefore[i] = checkout.claimable(before[i].owner);
        }
        uint256 payerHad = token.balanceOf(a.from) + checkout.claimable(a.from);
        bool wasFrontRun = token.authorizationState(a.from, a.nonce);

        vm.prank(operator);
        try checkout.skip(qid, target, newPrice, a) returns (uint64 ticketId, uint256 cost, uint256 refund) {
            _checkPayer(a, payerHad, wasFrontRun, cost, refund);
            if (cost == 0 && wasFrontRun) return; // refunded in full
            ghostSkips++;
            uint256 compensation = _checkCredits(before, claimBefore, ticketId, a.from);
            if (cost != compensation + compensation * checkout.queueInfo(qid).feeBps / 10_000) {
                ghostOvercharged = true;
            }
        } catch {
            // a front-run payment must never be stuck: settling it may only fail on a bad signature
            if (wasFrontRun) ghostOvercharged = true;
        }
    }

    function _checkPayer(
        X429Checkout.Authorization memory a,
        uint256 payerHad,
        bool settledFrontRun,
        uint256 cost,
        uint256 refund
    ) internal {
        uint256 payerNow = token.balanceOf(a.from) + checkout.claimable(a.from);
        if (refund != a.value - cost) ghostOvercharged = true;
        if (settledFrontRun) {
            // already debited by the front-run; the settlement gives back the refund
            if (payerNow != payerHad + refund) ghostOvercharged = true;
        } else if (payerHad != payerNow + cost) {
            ghostOvercharged = true;
        }
    }

    /// The passed tickets are those that were ahead of the payer before and are behind it now. Each must
    /// be credited exactly its posted price (an owner holds one ticket per queue); everyone else nothing.
    function _checkCredits(
        X429Checkout.TicketView[] memory before,
        uint256[] memory claimBefore,
        uint64 ticketId,
        address payer
    ) internal returns (uint256 compensation) {
        X429Checkout.TicketView[] memory now_ = checkout.getQueue(qid, 0, 256);
        for (uint256 i = 0; i < before.length; ++i) {
            if (before[i].owner == payer) continue;
            uint256 credited = checkout.claimable(before[i].owner) - claimBefore[i];
            if (_isBehind(now_, ticketId, before[i].id) && _wasAhead(before, payer, i)) {
                compensation += before[i].skipPrice;
                if (credited != before[i].skipPrice) ghostUnderpaid = true;
            } else if (credited != 0) {
                ghostUnderpaid = true;
            }
        }
    }

    function _isBehind(X429Checkout.TicketView[] memory list, uint64 mover, uint64 other)
        internal
        pure
        returns (bool)
    {
        bool seenMover;
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i].id == mover) seenMover = true;
            if (list[i].id == other) return seenMover;
        }
        return false;
    }

    function _wasAhead(X429Checkout.TicketView[] memory list, address payer, uint256 idx)
        internal
        pure
        returns (bool)
    {
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i].owner == payer) return idx < i;
        }
        return true; // the payer was not in the queue: everyone was ahead of it
    }
}

contract X429CheckoutInvariantTest is Test {
    X429Checkout internal checkout;
    MockUSDC internal token;
    Handler internal handler;
    uint32 internal qid;
    address internal operator = makeAddr("operator");

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockUSDC();
        checkout = new X429Checkout(IERC20(address(token)));
        vm.prank(operator);
        qid = checkout.createQueue(32, 300, "");
        handler = new Handler(checkout, token, qid, operator);
        targetContract(address(handler));
    }

    /// Every USDC the contract holds is owed to someone: claimables + fees + front-run payments in flight.
    function invariant_balanceEqualsClaimablesPlusFeesPlusInFlight() public view {
        assertEq(
            token.balanceOf(address(checkout)),
            checkout.totalClaimable() + checkout.totalFees() + handler.ghostInFlight()
        );
    }

    function invariant_totalClaimableIsSumOfClaimables() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            sum += checkout.claimable(handler.actors(i));
        }
        assertEq(checkout.totalClaimable(), sum);
    }

    function invariant_feesMatchQueue() public view {
        assertEq(checkout.totalFees(), checkout.queueInfo(qid).feesAccrued);
    }

    /// No ticket is ever paid less (or more) than its posted price when passed; no payer overcharged.
    function invariant_passedTicketsGetTheirPrice() public view {
        assertFalse(handler.ghostUnderpaid());
        assertFalse(handler.ghostOvercharged());
    }

    function invariant_earnedEqualsPaidEqualsCompensation() public view {
        uint256 earned;
        uint256 paid;
        for (uint64 id = 1; id <= checkout.ticketCount(); ++id) {
            (,,,,,,,, uint128 e, uint128 p) = checkout.tickets(id);
            earned += e;
            paid += p;
        }
        assertEq(earned, paid);
        assertEq(paid, checkout.queueInfo(qid).totalCompensation);
    }

    function invariant_linkedListConsistent() public view {
        X429Checkout.Queue memory q = checkout.queueInfo(qid);
        uint64 id = q.head;
        uint64 prev;
        uint32 n;
        while (id != 0) {
            (address owner,, X429Checkout.Status status,,, uint64 p, uint64 next,,,) = checkout.tickets(id);
            assertEq(uint8(status), uint8(X429Checkout.Status.Waiting));
            assertEq(p, prev);
            assertEq(checkout.activeTicket(qid, owner), id);
            prev = id;
            id = next;
            ++n;
            assertLe(n, q.maxLength);
        }
        assertEq(prev, q.tail);
        assertEq(n, q.length);
    }

    /// The handler's skip paths really apply skips (otherwise the invariants above would prove little).
    function test_handlerExercisesSkipsAndFrontRuns() public {
        handler.join(0, 10_000);
        handler.joinWithSig(1, 20_000);
        handler.join(2, 30_000);
        handler.skip(3, 1, 500, 1_000);
        handler.frontRun(4, 400_000);
        handler.settleFrontRun(0, 1, 0);
        handler.frontRun(5, 1); // too little: refunded in full
        handler.settleFrontRun(0, 1, 0);
        assertEq(handler.ghostSkips(), 2);
        assertEq(handler.ghostFrontRuns(), 2);
        assertFalse(handler.ghostUnderpaid());
        assertFalse(handler.ghostOvercharged());
        assertEq(handler.ghostInFlight(), 0);
        assertEq(token.balanceOf(address(checkout)), checkout.totalClaimable() + checkout.totalFees());
        assertEq(checkout.claimable(handler.actors(0)), 10_000 * 2); // passed twice
    }
}
