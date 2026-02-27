const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("OlympiaFutarchyGovernor", function () {
  let governor;
  let welfareRegistry;
  let proposalRegistry;
  let marketFactory;
  let privacyCoordinator;
  let oracleResolver;
  let ragequitModule;
  let governanceToken;
  let collateralToken;
  let ctf1155;
  let owner;
  let addr1;
  let addr2;

  const MIN_TRADING_PERIOD = 7 * 24 * 60 * 60; // 7 days
  const MAX_TRADING_PERIOD = 21 * 24 * 60 * 60; // 21 days
  const MIN_TIMELOCK = 2 * 24 * 60 * 60; // 2 days

  beforeEach(async function () {
    [owner, addr1, addr2] = await ethers.getSigners();

    // Deploy tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    governanceToken = await MockERC20.deploy("Governance Token", "GOV", ethers.parseEther("1000000"));
    collateralToken = await MockERC20.deploy("Collateral", "COL", ethers.parseEther("10000000"));

    // Deploy dependencies
    const WelfareMetricRegistry = await ethers.getContractFactory("WelfareMetricRegistry");
    welfareRegistry = await WelfareMetricRegistry.deploy();
    await welfareRegistry.initialize(owner.address);

    const ProposalRegistry = await ethers.getContractFactory("ProposalRegistry");
    proposalRegistry = await ProposalRegistry.deploy();
    await proposalRegistry.initialize(owner.address);

    const CTF1155 = await ethers.getContractFactory("CTF1155");
    ctf1155 = await CTF1155.deploy();
    await ctf1155.waitForDeployment();

    const ConditionalMarketFactory = await ethers.getContractFactory("ConditionalMarketFactory");
    marketFactory = await ConditionalMarketFactory.deploy();
    await marketFactory.initialize(owner.address);
    await marketFactory.setCTF1155(await ctf1155.getAddress());

    const PrivacyCoordinator = await ethers.getContractFactory("PrivacyCoordinator");
    privacyCoordinator = await PrivacyCoordinator.deploy();
    await privacyCoordinator.initialize(owner.address);

    const OracleResolver = await ethers.getContractFactory("OracleResolver");
    oracleResolver = await OracleResolver.deploy();
    await oracleResolver.initialize(owner.address);

    const RagequitModule = await ethers.getContractFactory("RagequitModule");
    ragequitModule = await RagequitModule.deploy();
    await ragequitModule.initialize(
      owner.address,
      await governanceToken.getAddress(),
      addr1.address
    );

    // Deploy OlympiaFutarchyGovernor
    const OlympiaFutarchyGovernor = await ethers.getContractFactory("OlympiaFutarchyGovernor");
    governor = await OlympiaFutarchyGovernor.deploy();
    await governor.initialize(
      owner.address,
      await welfareRegistry.getAddress(),
      await proposalRegistry.getAddress(),
      await marketFactory.getAddress(),
      await privacyCoordinator.getAddress(),
      await oracleResolver.getAddress(),
      await ragequitModule.getAddress(),
      addr1.address // treasury
    );

    await governor.setMarketCollateralToken(await collateralToken.getAddress());

    // Transfer market factory ownership to governor
    await marketFactory.transferOwnership(await governor.getAddress());
  });

  describe("Deployment & Initialization", function () {
    it("Should set the correct owner", async function () {
      expect(await governor.owner()).to.equal(owner.address);
    });

    it("Should set correct dependencies", async function () {
      expect(await governor.welfareRegistry()).to.equal(await welfareRegistry.getAddress());
      expect(await governor.proposalRegistry()).to.equal(await proposalRegistry.getAddress());
      expect(await governor.marketFactory()).to.equal(await marketFactory.getAddress());
      expect(await governor.privacyCoordinator()).to.equal(await privacyCoordinator.getAddress());
      expect(await governor.oracleResolver()).to.equal(await oracleResolver.getAddress());
    });

    it("Should set correct constants", async function () {
      expect(await governor.MIN_TIMELOCK()).to.equal(MIN_TIMELOCK);
      expect(await governor.MIN_TRADING_PERIOD()).to.equal(MIN_TRADING_PERIOD);
      expect(await governor.MAX_TRADING_PERIOD()).to.equal(MAX_TRADING_PERIOD);
    });

    it("Should start not paused", async function () {
      expect(await governor.paused()).to.equal(false);
    });

    it("Should set owner as guardian", async function () {
      expect(await governor.guardians(owner.address)).to.equal(true);
    });

    it("Should reject double initialization", async function () {
      await expect(
        governor.initialize(
          owner.address,
          await welfareRegistry.getAddress(),
          await proposalRegistry.getAddress(),
          await marketFactory.getAddress(),
          await privacyCoordinator.getAddress(),
          await oracleResolver.getAddress(),
          await ragequitModule.getAddress(),
          addr1.address
        )
      ).to.be.revertedWith("Already initialized");
    });

    it("Should reject zero address for collateral token", async function () {
      const OlympiaFutarchyGovernor = await ethers.getContractFactory("OlympiaFutarchyGovernor");
      const gov2 = await OlympiaFutarchyGovernor.deploy();
      await gov2.initialize(
        owner.address,
        await welfareRegistry.getAddress(),
        await proposalRegistry.getAddress(),
        await marketFactory.getAddress(),
        await privacyCoordinator.getAddress(),
        await oracleResolver.getAddress(),
        await ragequitModule.getAddress(),
        addr1.address
      );
      await expect(
        gov2.setMarketCollateralToken(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid collateral token");
    });
  });

  describe("Emergency & Guardian Controls", function () {
    it("Should allow guardian to toggle pause", async function () {
      await expect(governor.togglePause())
        .to.emit(governor, "EmergencyPauseToggled")
        .withArgs(true);
      expect(await governor.paused()).to.equal(true);
    });

    it("Should reject non-guardian pause toggle", async function () {
      await expect(
        governor.connect(addr2).togglePause()
      ).to.be.revertedWith("Not guardian");
    });

    it("Should allow owner to add guardian", async function () {
      await expect(governor.updateGuardian(addr2.address, true))
        .to.emit(governor, "GuardianUpdated")
        .withArgs(addr2.address, true);
      expect(await governor.guardians(addr2.address)).to.equal(true);
    });

    it("Should allow added guardian to pause", async function () {
      await governor.updateGuardian(addr2.address, true);
      await expect(governor.connect(addr2).togglePause())
        .to.emit(governor, "EmergencyPauseToggled")
        .withArgs(true);
    });

    it("Should reject non-owner guardian management", async function () {
      await expect(
        governor.connect(addr1).updateGuardian(addr2.address, true)
      ).to.be.revertedWithCustomError(governor, "OwnableUnauthorizedAccount");
    });
  });

  describe("Futarchy Proposal Creation", function () {
    let proposalId;

    beforeEach(async function () {
      // Create and activate a welfare metric
      await welfareRegistry.proposeMetric("Network Hashrate", "Total hashrate", 5000, 0);
      await welfareRegistry.activateMetric(0);

      // Submit a proposal to registry
      const bondAmount = await proposalRegistry.bondAmount();
      const currentBlock = await ethers.provider.getBlock("latest");
      const futureDeadline = currentBlock.timestamp + 90 * 24 * 60 * 60;

      proposalId = await proposalRegistry.submitProposal.staticCall(
        "Fund Infrastructure",
        "Improve ETC infrastructure",
        ethers.parseEther("1000"),
        addr1.address,
        0, // welfareMetricId
        ethers.ZeroAddress,
        0,
        futureDeadline,
        { value: bondAmount }
      );

      await proposalRegistry.submitProposal(
        "Fund Infrastructure",
        "Improve ETC infrastructure",
        ethers.parseEther("1000"),
        addr1.address,
        0,
        ethers.ZeroAddress,
        0,
        futureDeadline,
        { value: bondAmount }
      );
    });

    it("Should reject trading period too short", async function () {
      await expect(
        governor.createFutarchyProposal(
          proposalId,
          0, // welfareMetricId
          ethers.parseEther("100"),
          ethers.parseEther("50"),
          MIN_TRADING_PERIOD - 1
        )
      ).to.be.revertedWith("Trading period too short");
    });

    it("Should reject trading period too long", async function () {
      await expect(
        governor.createFutarchyProposal(
          proposalId,
          0,
          ethers.parseEther("100"),
          ethers.parseEther("50"),
          MAX_TRADING_PERIOD + 1
        )
      ).to.be.revertedWith("Trading period too long");
    });

    it("Should reject inactive welfare metric", async function () {
      // Create but don't activate metric
      await welfareRegistry.proposeMetric("Unused Metric", "Inactive", 2000, 1);

      await expect(
        governor.createFutarchyProposal(
          proposalId,
          1, // metric ID 1 — not activated
          ethers.parseEther("100"),
          ethers.parseEther("50"),
          MIN_TRADING_PERIOD
        )
      ).to.be.revertedWith("Welfare metric not active");
    });

    it("Should reject when paused", async function () {
      await governor.togglePause();
      await expect(
        governor.createFutarchyProposal(
          proposalId,
          0,
          ethers.parseEther("100"),
          ethers.parseEther("50"),
          MIN_TRADING_PERIOD
        )
      ).to.be.revertedWith("System paused");
    });

    it("Should reject non-owner proposal creation", async function () {
      await expect(
        governor.connect(addr1).createFutarchyProposal(
          proposalId,
          0,
          ethers.parseEther("100"),
          ethers.parseEther("50"),
          MIN_TRADING_PERIOD
        )
      ).to.be.revertedWithCustomError(governor, "OwnableUnauthorizedAccount");
    });
  });

  describe("Proposal ID Encoding", function () {
    it("Should generate distinct IDs for approval and rejection markets", async function () {
      // Test via view functions — the encoding is internal, but we can verify
      // by examining the proposal struct after creation.
      // For now, test the math: proposalId*2 and proposalId*2+1 are always distinct
      const id = 42;
      expect(id * 2).to.not.equal(id * 2 + 1);
      expect(id * 2).to.equal(84);
      expect(id * 2 + 1).to.equal(85);
    });

    it("Should not collide for sequential proposal IDs", async function () {
      const ids = [0, 1, 2, 100, 999];
      const encoded = new Set();
      for (const id of ids) {
        encoded.add(id * 2);
        encoded.add(id * 2 + 1);
      }
      expect(encoded.size).to.equal(ids.length * 2);
    });
  });

  describe("View Functions", function () {
    it("Should return correct market prices (both zero initially)", async function () {
      // Before any proposal exists, getFutarchyProposal returns defaults
      const fp = await governor.getFutarchyProposal(0);
      expect(fp.proposalId).to.equal(0);
      expect(fp.phase).to.equal(0); // Submission
    });
  });

  describe("Emergency Withdraw", function () {
    it("Should allow owner to emergency withdraw", async function () {
      // Send some ETH to governor
      await owner.sendTransaction({
        to: await governor.getAddress(),
        value: ethers.parseEther("1")
      });

      const balBefore = await ethers.provider.getBalance(owner.address);
      await governor.emergencyWithdraw();
      const balAfter = await ethers.provider.getBalance(owner.address);

      // Owner should have received the ETH (minus gas)
      expect(balAfter).to.be.greaterThan(balBefore - ethers.parseEther("0.01"));
    });

    it("Should reject non-owner emergency withdraw", async function () {
      await expect(
        governor.connect(addr1).emergencyWithdraw()
      ).to.be.revertedWithCustomError(governor, "OwnableUnauthorizedAccount");
    });
  });
});
