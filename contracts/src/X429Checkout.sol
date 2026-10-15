// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The parts of EIP-3009 (USDC FiatTokenV2) this contract uses.
interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    // forge-lint: disable-next-line(mixed-case-function)
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @title  X429Checkout
/// @notice Paid priority for saturated APIs, settled in USDC (6 decimals) on Base.
///
///         A queue belongs to an operator (the API). Waiting tickets post a skip price: the USDC they
///         want each time someone passes them. A payer moves from position p to position q by paying
///         every ticket in between its own posted price, plus an optional operator fee. Payment is an
///         EIP-3009 `transferWithAuthorization` signed by the payer (the x402 `exact` scheme), pulled
///         into this contract in the same transaction as the queue update. Users never need ETH:
///         joins are EIP-712 signatures the operator relays, claims are EIP-712 signatures anyone may relay.
///
///         One contract serves one operator (fixed at deploy). Compensation is pull based (`claimable`).
///         The operator can create queues, relay joins and skips, serve from the head, set its fee up to
///         10% and withdraw its own fees. Nothing else.
contract X429Checkout is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Waiting,
        Served,
        Left
    }

    struct Ticket {
        // slot 0
        address owner;
        uint32 queueId;
        Status status;
        uint24 timesPassed;
        uint32 joinedAt;
        // slot 1
        uint64 prev; // towards the head, 0 if head
        uint64 next; // towards the tail, 0 if tail
        uint128 skipPrice; // USDC (6 decimals) owed to this ticket each time it is passed
        // slot 2
        uint128 earned; // total received for being passed
        uint128 paid; // total compensation paid to move ahead (fees excluded)
    }

    struct Queue {
        // slot 0
        address operator;
        uint16 feeBps;
        uint32 length;
        uint32 maxLength;
        uint32 skips;
        // slot 1
        uint64 head;
        uint64 tail;
        uint64 joined;
        uint64 served;
        // slot 2
        uint128 totalCompensation;
        uint128 feesAccrued;
        // slot 3
        string meta;
    }

    struct TicketView {
        uint64 id;
        address owner;
        uint128 skipPrice;
        uint32 joinedAt;
        uint24 timesPassed;
        uint128 earned;
        uint128 paid;
    }

    /// @notice An EIP-3009 TransferWithAuthorization to this contract, as carried in an x402 `exact` payload.
    struct Authorization {
        address from;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice Why a front-run payment was refunded instead of applied.
    enum RefundReason {
        None,
        QueueFull,
        NothingToPass,
        TooManyPasses,
        CostExceedsPayment
    }

    struct SkipPlan {
        uint64 ticketId; // 0: the payer has no waiting ticket yet and joins first
        uint32 fromPosition;
        uint32 passes;
        uint256 compensation;
        uint256 fee;
        RefundReason reason; // None if the skip can be applied
    }

    uint16 public constant MAX_FEE_BPS = 1000; // 10%
    uint32 public constant MAX_PASSES = 64;
    uint32 public constant MAX_QUEUE_LENGTH = 256;

    // keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
    bytes32 public constant JOIN_TYPEHASH =
        keccak256("Join(address owner,uint32 queueId,uint128 skipPrice,bytes32 nonce,uint256 deadline)");
    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("Claim(address owner,address recipient,bytes32 nonce,uint256 deadline)");

    IERC20 public immutable usdc;
    /// @notice The only account that creates queues, relays joins and skips, and serves. Fixed at deploy:
    ///         an x402 payment names this contract as `payTo`, so it can only ever be settled by this
    ///         operator (one contract per operator, see SPEC §10).
    address public immutable operator;

    uint32 public queueCount;
    uint64 public ticketCount;
    mapping(uint32 => Queue) private _queues;
    mapping(uint64 => Ticket) public tickets;
    /// @notice The waiting ticket of an owner in a queue (0 if none). One per owner per queue.
    mapping(uint32 => mapping(address => uint64)) public activeTicket;
    /// @notice USDC an address may claim: compensation for being passed, plus refunds that could not be pushed.
    mapping(address => uint256) public claimable;
    /// @notice EIP-712 nonces (Join, Claim) already used or cancelled, per signer. Unordered, like EIP-3009.
    mapping(address => mapping(bytes32 => bool)) public nonceUsed;
    /// @notice EIP-3009 authorizations this contract has accounted for (applied or refunded).
    mapping(address => mapping(bytes32 => bool)) public paymentSettled;

    /// @notice Sum of `claimable`. With `totalFees` this is every USDC the contract owes.
    uint256 public totalClaimable;
    /// @notice Sum of `feesAccrued` over all queues.
    uint256 public totalFees;

    event QueueCreated(uint32 indexed queueId, address indexed operator, uint32 maxLength, uint16 feeBps, string meta);
    event FeeSet(uint32 indexed queueId, uint16 feeBps);
    event Joined(
        uint32 indexed queueId, uint64 indexed ticketId, address indexed owner, uint128 skipPrice, uint32 position
    );
    event Passed(
        uint32 indexed queueId,
        uint64 indexed passedTicketId,
        address indexed passedOwner,
        uint64 byTicketId,
        uint128 amount
    );
    event Skipped(
        uint32 indexed queueId,
        uint64 indexed ticketId,
        address indexed owner,
        uint32 fromPosition,
        uint32 toPosition,
        uint256 compensation,
        uint256 fee,
        uint256 refund
    );
    event PaymentReceived(address indexed from, bytes32 indexed nonce, uint256 value, bool frontRun);
    event PaymentRefunded(address indexed from, bytes32 indexed nonce, uint256 value, RefundReason reason);
    event RefundCredited(address indexed to, uint256 amount);
    event Served(
        uint32 indexed queueId,
        uint64 indexed ticketId,
        address indexed owner,
        uint32 waited,
        uint24 timesPassed,
        uint128 earned,
        uint128 paid
    );
    event Left(uint32 indexed queueId, uint64 indexed ticketId, address indexed owner);
    event Claimed(address indexed owner, address indexed recipient, uint256 amount);
    event NonceUsed(address indexed owner, bytes32 indexed nonce);
    event FeesWithdrawn(uint32 indexed queueId, address indexed to, uint256 amount);

    error UnknownQueue();
    error InvalidMaxLength();
    error InvalidFee();
    error InvalidPosition();
    error NotOperator();
    error NotTicketOwner();
    error NotWaiting();
    error AlreadyWaiting();
    error QueueFull();
    error NothingToPass();
    error TooManyPasses(uint32 passes);
    error CostExceedsPayment(uint256 cost, uint256 value);
    error PaymentAlreadySettled();
    error PaymentNotReceived();
    error InvalidSignature();
    error SignatureExpired();
    error NonceAlreadyUsed();
    error NothingToClaim();
    error InvalidRecipient();

    constructor(IERC20 usdc_, address operator_) EIP712("x429 Checkout", "1") {
        if (operator_ == address(0)) revert NotOperator();
        usdc = usdc_;
        operator = operator_;
    }

    // ------------------------------------------------------------------ operator

    /// @notice Open a queue (operator only).
    function createQueue(uint32 maxLength, uint16 feeBps, string calldata meta) external returns (uint32 queueId) {
        if (msg.sender != operator) revert NotOperator();
        if (maxLength == 0 || maxLength > MAX_QUEUE_LENGTH) revert InvalidMaxLength();
        if (feeBps > MAX_FEE_BPS) revert InvalidFee();
        queueId = ++queueCount;
        Queue storage q = _queues[queueId];
        q.operator = msg.sender;
        q.maxLength = maxLength;
        q.feeBps = feeBps;
        q.meta = meta;
        emit QueueCreated(queueId, msg.sender, maxLength, feeBps, meta);
    }

    function setFee(uint32 queueId, uint16 feeBps) external {
        Queue storage q = _operatorQueue(queueId);
        if (feeBps > MAX_FEE_BPS) revert InvalidFee();
        q.feeBps = feeBps;
        emit FeeSet(queueId, feeBps);
    }

    function withdrawFees(uint32 queueId, address to) external nonReentrant returns (uint256 amount) {
        Queue storage q = _operatorQueue(queueId);
        if (to == address(0)) revert InvalidRecipient();
        amount = q.feesAccrued;
        q.feesAccrued = 0;
        totalFees -= amount;
        emit FeesWithdrawn(queueId, to, amount);
        if (amount > 0) usdc.safeTransfer(to, amount);
    }

    /// @notice Serve up to `count` tickets from the head, in order.
    function serve(uint32 queueId, uint32 count) external returns (uint32 servedCount) {
        Queue storage q = _operatorQueue(queueId);
        while (servedCount < count) {
            uint64 id = q.head;
            if (id == 0) break;
            Ticket storage t = tickets[id];
            _unlink(q, t);
            t.status = Status.Served;
            delete activeTicket[queueId][t.owner];
            unchecked {
                --q.length;
                ++q.served;
                ++servedCount;
            }
            // uint32 seconds last until 2106
            // forge-lint: disable-next-line(unsafe-typecast)
            emit Served(queueId, id, t.owner, uint32(block.timestamp) - t.joinedAt, t.timesPassed, t.earned, t.paid);
        }
    }

    /// @notice Settle an x402 `exact` payment and move the payer to `targetPosition` (1 = served next).
    ///
    ///         The payer is `auth.from`. If they have no waiting ticket, one is created at the tail with
    ///         `newTicketSkipPrice` first (join + skip in one payment). The payer is charged the actual cost
    ///         at execution time: the posted price of every ticket passed plus the operator fee. The rest of
    ///         `auth.value` is refunded to the payer in the same transaction.
    ///
    ///         Front-run: anyone can submit a USDC authorization straight to the token. If the authorization
    ///         is already used, the contract checks the signature and that unaccounted USDC covers it, then
    ///         applies the skip, or refunds the whole value if the skip is no longer possible. Normal
    ///         (not front-run) payments revert instead, so nothing moves and the authorization stays usable.
    ///
    ///         Only the operator may call this. The EIP-3009 signature binds the amount and this contract
    ///         (and so this operator), not the queue or the target position: the operator relays exactly
    ///         what the payer asked for over HTTP. If anyone could settle, anyone who saw a payment header
    ///         could spend it on a queue of their own.
    function skip(uint32 queueId, uint32 targetPosition, uint128 newTicketSkipPrice, Authorization calldata auth)
        external
        nonReentrant
        returns (uint64 ticketId, uint256 cost, uint256 refund)
    {
        Queue storage q = _operatorQueue(queueId);
        if (targetPosition == 0) revert InvalidPosition();
        if (paymentSettled[auth.from][auth.nonce]) revert PaymentAlreadySettled();
        paymentSettled[auth.from][auth.nonce] = true;

        SkipPlan memory p = _plan(q, queueId, auth.from, targetPosition, auth.value);
        ticketId = p.ticketId;
        _collect(auth, p);

        if (p.reason != RefundReason.None) {
            // only reachable for a front-run payment: the money is here but the skip is impossible
            emit PaymentRefunded(auth.from, auth.nonce, auth.value, p.reason);
            _push(auth.from, auth.value);
            return (ticketId, 0, auth.value);
        }

        if (ticketId == 0) ticketId = _join(queueId, auth.from, newTicketSkipPrice);
        _pass(q, queueId, ticketId, p.passes);
        // casting is safe: compensation <= cost <= auth.value, and USDC supply is far below 2**128
        // forge-lint: disable-next-line(unsafe-typecast)
        tickets[ticketId].paid += uint128(p.compensation);
        // forge-lint: disable-next-line(unsafe-typecast)
        q.totalCompensation += uint128(p.compensation);
        // forge-lint: disable-next-line(unsafe-typecast)
        q.feesAccrued += uint128(p.fee);
        totalFees += p.fee;
        unchecked {
            ++q.skips;
        }
        cost = p.compensation + p.fee;
        refund = auth.value - cost;
        emit Skipped(queueId, ticketId, auth.from, p.fromPosition, targetPosition, p.compensation, p.fee, refund);
        _push(auth.from, refund);
    }

    // ------------------------------------------------------------------ clients

    /// @notice Join on behalf of `owner`, who signed an EIP-712 `Join`. Relayed by the operator, who pays
    ///         the gas. Joins go through the operator so it can rate-limit them: a free join that anyone
    ///         could send would let a spammer fill the queue to `maxLength` and lock out every newcomer.
    function joinWithSig(
        address owner,
        uint32 queueId,
        uint128 skipPrice,
        bytes32 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint64 ticketId) {
        _operatorQueue(queueId);
        _useSignature(
            owner, keccak256(abi.encode(JOIN_TYPEHASH, owner, queueId, skipPrice, nonce, deadline)), nonce, deadline, signature
        );
        ticketId = _join(queueId, owner, skipPrice);
    }

    /// @notice Leave a queue. Whatever the ticket earned stays claimable.
    function leave(uint64 ticketId) external {
        Ticket storage t = tickets[ticketId];
        if (t.status != Status.Waiting) revert NotWaiting();
        if (t.owner != msg.sender) revert NotTicketOwner();
        Queue storage q = _queues[t.queueId];
        _unlink(q, t);
        t.status = Status.Left;
        delete activeTicket[t.queueId][msg.sender];
        unchecked {
            --q.length;
        }
        emit Left(t.queueId, ticketId, msg.sender);
    }

    /// @notice Withdraw your claimable USDC to `recipient`, paying your own gas.
    function claim(address recipient) external nonReentrant returns (uint256) {
        return _claim(msg.sender, recipient);
    }

    /// @notice Withdraw `owner`'s claimable USDC to `recipient`, authorized by an EIP-712 `Claim`. Anyone may relay it.
    function claimWithSig(address owner, address recipient, bytes32 nonce, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (uint256)
    {
        _useSignature(
            owner, keccak256(abi.encode(CLAIM_TYPEHASH, owner, recipient, nonce, deadline)), nonce, deadline, signature
        );
        return _claim(owner, recipient);
    }

    /// @notice Burn an unused Join/Claim nonce so a signature you handed out can never be relayed.
    function cancelNonce(bytes32 nonce) external {
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed();
        nonceUsed[msg.sender][nonce] = true;
        emit NonceUsed(msg.sender, nonce);
    }

    // ------------------------------------------------------------------ views

    function queueInfo(uint32 queueId) external view returns (Queue memory) {
        return _queue(queueId);
    }

    /// @notice Waiting tickets in serving order (index 0 is served next).
    function getQueue(uint32 queueId, uint32 offset, uint32 limit) external view returns (TicketView[] memory list) {
        Queue storage q = _queue(queueId);
        uint256 len = q.length;
        if (offset >= len) return new TicketView[](0);
        uint256 n = len - offset;
        if (n > limit) n = limit;
        list = new TicketView[](n);
        uint64 id = q.head;
        for (uint256 i = 0; i < offset; ++i) {
            id = tickets[id].next;
        }
        for (uint256 i = 0; i < n; ++i) {
            Ticket storage t = tickets[id];
            list[i] = TicketView(id, t.owner, t.skipPrice, t.joinedAt, t.timesPassed, t.earned, t.paid);
            id = t.next;
        }
    }

    /// @notice 1-based position of a waiting ticket, 0 if it is not waiting.
    function positionOf(uint64 ticketId) external view returns (uint32) {
        if (tickets[ticketId].status != Status.Waiting) return 0;
        return _position(ticketId);
    }

    /// @notice What `owner` would pay right now to reach `targetPosition`. A payer without a ticket
    ///         is quoted from the tail (join + skip).
    function quoteSkip(uint32 queueId, address owner, uint32 targetPosition)
        external
        view
        returns (uint32 fromPosition, uint32 passes, uint256 compensation, uint256 fee)
    {
        Queue storage q = _queue(queueId);
        if (targetPosition == 0) revert InvalidPosition();
        uint64 id = activeTicket[queueId][owner];
        fromPosition = id == 0 ? q.length + 1 : _position(id);
        passes = fromPosition > targetPosition ? fromPosition - targetPosition : 0;
        if (passes > MAX_PASSES) revert TooManyPasses(passes);
        compensation = _sumAhead(id == 0 ? q.tail : tickets[id].prev, passes);
        fee = compensation * q.feeBps / 10_000;
    }

    /// @notice The EIP-712 domain separator used for Join and Claim.
    // forge-lint: disable-next-line(mixed-case-function)
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ------------------------------------------------------------------ internals

    function _join(uint32 queueId, address owner, uint128 skipPrice) private returns (uint64 ticketId) {
        Queue storage q = _queue(queueId);
        if (activeTicket[queueId][owner] != 0) revert AlreadyWaiting();
        if (q.length >= q.maxLength) revert QueueFull();
        ticketId = ++ticketCount;
        Ticket storage t = tickets[ticketId];
        t.owner = owner;
        t.queueId = queueId;
        t.status = Status.Waiting;
        // forge-lint: disable-next-line(unsafe-typecast)
        t.joinedAt = uint32(block.timestamp);
        t.skipPrice = skipPrice;
        uint64 tail = q.tail;
        if (tail == 0) {
            q.head = ticketId;
        } else {
            t.prev = tail;
            tickets[tail].next = ticketId;
        }
        q.tail = ticketId;
        activeTicket[queueId][owner] = ticketId;
        uint32 position = ++q.length;
        unchecked {
            ++q.joined;
        }
        emit Joined(queueId, ticketId, owner, skipPrice, position);
    }

    /// @dev Works out what a skip would do right now, without changing anything.
    function _plan(Queue storage q, uint32 queueId, address owner, uint32 targetPosition, uint256 value)
        private
        view
        returns (SkipPlan memory p)
    {
        p.ticketId = activeTicket[queueId][owner];
        p.fromPosition = p.ticketId == 0 ? q.length + 1 : _position(p.ticketId);
        p.passes = p.fromPosition > targetPosition ? p.fromPosition - targetPosition : 0;
        p.compensation = _sumAhead(p.ticketId == 0 ? q.tail : tickets[p.ticketId].prev, p.passes);
        p.fee = p.compensation * q.feeBps / 10_000;
        if (p.ticketId == 0 && q.length >= q.maxLength) p.reason = RefundReason.QueueFull;
        else if (p.passes == 0) p.reason = RefundReason.NothingToPass;
        else if (p.passes > MAX_PASSES) p.reason = RefundReason.TooManyPasses;
        else if (p.compensation + p.fee > value) p.reason = RefundReason.CostExceedsPayment;
    }

    /// @dev Brings the payment in. A normal payment is pulled with transferWithAuthorization, and only if the
    ///      skip can be applied (otherwise revert: nothing moves, the authorization stays unused). A front-run
    ///      payment is already here; it is verified and then applied or refunded by the caller.
    function _collect(Authorization calldata auth, SkipPlan memory p) private {
        bool frontRun = IERC3009(address(usdc)).authorizationState(auth.from, auth.nonce);
        if (frontRun) {
            _checkFrontRunPayment(auth);
        } else {
            if (p.reason == RefundReason.QueueFull) revert QueueFull();
            if (p.reason == RefundReason.NothingToPass) revert NothingToPass();
            if (p.reason == RefundReason.TooManyPasses) revert TooManyPasses(p.passes);
            if (p.reason == RefundReason.CostExceedsPayment) {
                revert CostExceedsPayment(p.compensation + p.fee, auth.value);
            }
            IERC3009(address(usdc))
                .transferWithAuthorization(
                    auth.from,
                    address(this),
                    auth.value,
                    auth.validAfter,
                    auth.validBefore,
                    auth.nonce,
                    auth.v,
                    auth.r,
                    auth.s
                );
        }
        emit PaymentReceived(auth.from, auth.nonce, auth.value, frontRun);
    }

    /// @dev Credits the `passes` tickets directly ahead of `ticketId` and re-links it in front of them.
    function _pass(Queue storage q, uint32 queueId, uint64 ticketId, uint32 passes) private {
        Ticket storage t = tickets[ticketId];
        uint64 cursor = t.prev;
        uint64 furthest;
        for (uint32 i = 0; i < passes; ++i) {
            Ticket storage a = tickets[cursor];
            uint128 price = a.skipPrice;
            a.earned += price;
            a.timesPassed += 1;
            claimable[a.owner] += price;
            totalClaimable += price;
            emit Passed(queueId, cursor, a.owner, ticketId, price);
            furthest = cursor;
            cursor = a.prev;
        }
        _unlink(q, t);
        _insertBefore(q, ticketId, t, furthest);
    }

    /// @dev Sum of the skip prices of `count` tickets walking towards the head from `cursor` (inclusive).
    function _sumAhead(uint64 cursor, uint32 count) private view returns (uint256 sum) {
        for (uint32 i = 0; i < count && cursor != 0; ++i) {
            Ticket storage a = tickets[cursor];
            sum += a.skipPrice;
            cursor = a.prev;
        }
    }

    function _position(uint64 ticketId) private view returns (uint32 position) {
        position = 1;
        for (uint64 p = tickets[ticketId].prev; p != 0; p = tickets[p].prev) {
            ++position;
        }
    }

    /// @dev A front-run authorization: the token already marked the nonce used. Make sure it was this exact
    ///      authorization (signed by `from`, to this contract) and that the USDC really arrived, i.e. the
    ///      contract holds at least `value` more than everything it owes.
    function _checkFrontRunPayment(Authorization calldata auth) private view {
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                auth.from,
                address(this),
                auth.value,
                auth.validAfter,
                auth.validBefore,
                auth.nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC3009(address(usdc)).DOMAIN_SEPARATOR(), structHash));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, auth.v, auth.r, auth.s);
        if (err != ECDSA.RecoverError.NoError || signer != auth.from) revert InvalidSignature();
        if (usdc.balanceOf(address(this)) < totalClaimable + totalFees + auth.value) revert PaymentNotReceived();
    }

    function _useSignature(address owner, bytes32 structHash, bytes32 nonce, uint256 deadline, bytes calldata signature)
        private
    {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (nonceUsed[owner][nonce]) revert NonceAlreadyUsed();
        // ECDSA first, then ERC-1271: an EIP-7702-delegated EOA has code but still signs with its key
        bytes32 digest = _hashTypedDataV4(structHash);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        bool ok = err == ECDSA.RecoverError.NoError && recovered == owner;
        if (!ok && owner.code.length > 0) ok = SignatureChecker.isValidERC1271SignatureNow(owner, digest, signature);
        if (!ok) revert InvalidSignature();
        nonceUsed[owner][nonce] = true;
        emit NonceUsed(owner, nonce);
    }

    function _claim(address owner, address recipient) private returns (uint256 amount) {
        if (recipient == address(0)) revert InvalidRecipient();
        amount = claimable[owner];
        if (amount == 0) revert NothingToClaim();
        claimable[owner] = 0;
        totalClaimable -= amount;
        emit Claimed(owner, recipient, amount);
        usdc.safeTransfer(recipient, amount);
    }

    /// @dev Sends USDC to `to`; if the token refuses (e.g. a blocklisted address), credits it to `claimable`.
    function _push(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) return;
        claimable[to] += amount;
        totalClaimable += amount;
        emit RefundCredited(to, amount);
    }

    function _unlink(Queue storage q, Ticket storage t) private {
        uint64 p = t.prev;
        uint64 n = t.next;
        if (p == 0) q.head = n;
        else tickets[p].next = n;
        if (n == 0) q.tail = p;
        else tickets[n].prev = p;
        t.prev = 0;
        t.next = 0;
    }

    function _insertBefore(Queue storage q, uint64 id, Ticket storage t, uint64 beforeId) private {
        Ticket storage b = tickets[beforeId];
        uint64 p = b.prev;
        t.prev = p;
        t.next = beforeId;
        b.prev = id;
        if (p == 0) q.head = id;
        else tickets[p].next = id;
    }

    function _queue(uint32 queueId) private view returns (Queue storage q) {
        q = _queues[queueId];
        if (q.operator == address(0)) revert UnknownQueue();
    }

    function _operatorQueue(uint32 queueId) private view returns (Queue storage q) {
        q = _queue(queueId);
        if (msg.sender != q.operator) revert NotOperator();
    }
}
