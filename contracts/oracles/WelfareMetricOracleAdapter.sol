// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./IOracleAdapter.sol";
import "../core/WelfareMetricRegistry.sol";

/**
 * @title WelfareMetricOracleAdapter
 * @notice Oracle adapter that resolves prediction market conditions based on
 *   on-chain welfare metric data from WelfareMetricRegistry (ECIP-1117)
 * @dev Closes the futarchy loop:
 *   proposal → paired markets → trading → decision → oracle resolution → payout
 *
 * Each condition maps to a specific welfare metric and a threshold value.
 * Resolution compares the latest recorded metric value against the threshold.
 * A "pass" outcome means the metric met or exceeded the threshold.
 *
 * Designed for Mordor testnet (chain 63) and ETC mainnet (chain 61).
 */
contract WelfareMetricOracleAdapter is IOracleAdapter, Ownable {

    // ========== Types ==========

    struct WelfareCondition {
        uint256 metricId;            // WelfareMetricRegistry metric ID
        uint256 threshold;           // Value the metric must meet/exceed
        uint256 measurementTime;     // When the metric should be measured
        string description;          // Human-readable description
        bool registered;             // Whether this condition exists
    }

    struct Resolution {
        bool resolved;
        bool outcome;               // true = metric >= threshold (PASS)
        uint256 metricValue;         // Actual metric value at resolution
        uint256 resolvedAt;
    }

    // ========== Storage ==========

    WelfareMetricRegistry public welfareRegistry;

    /// @notice Condition ID => WelfareCondition
    mapping(bytes32 => WelfareCondition) public conditions;

    /// @notice Condition ID => Resolution
    mapping(bytes32 => Resolution) public resolutions;

    /// @notice Number of registered conditions
    uint256 public conditionCount;

    /// @notice Grace period after measurementTime during which resolution is allowed
    uint256 public resolutionGracePeriod = 7 days;

    // ========== Events ==========

    event WelfareConditionCreated(
        bytes32 indexed conditionId,
        uint256 indexed metricId,
        uint256 threshold,
        uint256 measurementTime
    );
    event WelfareConditionResolved(
        bytes32 indexed conditionId,
        bool outcome,
        uint256 metricValue,
        uint256 resolvedAt
    );
    event WelfareRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event ResolutionGracePeriodUpdated(uint256 oldPeriod, uint256 newPeriod);

    // ========== Errors ==========

    error InvalidRegistry();
    error InvalidMetric();
    error MetricNotActive();
    error ConditionAlreadyExists();
    error ConditionNotFound();
    error MeasurementTimeInPast();
    error MeasurementTimeNotReached();
    error ResolutionGracePeriodExpired();
    error AlreadyResolved();
    error NoMetricValueRecorded();

    // ========== Constructor ==========

    constructor(address _owner, address _welfareRegistry) Ownable(_owner) {
        if (_welfareRegistry == address(0)) revert InvalidRegistry();
        welfareRegistry = WelfareMetricRegistry(_welfareRegistry);
    }

    // ========== Admin Functions ==========

    /**
     * @notice Update the welfare registry address
     * @param _newRegistry New WelfareMetricRegistry address
     */
    function setWelfareRegistry(address _newRegistry) external onlyOwner {
        if (_newRegistry == address(0)) revert InvalidRegistry();
        address old = address(welfareRegistry);
        welfareRegistry = WelfareMetricRegistry(_newRegistry);
        emit WelfareRegistryUpdated(old, _newRegistry);
    }

    /**
     * @notice Update the resolution grace period
     * @param _newPeriod New grace period in seconds
     */
    function setResolutionGracePeriod(uint256 _newPeriod) external onlyOwner {
        uint256 old = resolutionGracePeriod;
        resolutionGracePeriod = _newPeriod;
        emit ResolutionGracePeriodUpdated(old, _newPeriod);
    }

    // ========== Condition Management ==========

    /**
     * @notice Create a welfare metric condition for a futarchy proposal
     * @param metricId ID in WelfareMetricRegistry
     * @param threshold Value the metric must meet/exceed for a PASS outcome
     * @param measurementTime When the metric will be measured for resolution
     * @param description Human-readable condition description
     * @return conditionId Unique condition identifier
     */
    function createCondition(
        uint256 metricId,
        uint256 threshold,
        uint256 measurementTime,
        string calldata description
    ) external onlyOwner returns (bytes32 conditionId) {
        if (measurementTime <= block.timestamp) revert MeasurementTimeInPast();

        // Verify metric exists and is active
        WelfareMetricRegistry.WelfareMetric memory metric = welfareRegistry.getMetric(metricId);
        if (bytes(metric.name).length == 0) revert InvalidMetric();
        if (!metric.active) revert MetricNotActive();

        // Generate unique condition ID
        conditionId = keccak256(abi.encodePacked(
            metricId,
            threshold,
            measurementTime,
            msg.sender,
            block.timestamp
        ));

        if (conditions[conditionId].registered) revert ConditionAlreadyExists();

        conditions[conditionId] = WelfareCondition({
            metricId: metricId,
            threshold: threshold,
            measurementTime: measurementTime,
            description: description,
            registered: true
        });

        conditionCount++;

        emit WelfareConditionCreated(conditionId, metricId, threshold, measurementTime);
        emit ConditionRegistered(conditionId, description, measurementTime);
    }

    /**
     * @notice Resolve a welfare metric condition
     * @dev Compares the latest metric value against the threshold.
     *   Anyone can call this after measurementTime to trigger resolution.
     * @param conditionId The condition to resolve
     */
    function resolveCondition(bytes32 conditionId) external {
        WelfareCondition storage condition = conditions[conditionId];
        if (!condition.registered) revert ConditionNotFound();
        if (resolutions[conditionId].resolved) revert AlreadyResolved();
        if (block.timestamp < condition.measurementTime) revert MeasurementTimeNotReached();
        if (block.timestamp > condition.measurementTime + resolutionGracePeriod) {
            revert ResolutionGracePeriodExpired();
        }

        // Get the latest metric value from registry
        // latestMetricValues uses DAO ID 0 as default
        uint256 metricValue = welfareRegistry.latestMetricValues(0, condition.metricId);
        if (metricValue == 0) {
            // Check if there's any history at all — 0 could be a legitimate value
            // but for welfare metrics, 0 means "no data recorded"
            WelfareMetricRegistry.MetricValue[] memory history = welfareRegistry.getMetricHistory(
                condition.metricId,
                1
            );
            if (history.length == 0) revert NoMetricValueRecorded();
        }

        // PASS if metric value meets or exceeds threshold
        bool outcome = metricValue >= condition.threshold;

        resolutions[conditionId] = Resolution({
            resolved: true,
            outcome: outcome,
            metricValue: metricValue,
            resolvedAt: block.timestamp
        });

        emit WelfareConditionResolved(conditionId, outcome, metricValue, block.timestamp);
        // Confidence is high since we read directly from on-chain registry
        emit ConditionResolved(conditionId, outcome, 10000, block.timestamp);
    }

    // ========== IOracleAdapter Implementation ==========

    /// @inheritdoc IOracleAdapter
    function oracleType() external pure override returns (string memory) {
        return "WelfareMetric";
    }

    /// @inheritdoc IOracleAdapter
    function isAvailable() external view override returns (bool available) {
        // Available if welfare registry is set and has active metrics
        try welfareRegistry.getActiveMetrics() returns (uint256[] memory activeIds) {
            return activeIds.length > 0;
        } catch {
            return false;
        }
    }

    /// @inheritdoc IOracleAdapter
    function getConfiguredChainId() external view override returns (uint256 chainId) {
        return block.chainid;
    }

    /// @inheritdoc IOracleAdapter
    function isConditionSupported(bytes32 conditionId) external view override returns (bool supported) {
        return conditions[conditionId].registered;
    }

    /// @inheritdoc IOracleAdapter
    function isConditionResolved(bytes32 conditionId) external view override returns (bool resolved) {
        return resolutions[conditionId].resolved;
    }

    /// @inheritdoc IOracleAdapter
    function getOutcome(bytes32 conditionId) external view override returns (
        bool outcome,
        uint256 confidence,
        uint256 resolvedAt
    ) {
        Resolution storage res = resolutions[conditionId];
        if (!res.resolved) {
            return (false, 0, 0);
        }
        // On-chain data = 100% confidence (10000 basis points)
        return (res.outcome, 10000, res.resolvedAt);
    }

    /// @inheritdoc IOracleAdapter
    function getConditionMetadata(bytes32 conditionId) external view override returns (
        string memory description,
        uint256 expectedResolutionTime
    ) {
        WelfareCondition storage condition = conditions[conditionId];
        return (condition.description, condition.measurementTime);
    }

    // ========== View Functions ==========

    /**
     * @notice Get condition details
     */
    function getCondition(bytes32 conditionId) external view returns (
        uint256 metricId,
        uint256 threshold,
        uint256 measurementTime,
        string memory description,
        bool registered
    ) {
        WelfareCondition storage c = conditions[conditionId];
        return (c.metricId, c.threshold, c.measurementTime, c.description, c.registered);
    }

    /**
     * @notice Get resolution details
     */
    function getResolution(bytes32 conditionId) external view returns (
        bool resolved,
        bool outcome,
        uint256 metricValue,
        uint256 resolvedAt
    ) {
        Resolution storage r = resolutions[conditionId];
        return (r.resolved, r.outcome, r.metricValue, r.resolvedAt);
    }

    /**
     * @notice Check if a condition can be resolved now
     */
    function canResolve(bytes32 conditionId) external view returns (bool) {
        WelfareCondition storage condition = conditions[conditionId];
        if (!condition.registered) return false;
        if (resolutions[conditionId].resolved) return false;
        if (block.timestamp < condition.measurementTime) return false;
        if (block.timestamp > condition.measurementTime + resolutionGracePeriod) return false;
        return true;
    }

    /**
     * @notice Get the current metric value for a condition (before resolution)
     * @param conditionId The condition to check
     * @return value Current latest metric value
     * @return meetsThreshold Whether the current value would pass
     */
    function getCurrentMetricStatus(bytes32 conditionId) external view returns (
        uint256 value,
        bool meetsThreshold
    ) {
        WelfareCondition storage condition = conditions[conditionId];
        require(condition.registered, "Condition not found");

        value = welfareRegistry.latestMetricValues(0, condition.metricId);
        meetsThreshold = value >= condition.threshold;
    }
}
