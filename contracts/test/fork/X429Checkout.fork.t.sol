// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {X429Checkout, IERC3009} from "../../src/X429Checkout.sol";
import {CheckoutTestBase} from "../utils/CheckoutTestBase.sol";
import {Signatures} from "../utils/Signatures.sol";

interface IFiatToken {
    function masterMinter() external view returns (address);
    function configureMinter(address minter, uint256 minterAllowedAmount) external returns (bool);
    function mint(address to, uint256 amount) external returns (bool);
    function name() external view returns (string memory);
    function version() external view returns (string memory);
    function decimals() external view returns (uint8);
}

/// @notice The same flows against the real USDC (FiatTokenV2_2) on a Base mainnet fork.
///         RPC: $BASE_RPC_URL, default https://mainnet.base.org. Block pinned for reproducibility.
contract X429CheckoutForkTest is CheckoutTestBase {
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 internal constant FORK_BLOCK = 52_621_900;

    function _fund(address to, uint256 amount) internal override {
        // mint through a minter configured by the real masterMinter, like Circle does
        vm.prank(IFiatToken(BASE_USDC).masterMinter());
        IFiatToken(BASE_USDC).configureMinter(address(this), type(uint128).max);
        IFiatToken(BASE_USDC).mint(to, amount);
    }

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")), FORK_BLOCK);
        _setUpCheckout(BASE_USDC);
    }

    function test_fork_usdcIsWhatX402Advertises() public view {
        assertEq(block.chainid, 8453);
        assertEq(IFiatToken(BASE_USDC).name(), "USD Coin");
        assertEq(IFiatToken(BASE_USDC).version(), "2");
        assertEq(IFiatToken(BASE_USDC).decimals(), 6);
    }

    function test_fork_joinSkipServeClaim() public {
        _assertJoinAndSkipToFront();
        vm.prank(operator);
        checkout.serve(qid, 1);
        assertEq(checkout.activeTicket(qid, payer), 0);
        _assertRivalsClaim();
        uint256 fee = checkout.queueInfo(qid).feesAccrued;
        vm.prank(operator);
        checkout.withdrawFees(qid, operator);
        assertEq(usdc.balanceOf(operator), fee);
        assertEq(usdc.balanceOf(address(checkout)), 0);
    }

    /// The x402-only user side on real USDC: paid joins, a paid skip, compensation pushed by the operator.
    function test_fork_paidJoinsSkipAndAutomaticPayout() public {
        vm.prank(operator);
        checkout.setJoinFee(qid, 1_000);
        address[] memory owners = new address[](rivals.length);
        for (uint256 i = 0; i < rivals.length; ++i) {
            _fund(rivals[i], 10_000);
            owners[i] = rivals[i];
            X429Checkout.Authorization memory a = _auth(rivalPks[i], 1_000, keccak256(abi.encode("pj", i)));
            vm.prank(operator);
            checkout.joinPaid(qid, BASE_PRICE, a);
        }
        (,, uint256 compensation, uint256 fee) = checkout.quoteSkip(qid, payer, 1);
        _skip(1, 2_000, _auth(payerPk, (compensation + fee) * 12 / 10, keccak256("ps")));
        vm.prank(operator);
        assertEq(checkout.payoutBatch(owners), compensation);
        for (uint256 i = 0; i < rivals.length; ++i) {
            assertEq(usdc.balanceOf(rivals[i]), 10_000 - 1_000 + BASE_PRICE, "join fee out, its price in");
            assertEq(rivals[i].balance, 0);
        }
        assertEq(checkout.totalClaimable(), 0);
        assertEq(usdc.balanceOf(address(checkout)), checkout.totalFees());
    }

    function test_fork_frontRunIsDetectedAndApplied() public {
        _rivalsJoin();
        X429Checkout.Authorization memory a = _auth(payerPk, 1_000_000, keccak256("fr"));
        vm.prank(relayer);
        IERC3009(BASE_USDC)
            .transferWithAuthorization(
                a.from, address(checkout), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s
            );
        assertTrue(IERC3009(BASE_USDC).authorizationState(payer, a.nonce));
        uint256 payerAfterFrontRun = usdc.balanceOf(payer);
        (uint64 id, uint256 cost, uint256 refund) = _skip(1, 0, a);
        assertEq(checkout.positionOf(id), 1);
        assertEq(usdc.balanceOf(payer), payerAfterFrontRun + refund);
        assertEq(cost + refund, a.value);
        assertEq(usdc.balanceOf(address(checkout)), _contractOwes());
    }

    function test_fork_expiredAndReplayedAuthorizations() public {
        _rivalsJoin();
        X429Checkout.Authorization memory expired = Signatures.authorization(
            BASE_USDC, payerPk, address(checkout), 1_000_000, 0, block.timestamp - 1, keccak256("old")
        );
        vm.prank(operator);
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        checkout.skip(qid, 1, 0, expired);

        X429Checkout.Authorization memory a = _auth(payerPk, 1_000_000, keccak256("ok"));
        _skip(2, 0, a);
        vm.prank(operator);
        vm.expectRevert(X429Checkout.PaymentAlreadySettled.selector);
        checkout.skip(qid, 1, 0, a);
    }

    /// Gas for the worst case the contract allows: a newcomer joins and passes 64 tickets, each owned by
    /// a fresh address (cold storage, zero claimable before). Storage is cooled before measuring so the
    /// number is close to a standalone transaction (minus the 21k intrinsic gas and calldata).
    function test_fork_gas_worstCaseSkip64() public {
        vm.prank(operator);
        uint32 big = checkout.createQueue(256, FEE_BPS, "");
        for (uint256 i = 0; i < 64; ++i) {
            _joinTo(big, 0x9000 + i, 1_000);
        }
        X429Checkout.Authorization memory a = _auth(payerPk, 1_000_000, keccak256("worst"));
        vm.cool(address(checkout));
        vm.cool(BASE_USDC);
        vm.prank(operator);
        vm.startSnapshotGas("skip_join_64_passes");
        checkout.skip(big, 1, 1_000, a);
        uint256 used = vm.stopSnapshotGas();
        emit log_named_uint("skip (join + 64 passes, cold) gas", used);
        assertLt(used, 5_000_000, "fits easily in a Base block");
        assertEq(checkout.positionOf(checkout.activeTicket(big, payer)), 1);
    }

    /// Many low test keys are EIP-7702-delegated on Base mainnet (they have code). Their ECDSA signatures
    /// must still be accepted, as USDC itself does for transferWithAuthorization.
    function test_fork_delegatedEoaCanJoin() public {
        address eoa = vm.addr(0x9000);
        vm.etch(eoa, hex"ef01000000000000000000000000000000000000000001"); // 7702 delegation designator
        assertGt(eoa.code.length, 0);
        uint64 id = _joinTo(qid, 0x9000, 1_000);
        assertEq(checkout.positionOf(id), 1);
    }

    function test_fork_priceAboveCeilingMovesNothing() public {
        _rivalsJoin();
        (,, uint256 compensation, uint256 fee) = checkout.quoteSkip(qid, payer, 1);
        X429Checkout.Authorization memory a = _auth(payerPk, compensation + fee - 1, keccak256("low"));
        uint256 before = usdc.balanceOf(payer);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(X429Checkout.CostExceedsPayment.selector, compensation + fee, a.value));
        checkout.skip(qid, 1, 0, a);
        assertEq(usdc.balanceOf(payer), before);
        assertFalse(IERC3009(BASE_USDC).authorizationState(payer, a.nonce));
    }
}
