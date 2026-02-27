const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("WelfareMetricOracleAdapter", function () {
  let adapter;
  let welfareRegistry;
  let owner;
  let user1;

  const METRIC_ID = 0;
  const THRESHOLD = 5000; // metric must reach at least 5000

  beforeEach(async function () {
    [owner, user1] = await ethers.getSigners();

    // Deploy WelfareMetricRegistry
    const WelfareMetricRegistry = await ethers.getContractFactory("WelfareMetricRegistry");
    welfareRegistry = await WelfareMetricRegistry.deploy();
    await welfareRegistry.initialize(owner.address);

    // Create and activate a welfare metric
    await welfareRegistry.proposeMetric("Network Hashrate", "TH/s", 5000, 0);
    await welfareRegistry.activateMetric(METRIC_ID);

    // Deploy adapter
    const WelfareMetricOracleAdapter = await ethers.getContractFactory("WelfareMetricOracleAdapter");
    adapter = await WelfareMetricOracleAdapter.deploy(owner.address, await welfareRegistry.getAddress());
  });

  describe("Constructor & IOracleAdapter", function () {
    it("Should set correct owner", async function () {
      expect(await adapter.owner()).to.equal(owner.address);
    });

    it("Should return correct oracle type", async function () {
      expect(await adapter.oracleType()).to.equal("WelfareMetric");
    });

    it("Should return current chain ID", async function () {
      const chainId = await adapter.getConfiguredChainId();
      expect(chainId).to.equal(1337n); // Hardhat local chain ID
    });

    it("Should be available when registry has active metrics", async function () {
      expect(await adapter.isAvailable()).to.equal(true);
    });

    it("Should reject zero address registry", async function () {
      const WelfareMetricOracleAdapter = await ethers.getContractFactory("WelfareMetricOracleAdapter");
      await expect(
        WelfareMetricOracleAdapter.deploy(owner.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(adapter, "InvalidRegistry");
    });

    it("Should have default 7-day grace period", async function () {
      expect(await adapter.resolutionGracePeriod()).to.equal(7 * 24 * 60 * 60);
    });
  });

  describe("Admin Functions", function () {
    it("Should allow owner to update welfare registry", async function () {
      const WelfareMetricRegistry = await ethers.getContractFactory("WelfareMetricRegistry");
      const newRegistry = await WelfareMetricRegistry.deploy();

      await expect(adapter.setWelfareRegistry(await newRegistry.getAddress()))
        .to.emit(adapter, "WelfareRegistryUpdated");
    });

    it("Should reject zero address for new registry", async function () {
      await expect(
        adapter.setWelfareRegistry(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(adapter, "InvalidRegistry");
    });

    it("Should allow owner to update grace period", async function () {
      await expect(adapter.setResolutionGracePeriod(14 * 24 * 60 * 60))
        .to.emit(adapter, "ResolutionGracePeriodUpdated");
      expect(await adapter.resolutionGracePeriod()).to.equal(14 * 24 * 60 * 60);
    });

    it("Should reject non-owner admin calls", async function () {
      await expect(
        adapter.connect(user1).setWelfareRegistry(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");

      await expect(
        adapter.connect(user1).setResolutionGracePeriod(0)
      ).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
    });
  });

  describe("Condition Creation", function () {
    it("Should create a welfare condition", async function () {
      const futureTime = (await time.latest()) + 30 * 24 * 60 * 60; // 30 days ahead

      const tx = await adapter.createCondition(
        METRIC_ID,
        THRESHOLD,
        futureTime,
        "Hashrate above 5000 TH/s within 30 days"
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(l => {
        try {
          return adapter.interface.parseLog(l)?.name === "WelfareConditionCreated";
        } catch { return false; }
      });
      expect(event).to.not.be.undefined;

      expect(await adapter.conditionCount()).to.equal(1);
    });

    it("Should reject measurement time in the past", async function () {
      const pastTime = (await time.latest()) - 1;

      await expect(
        adapter.createCondition(METRIC_ID, THRESHOLD, pastTime, "Test")
      ).to.be.revertedWithCustomError(adapter, "MeasurementTimeInPast");
    });

    it("Should reject inactive metric", async function () {
      // Create but don't activate metric
      await welfareRegistry.proposeMetric("Inactive", "Desc", 2000, 1);
      const futureTime = (await time.latest()) + 30 * 24 * 60 * 60;

      await expect(
        adapter.createCondition(1, THRESHOLD, futureTime, "Test")
      ).to.be.revertedWithCustomError(adapter, "MetricNotActive");
    });

    it("Should reject non-owner condition creation", async function () {
      const futureTime = (await time.latest()) + 30 * 24 * 60 * 60;
      await expect(
        adapter.connect(user1).createCondition(METRIC_ID, THRESHOLD, futureTime, "Test")
      ).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
    });

    it("Should support the created condition", async function () {
      const futureTime = (await time.latest()) + 30 * 24 * 60 * 60;
      const tx = await adapter.createCondition(METRIC_ID, THRESHOLD, futureTime, "Test");
      const receipt = await tx.wait();

      // Extract conditionId from event
      const event = receipt.logs.find(l => {
        try {
          return adapter.interface.parseLog(l)?.name === "ConditionRegistered";
        } catch { return false; }
      });
      const parsed = adapter.interface.parseLog(event);
      const conditionId = parsed.args.conditionId;

      expect(await adapter.isConditionSupported(conditionId)).to.equal(true);
      expect(await adapter.isConditionResolved(conditionId)).to.equal(false);
    });
  });

  describe("Condition Resolution", function () {
    let conditionId;
    let measurementTime;

    beforeEach(async function () {
      measurementTime = (await time.latest()) + 30 * 24 * 60 * 60;

      const tx = await adapter.createCondition(
        METRIC_ID,
        THRESHOLD,
        measurementTime,
        "Hashrate >= 5000"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => {
        try {
          return adapter.interface.parseLog(l)?.name === "ConditionRegistered";
        } catch { return false; }
      });
      conditionId = adapter.interface.parseLog(event).args.conditionId;
    });

    it("Should reject resolution before measurement time", async function () {
      await expect(
        adapter.resolveCondition(conditionId)
      ).to.be.revertedWithCustomError(adapter, "MeasurementTimeNotReached");
    });

    it("Should reject resolution of unknown condition", async function () {
      await expect(
        adapter.resolveCondition(ethers.keccak256(ethers.toUtf8Bytes("unknown")))
      ).to.be.revertedWithCustomError(adapter, "ConditionNotFound");
    });

    it("Should resolve PASS when metric meets threshold", async function () {
      // Record a value above threshold
      await welfareRegistry.recordMetricValue(METRIC_ID, 6000);

      // Advance to measurement time
      await time.increaseTo(measurementTime);

      await expect(adapter.resolveCondition(conditionId))
        .to.emit(adapter, "WelfareConditionResolved")
        .withArgs(conditionId, true, 6000, await time.latest() + 1);

      const [outcome, confidence, resolvedAt] = await adapter.getOutcome(conditionId);
      expect(outcome).to.equal(true); // PASS
      expect(confidence).to.equal(10000); // 100%
      expect(resolvedAt).to.be.greaterThan(0);
    });

    it("Should resolve FAIL when metric below threshold", async function () {
      // Record a value below threshold
      await welfareRegistry.recordMetricValue(METRIC_ID, 3000);

      await time.increaseTo(measurementTime);
      await adapter.resolveCondition(conditionId);

      const [outcome, confidence] = await adapter.getOutcome(conditionId);
      expect(outcome).to.equal(false); // FAIL
      expect(confidence).to.equal(10000);
    });

    it("Should resolve PASS when metric equals threshold", async function () {
      await welfareRegistry.recordMetricValue(METRIC_ID, THRESHOLD);

      await time.increaseTo(measurementTime);
      await adapter.resolveCondition(conditionId);

      const [outcome] = await adapter.getOutcome(conditionId);
      expect(outcome).to.equal(true); // >= threshold
    });

    it("Should reject double resolution", async function () {
      await welfareRegistry.recordMetricValue(METRIC_ID, 6000);
      await time.increaseTo(measurementTime);
      await adapter.resolveCondition(conditionId);

      await expect(
        adapter.resolveCondition(conditionId)
      ).to.be.revertedWithCustomError(adapter, "AlreadyResolved");
    });

    it("Should reject resolution after grace period expires", async function () {
      await welfareRegistry.recordMetricValue(METRIC_ID, 6000);
      // Advance past measurement time + grace period
      await time.increaseTo(measurementTime + 7 * 24 * 60 * 60 + 1);

      await expect(
        adapter.resolveCondition(conditionId)
      ).to.be.revertedWithCustomError(adapter, "ResolutionGracePeriodExpired");
    });

    it("Should allow anyone to trigger resolution", async function () {
      await welfareRegistry.recordMetricValue(METRIC_ID, 6000);
      await time.increaseTo(measurementTime);

      // user1 (not owner) should be able to resolve
      await expect(
        adapter.connect(user1).resolveCondition(conditionId)
      ).to.not.be.reverted;
    });

    it("Should report canResolve correctly", async function () {
      // Before measurement time
      expect(await adapter.canResolve(conditionId)).to.equal(false);

      await welfareRegistry.recordMetricValue(METRIC_ID, 6000);
      await time.increaseTo(measurementTime);

      // At measurement time
      expect(await adapter.canResolve(conditionId)).to.equal(true);

      // After resolution
      await adapter.resolveCondition(conditionId);
      expect(await adapter.canResolve(conditionId)).to.equal(false);
    });
  });

  describe("Condition Metadata", function () {
    it("Should return correct metadata", async function () {
      const measurementTime = (await time.latest()) + 30 * 24 * 60 * 60;
      const description = "Test condition for hashrate";

      const tx = await adapter.createCondition(METRIC_ID, THRESHOLD, measurementTime, description);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => {
        try {
          return adapter.interface.parseLog(l)?.name === "ConditionRegistered";
        } catch { return false; }
      });
      const conditionId = adapter.interface.parseLog(event).args.conditionId;

      const [desc, expectedTime] = await adapter.getConditionMetadata(conditionId);
      expect(desc).to.equal(description);
      expect(expectedTime).to.equal(measurementTime);
    });
  });

  describe("Current Metric Status", function () {
    it("Should return current metric status", async function () {
      const measurementTime = (await time.latest()) + 30 * 24 * 60 * 60;
      const tx = await adapter.createCondition(METRIC_ID, THRESHOLD, measurementTime, "Test");
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => {
        try {
          return adapter.interface.parseLog(l)?.name === "ConditionRegistered";
        } catch { return false; }
      });
      const conditionId = adapter.interface.parseLog(event).args.conditionId;

      // Before any recording
      let [value, meets] = await adapter.getCurrentMetricStatus(conditionId);
      expect(value).to.equal(0);
      expect(meets).to.equal(false);

      // After recording above threshold
      await welfareRegistry.recordMetricValue(METRIC_ID, 7000);
      [value, meets] = await adapter.getCurrentMetricStatus(conditionId);
      expect(value).to.equal(7000);
      expect(meets).to.equal(true);
    });
  });

  describe("Unresolved Condition Outcome", function () {
    it("Should return zeros for unresolved conditions", async function () {
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("nonexistent"));
      const [outcome, confidence, resolvedAt] = await adapter.getOutcome(fakeId);
      expect(outcome).to.equal(false);
      expect(confidence).to.equal(0);
      expect(resolvedAt).to.equal(0);
    });
  });
});
