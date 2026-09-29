// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

contract SessionVault {
    enum RejectReason {
        NONE,
        REVOKED,
        EXPIRED,
        INVALID_AMOUNT,
        MERCHANT_NOT_ALLOWED,
        OVER_LIMIT,
        PER_PAYMENT_LIMIT,
        INSUFFICIENT_ESCROW,
        INVALID_QUOTE,
        DUPLICATE_ATTEMPT,
        TRANSFER_FAILED
    }

    struct Session {
        address payable owner;
        address agent;
        uint256 totalCapSun;
        uint256 perPaymentCapSun;
        uint256 fundedSun;
        uint256 spentSun;
        uint256 remainingSun;
        uint64 expiresAt;
        bool revoked;
        bytes32 policyHash;
    }

    mapping(bytes32 => Session) public sessions;
    mapping(bytes32 => mapping(address => bool)) public isAllowedMerchant;
    mapping(bytes32 => mapping(bytes32 => uint8)) public attemptStatus;
    mapping(bytes32 => address[]) private _merchants;

    uint256 private _unlocked = 1;

    event SessionCreated(
        bytes32 indexed sessionId,
        address indexed owner,
        address indexed agent,
        uint256 totalCapSun,
        uint256 perPaymentCapSun,
        uint64 expiresAt,
        bytes32 policyHash,
        uint256 initialFundingSun
    );
    event MerchantAllowed(bytes32 indexed sessionId, address indexed merchant);
    event SessionFunded(bytes32 indexed sessionId, uint256 amountSun, uint256 remainingSun);
    event PaymentExecuted(
        bytes32 indexed sessionId,
        bytes32 indexed attemptId,
        address indexed merchant,
        uint256 amountSun,
        bytes32 quoteHash,
        uint256 spentSun,
        uint256 remainingSun
    );
    event AttemptRejected(
        bytes32 indexed sessionId,
        bytes32 indexed attemptId,
        address indexed merchant,
        uint256 amountSun,
        bytes32 quoteHash,
        RejectReason reason
    );
    event SessionRevoked(bytes32 indexed sessionId);
    event SessionWithdrawn(bytes32 indexed sessionId, address indexed owner, uint256 amountSun);

    error SessionExists();
    error SessionNotFound();
    error NotOwner();
    error NotAgent();
    error InvalidPolicy();
    error InvalidMerchant();
    error InvalidAttemptId();
    error SessionInactive();
    error InvalidFunding();
    error WithdrawalUnavailable();
    error TransferFailed();
    error ReentrantCall();

    modifier nonReentrant() {
        if (_unlocked != 1) revert ReentrantCall();
        _unlocked = 2;
        _;
        _unlocked = 1;
    }

    function createSession(
        bytes32 sessionId,
        address agent,
        address[] calldata allowedMerchants,
        uint256 totalCapSun,
        uint256 perPaymentCapSun,
        uint64 expiresAt,
        bytes32 policyHash
    ) external payable nonReentrant {
        if (sessions[sessionId].owner != address(0)) revert SessionExists();
        if (
            sessionId == bytes32(0) || agent == address(0) || policyHash == bytes32(0)
                || totalCapSun == 0 || perPaymentCapSun == 0 || perPaymentCapSun > totalCapSun
                || expiresAt <= block.timestamp || allowedMerchants.length == 0
                || allowedMerchants.length > 16 || msg.value > totalCapSun
        ) revert InvalidPolicy();

        Session storage session = sessions[sessionId];
        session.owner = payable(msg.sender);
        session.agent = agent;
        session.totalCapSun = totalCapSun;
        session.perPaymentCapSun = perPaymentCapSun;
        session.fundedSun = msg.value;
        session.remainingSun = msg.value;
        session.expiresAt = expiresAt;
        session.policyHash = policyHash;

        emit SessionCreated(
            sessionId,
            msg.sender,
            agent,
            totalCapSun,
            perPaymentCapSun,
            expiresAt,
            policyHash,
            msg.value
        );

        for (uint256 i = 0; i < allowedMerchants.length; ++i) {
            address merchant = allowedMerchants[i];
            if (merchant == address(0) || isAllowedMerchant[sessionId][merchant]) {
                revert InvalidMerchant();
            }
            isAllowedMerchant[sessionId][merchant] = true;
            _merchants[sessionId].push(merchant);
            emit MerchantAllowed(sessionId, merchant);
        }
    }

    function fundSession(bytes32 sessionId) external payable nonReentrant {
        Session storage session = _getSession(sessionId);
        if (msg.sender != session.owner) revert NotOwner();
        if (session.revoked || block.timestamp >= session.expiresAt) revert SessionInactive();
        if (msg.value == 0 || msg.value > session.totalCapSun - session.fundedSun) {
            revert InvalidFunding();
        }

        session.fundedSun += msg.value;
        session.remainingSun += msg.value;
        emit SessionFunded(sessionId, msg.value, session.remainingSun);
    }

    function attemptSpend(
        bytes32 sessionId,
        bytes32 attemptId,
        address payable merchant,
        uint256 amountSun,
        bytes32 quoteHash
    ) external nonReentrant returns (bool paid, RejectReason reason) {
        Session storage session = _getSession(sessionId);
        if (msg.sender != session.agent) revert NotAgent();
        if (attemptId == bytes32(0)) revert InvalidAttemptId();

        if (attemptStatus[sessionId][attemptId] != 0) {
            emit AttemptRejected(
                sessionId, attemptId, merchant, amountSun, quoteHash, RejectReason.DUPLICATE_ATTEMPT
            );
            return (false, RejectReason.DUPLICATE_ATTEMPT);
        }

        reason = _evaluate(session, sessionId, merchant, amountSun, quoteHash);
        if (reason != RejectReason.NONE) {
            attemptStatus[sessionId][attemptId] = 1;
            emit AttemptRejected(sessionId, attemptId, merchant, amountSun, quoteHash, reason);
            return (false, reason);
        }

        attemptStatus[sessionId][attemptId] = 2;
        session.spentSun += amountSun;
        session.remainingSun -= amountSun;

        (bool transferred,) = merchant.call{value: amountSun}("");
        if (!transferred) {
            attemptStatus[sessionId][attemptId] = 1;
            session.spentSun -= amountSun;
            session.remainingSun += amountSun;
            emit AttemptRejected(
                sessionId, attemptId, merchant, amountSun, quoteHash, RejectReason.TRANSFER_FAILED
            );
            return (false, RejectReason.TRANSFER_FAILED);
        }

        emit PaymentExecuted(
            sessionId,
            attemptId,
            merchant,
            amountSun,
            quoteHash,
            session.spentSun,
            session.remainingSun
        );
        return (true, RejectReason.NONE);
    }

    function previewSpend(
        bytes32 sessionId,
        address merchant,
        uint256 amountSun,
        bytes32 quoteHash
    ) external view returns (RejectReason) {
        Session storage session = _getSession(sessionId);
        return _evaluate(session, sessionId, merchant, amountSun, quoteHash);
    }

    function revokeSession(bytes32 sessionId) external {
        Session storage session = _getSession(sessionId);
        if (msg.sender != session.owner) revert NotOwner();
        if (session.revoked) revert SessionInactive();
        session.revoked = true;
        emit SessionRevoked(sessionId);
    }

    function withdrawSession(bytes32 sessionId) external nonReentrant {
        Session storage session = _getSession(sessionId);
        if (msg.sender != session.owner) revert NotOwner();
        if (!session.revoked && block.timestamp < session.expiresAt) {
            revert WithdrawalUnavailable();
        }
        uint256 amountSun = session.remainingSun;
        if (amountSun == 0) revert WithdrawalUnavailable();
        session.remainingSun = 0;

        (bool transferred,) = session.owner.call{value: amountSun}("");
        if (!transferred) revert TransferFailed();
        emit SessionWithdrawn(sessionId, session.owner, amountSun);
    }

    function getAllowedMerchants(bytes32 sessionId) external view returns (address[] memory) {
        _getSession(sessionId);
        return _merchants[sessionId];
    }

    function _getSession(bytes32 sessionId) private view returns (Session storage session) {
        session = sessions[sessionId];
        if (session.owner == address(0)) revert SessionNotFound();
    }

    function _evaluate(
        Session storage session,
        bytes32 sessionId,
        address merchant,
        uint256 amountSun,
        bytes32 quoteHash
    ) private view returns (RejectReason) {
        if (session.revoked) return RejectReason.REVOKED;
        if (block.timestamp >= session.expiresAt) return RejectReason.EXPIRED;
        if (amountSun == 0) return RejectReason.INVALID_AMOUNT;
        if (quoteHash == bytes32(0)) return RejectReason.INVALID_QUOTE;
        if (!isAllowedMerchant[sessionId][merchant]) return RejectReason.MERCHANT_NOT_ALLOWED;
        if (amountSun > session.totalCapSun - session.spentSun) return RejectReason.OVER_LIMIT;
        if (amountSun > session.perPaymentCapSun) return RejectReason.PER_PAYMENT_LIMIT;
        if (amountSun > session.remainingSun) return RejectReason.INSUFFICIENT_ESCROW;
        return RejectReason.NONE;
    }
}
