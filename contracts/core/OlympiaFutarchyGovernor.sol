// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./WelfareMetricRegistry.sol";
import "./ProposalRegistry.sol";
import "../markets/ConditionalMarketFactory.sol";
import "../privacy/PrivacyCoordinator.sol";
import "../oracles/OracleResolver.sol";
import "../security/RagequitModule.sol";
import "../access/TieredRoleManager.sol";

/**
 * @title OlympiaFutarchyGovernor
 * @notice ECIP-1117 futarchy governance coordinator with paired prediction markets
 * @dev Creates TWO conditional markets per proposal:
 *   - Approval market: "Welfare metric conditional on proposal passing"
 *   - Rejection market: "Welfare metric conditional on proposal failing"
 *
 * Decision rule: If approval market final price > rejection market final price,
 * the proposal is approved. Otherwise it is rejected.
 *
 * After decision:
 *   - The winning market resolves based on actual welfare metric outcomes
 *   - The losing market is voided (positions refunded at cost)
 *
 * Conforms to ECIP-1112 Treasury interface — cannot bypass or modify Treasury access controls.
 */
contract OlympiaFutarchyGovernor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // =========================================================================
    // Dependencies
    // =========================================================================

    WelfareMetricRegistry public welfareRegistry;
    ProposalRegistry public proposalRegistry;
    ConditionalMarketFactory public marketFactory;
    PrivacyCoordinator public privacyCoordinator;
    OracleResolver public oracleResolver;
    RagequitModule public ragequitModule;
    TieredRoleManager public roleManager;

    /// @notice ERC20 collateral token for prediction markets (required for CTF)
    address public marketCollateralToken;

    // =========================================================================
    // Proposal lifecycle
    // =========================================================================

    enum ProposalPhase {
        Submission,       // Proposal submitted, markets not yet created
        MarketTrading,    // Paired markets active, participants trading
        DecisionPending,  // Trading ended, awaiting decision computation
        Approved,         // Approval market price > rejection market price
        Rejected,         // Rejection market price >= approval market price
        Execution,        // Approved + timelock passed, ready to execute
        Completed,        // Funds disbursed
        Voided            // Cancelled or emergency stopped
    }

    struct FutarchyProposal {
        uint256 proposalId;          // ID in ProposalRegistry
        uint256 approvalMarketId;    // Market: "welfare if approved"
        uint256 rejectionMarketId;   // Market: "welfare if rejected"
        uint256 welfareMetricId;     // Which welfare metric these markets predict
        ProposalPhase phase;
        uint256 createdAt;
        uint256 tradingEndTime;
        uint256 executionTime;       // Earliest execution (after timelock)
        bool executed;
        bool approvalDecision;       // true = approved by market signal
    }

    mapping(uint256 => FutarchyProposal) public futarchyProposals;
    uint256 public futarchyProposalCount;

    // =========================================================================
    // Treasury & governance parameters
    // =========================================================================

    address public treasuryVault;
    uint256 public constant MAX_DAILY_SPENDING = 100_000 ether;
    mapping(uint256 => uint256) public dailySpending;

    uint256 public constant MIN_TIMELOCK = 2 days;
    uint256 public constant MIN_TRADING_PERIOD = 7 days;
    uint256 public constant MAX_TRADING_PERIOD = 21 days;

    // =========================================================================
    // Emergency controls
    // =========================================================================

    bool public paused;
    mapping(address => bool) public guardians;
    bool private _initialized;

    // =========================================================================
    // Events
    // =========================================================================

    event FutarchyProposalCreated(
        uint256 indexed futarchyId,
        uint256 indexed proposalId,
        uint256 approvalMarketId,
        uint256 rejectionMarketId,
        uint256 welfareMetricId
    );
    event ProposalPhaseChanged(uint256 indexed futarchyId, ProposalPhase newPhase);
    event FutarchyDecision(
        uint256 indexed futarchyId,
        bool approved,
        uint256 approvalPrice,
        uint256 rejectionPrice
    );
    event ProposalExecuted(uint256 indexed futarchyId, address recipient, uint256 amount);
    event MarketVoided(uint256 indexed futarchyId, uint256 indexed marketId);
    event EmergencyPauseToggled(bool paused);
    event GuardianUpdated(address indexed guardian, bool status);

    // =========================================================================
    // Modifiers
    // =========================================================================

    modifier whenNotPaused() {
        require(!paused, "System paused");
        _;
    }

    modifier onlyGuardian() {
        require(guardians[msg.sender] || msg.sender == owner(), "Not guardian");
        _;
    }

    // =========================================================================
    // Constructor & initialization
    // =========================================================================

    constructor() Ownable(msg.sender) {}

    function initialize(
        address initialOwner,
        address _welfareRegistry,
        address _proposalRegistry,
        address _marketFactory,
        address _privacyCoordinator,
        address _oracleResolver,
        address payable _ragequitModule,
        address _treasuryVault
    ) external {
        require(!_initialized, "Already initialized");
        require(initialOwner != address(0), "Invalid owner");
        require(_welfareRegistry != address(0), "Invalid welfare registry");
        require(_proposalRegistry != address(0), "Invalid proposal registry");
        require(_marketFactory != address(0), "Invalid market factory");
        require(_privacyCoordinator != address(0), "Invalid privacy coordinator");
        require(_oracleResolver != address(0), "Invalid oracle resolver");
        require(_ragequitModule != address(0), "Invalid ragequit module");
        require(_treasuryVault != address(0), "Invalid treasury vault");

        _initialized = true;
        welfareRegistry = WelfareMetricRegistry(_welfareRegistry);
        proposalRegistry = ProposalRegistry(_proposalRegistry);
        marketFactory = ConditionalMarketFactory(_marketFactory);
        privacyCoordinator = PrivacyCoordinator(_privacyCoordinator);
        oracleResolver = OracleResolver(_oracleResolver);
        ragequitModule = RagequitModule(_ragequitModule);
        treasuryVault = _treasuryVault;
        guardians[initialOwner] = true;
        _transferOwnership(initialOwner);
    }

    function setRoleManager(address _roleManager) external onlyOwner {
        require(_roleManager != address(0), "Invalid role manager");
        require(address(roleManager) == address(0), "Already set");
        roleManager = TieredRoleManager(_roleManager);
    }

    function setMarketCollateralToken(address _collateralToken) external onlyOwner {
        require(_collateralToken != address(0), "Invalid collateral token");
        marketCollateralToken = _collateralToken;
    }

    // =========================================================================
    // ECIP-1117: Paired market creation
    // =========================================================================

    /**
     * @notice Create a futarchy governance proposal with paired prediction markets
     * @dev Creates two conditional markets per ECIP-1117:
     *   - Approval market: predicts welfare metric if proposal passes
     *   - Rejection market: predicts welfare metric if proposal fails
     * @param proposalId ID from ProposalRegistry
     * @param welfareMetricId Which welfare metric both markets predict
     * @param liquidityAmount Initial collateral per market
     * @param liquidityParameter LMSR beta parameter (higher = more liquid)
     * @param tradingPeriod Duration of trading window in seconds
     * @return futarchyId ID of the futarchy proposal
     */
    function createFutarchyProposal(
        uint256 proposalId,
        uint256 welfareMetricId,
        uint256 liquidityAmount,
        uint256 liquidityParameter,
        uint256 tradingPeriod
    ) external onlyOwner whenNotPaused returns (uint256 futarchyId) {
        require(tradingPeriod >= MIN_TRADING_PERIOD, "Trading period too short");
        require(tradingPeriod <= MAX_TRADING_PERIOD, "Trading period too long");
        require(marketCollateralToken != address(0), "Collateral token not set");

        // Verify welfare metric exists and is active
        WelfareMetricRegistry.WelfareMetric memory metric = welfareRegistry.getMetric(welfareMetricId);
        require(metric.active, "Welfare metric not active");
        require(bytes(metric.name).length > 0, "Welfare metric not found");

        futarchyId = futarchyProposalCount++;

        // Create APPROVAL market: "Welfare if proposal passes"
        uint256 approvalMarketId = marketFactory.deployMarketPair(
            _encodeApprovalProposalId(proposalId),
            marketCollateralToken,
            liquidityAmount,
            liquidityParameter,
            tradingPeriod,
            ConditionalMarketFactory.BetType.PassFail
        );

        // Create REJECTION market: "Welfare if proposal fails"
        uint256 rejectionMarketId = marketFactory.deployMarketPair(
            _encodeRejectionProposalId(proposalId),
            marketCollateralToken,
            liquidityAmount,
            liquidityParameter,
            tradingPeriod,
            ConditionalMarketFactory.BetType.PassFail
        );

        futarchyProposals[futarchyId] = FutarchyProposal({
            proposalId: proposalId,
            approvalMarketId: approvalMarketId,
            rejectionMarketId: rejectionMarketId,
            welfareMetricId: welfareMetricId,
            phase: ProposalPhase.MarketTrading,
            createdAt: block.timestamp,
            tradingEndTime: block.timestamp + tradingPeriod,
            executionTime: 0,
            executed: false,
            approvalDecision: false
        });

        emit FutarchyProposalCreated(
            futarchyId,
            proposalId,
            approvalMarketId,
            rejectionMarketId,
            welfareMetricId
        );
        emit ProposalPhaseChanged(futarchyId, ProposalPhase.MarketTrading);
    }

    // =========================================================================
    // ECIP-1117: Decision computation
    // =========================================================================

    /**
     * @notice End trading and compute the futarchy decision
     * @dev Compares approval vs rejection market prices.
     *   The "losing" market is voided (participants get refunds).
     *   The "winning" market continues to oracle resolution.
     * @param futarchyId ID of the futarchy proposal
     */
    function computeDecision(uint256 futarchyId) external onlyOwner whenNotPaused {
        FutarchyProposal storage fp = futarchyProposals[futarchyId];
        require(fp.phase == ProposalPhase.MarketTrading, "Not in trading phase");
        require(block.timestamp >= fp.tradingEndTime, "Trading period not ended");

        // End trading on both markets
        marketFactory.endTrading(fp.approvalMarketId);
        marketFactory.endTrading(fp.rejectionMarketId);

        // Get final market prices (pass quantities represent demand for "yes" outcome)
        uint256 approvalPrice = _getMarketPrice(fp.approvalMarketId);
        uint256 rejectionPrice = _getMarketPrice(fp.rejectionMarketId);

        // ECIP-1117 decision rule:
        // Approve if approval market price strictly exceeds rejection market price
        bool approved = approvalPrice > rejectionPrice;
        fp.approvalDecision = approved;

        if (approved) {
            // Proposal approved: void rejection market, continue approval market
            fp.phase = ProposalPhase.Approved;
            _voidMarket(futarchyId, fp.rejectionMarketId);
        } else {
            // Proposal rejected: void approval market
            fp.phase = ProposalPhase.Rejected;
            _voidMarket(futarchyId, fp.approvalMarketId);
        }

        emit FutarchyDecision(futarchyId, approved, approvalPrice, rejectionPrice);
        emit ProposalPhaseChanged(futarchyId, fp.phase);
    }

    /**
     * @notice Finalize an approved proposal after oracle resolution
     * @dev Resolves the winning market based on actual welfare metric outcome,
     *   then queues execution with timelock.
     * @param futarchyId ID of the futarchy proposal
     */
    function finalizeApproval(uint256 futarchyId) external onlyOwner whenNotPaused {
        FutarchyProposal storage fp = futarchyProposals[futarchyId];
        require(fp.phase == ProposalPhase.Approved, "Not in approved phase");

        // Get oracle resolution for the proposal
        (
            ,
            uint256 passValue,
            uint256 failValue,
            bool finalized
        ) = oracleResolver.getResolution(fp.proposalId);
        require(finalized, "Oracle resolution not finalized");

        // Resolve the winning (approval) market based on actual welfare outcome
        marketFactory.resolveMarket(fp.approvalMarketId, passValue, failValue);

        // Queue execution with timelock
        fp.phase = ProposalPhase.Execution;
        fp.executionTime = block.timestamp + MIN_TIMELOCK;

        // Open ragequit window
        ragequitModule.openRagequitWindow(
            fp.proposalId,
            block.timestamp,
            fp.executionTime
        );

        emit ProposalPhaseChanged(futarchyId, ProposalPhase.Execution);
    }

    /**
     * @notice Execute an approved proposal after timelock
     * @param futarchyId ID of the futarchy proposal
     */
    function executeProposal(uint256 futarchyId) external onlyOwner whenNotPaused nonReentrant {
        FutarchyProposal storage fp = futarchyProposals[futarchyId];
        require(fp.phase == ProposalPhase.Execution, "Not in execution phase");
        require(block.timestamp >= fp.executionTime, "Timelock not expired");
        require(!fp.executed, "Already executed");

        // Get proposal details from registry
        (
            ,
            ,
            ,
            uint256 fundingAmount,
            address recipient,
            ,
            ProposalRegistry.ProposalStatus status,
            address fundingToken,
            uint256 startDate,
            uint256 executionDeadline
        ) = proposalRegistry.getProposal(fp.proposalId);

        require(status == ProposalRegistry.ProposalStatus.Active, "Proposal not active");
        require(block.timestamp >= startDate, "Start date not reached");
        require(block.timestamp <= executionDeadline, "Execution deadline passed");

        // Check daily spending limit
        uint256 today = block.timestamp / 1 days;
        require(dailySpending[today] + fundingAmount <= MAX_DAILY_SPENDING, "Daily limit exceeded");

        // Update state before external calls (CEI)
        fp.executed = true;
        fp.phase = ProposalPhase.Completed;
        dailySpending[today] += fundingAmount;

        // Execute fund transfer
        if (fundingToken == address(0)) {
            (bool success, ) = payable(recipient).call{value: fundingAmount}("");
            require(success, "Transfer failed");
        } else {
            IERC20(fundingToken).safeTransfer(recipient, fundingAmount);
        }

        ragequitModule.markProposalExecuted(fp.proposalId);
        proposalRegistry.returnBond(fp.proposalId);

        emit ProposalExecuted(futarchyId, recipient, fundingAmount);
        emit ProposalPhaseChanged(futarchyId, ProposalPhase.Completed);
    }

    // =========================================================================
    // Market price oracle
    // =========================================================================

    /**
     * @notice Get the pass token price from ConditionalMarketFactory
     * @dev Uses the existing getPrices() function which returns 18-decimal prices.
     *   passPrice represents market confidence that the outcome will be favorable.
     * @param marketId ID of the market in ConditionalMarketFactory
     * @return price Pass price in 18-decimal precision (0.5e18 = 50%)
     */
    function _getMarketPrice(uint256 marketId) internal view returns (uint256 price) {
        (uint256 passPrice, ) = marketFactory.getPrices(marketId);
        return passPrice;
    }

    /**
     * @notice Get the current price of a market (public view)
     * @param marketId ID of the market
     * @return price Pass price in 18-decimal precision
     */
    function getMarketPrice(uint256 marketId) external view returns (uint256) {
        return _getMarketPrice(marketId);
    }

    // =========================================================================
    // Market voiding
    // =========================================================================

    /**
     * @notice Void a losing market — cancel it so participants can reclaim collateral
     * @param futarchyId ID of the futarchy proposal (for event)
     * @param marketId ID of the market to void
     */
    function _voidMarket(uint256 futarchyId, uint256 marketId) internal {
        // Cancel the market — ConditionalMarketFactory handles refund logic
        marketFactory.cancelMarket(marketId);
        emit MarketVoided(futarchyId, marketId);
    }

    // =========================================================================
    // Proposal ID encoding (to avoid collisions in ConditionalMarketFactory)
    // =========================================================================

    /**
     * @dev Encode a proposal ID for the approval market
     *   Uses high bit to distinguish from rejection market
     */
    function _encodeApprovalProposalId(uint256 proposalId) internal pure returns (uint256) {
        return proposalId * 2;
    }

    /**
     * @dev Encode a proposal ID for the rejection market
     */
    function _encodeRejectionProposalId(uint256 proposalId) internal pure returns (uint256) {
        return proposalId * 2 + 1;
    }

    // =========================================================================
    // Emergency & admin
    // =========================================================================

    function togglePause() external onlyGuardian {
        paused = !paused;
        emit EmergencyPauseToggled(paused);
    }

    function updateGuardian(address guardian, bool status) external onlyOwner {
        require(guardian != address(0), "Invalid guardian");
        guardians[guardian] = status;
        emit GuardianUpdated(guardian, status);
    }

    function configureMarketFactoryRoleManager(address _roleManager) external onlyOwner {
        require(_roleManager != address(0), "Invalid role manager");
        marketFactory.setRoleManager(_roleManager);
    }

    // =========================================================================
    // View functions
    // =========================================================================

    function getFutarchyProposal(uint256 futarchyId) external view returns (
        uint256 proposalId,
        uint256 approvalMarketId,
        uint256 rejectionMarketId,
        uint256 welfareMetricId,
        ProposalPhase phase,
        uint256 createdAt,
        uint256 tradingEndTime,
        uint256 executionTime,
        bool executed,
        bool approvalDecision
    ) {
        FutarchyProposal storage fp = futarchyProposals[futarchyId];
        return (
            fp.proposalId,
            fp.approvalMarketId,
            fp.rejectionMarketId,
            fp.welfareMetricId,
            fp.phase,
            fp.createdAt,
            fp.tradingEndTime,
            fp.executionTime,
            fp.executed,
            fp.approvalDecision
        );
    }

    /**
     * @notice Get both market prices for a futarchy proposal
     * @param futarchyId ID of the futarchy proposal
     * @return approvalPrice Price of approval market in basis points
     * @return rejectionPrice Price of rejection market in basis points
     */
    function getMarketPrices(uint256 futarchyId) external view returns (
        uint256 approvalPrice,
        uint256 rejectionPrice
    ) {
        FutarchyProposal storage fp = futarchyProposals[futarchyId];
        approvalPrice = _getMarketPrice(fp.approvalMarketId);
        rejectionPrice = _getMarketPrice(fp.rejectionMarketId);
    }

    receive() external payable {}

    function emergencyWithdraw() external onlyOwner {
        (bool success, ) = payable(owner()).call{value: address(this).balance}("");
        require(success, "Withdraw failed");
    }
}
