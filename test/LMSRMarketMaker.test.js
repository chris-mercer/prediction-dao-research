const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LMSRMarketMaker", function () {
  let lmsr;
  let collateralToken;
  let ctf1155;
  let owner;
  let buyer;

  const PRECISION = ethers.parseEther("1"); // 1e18
  const MARKET_ID = 1;
  const B_PARAM = ethers.parseEther("1000"); // liquidity parameter
  const FUNDING = ethers.parseEther("5000");

  beforeEach(async function () {
    [owner, buyer] = await ethers.getSigners();

    // Deploy collateral token
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    collateralToken = await MockERC20.deploy("Collateral", "COL", ethers.parseEther("100000000"));

    // Deploy CTF1155
    const CTF1155 = await ethers.getContractFactory("CTF1155");
    ctf1155 = await CTF1155.deploy();

    // Deploy LMSR
    const LMSRMarketMaker = await ethers.getContractFactory("LMSRMarketMaker");
    lmsr = await LMSRMarketMaker.deploy();

    // Approve LMSR to spend collateral
    await collateralToken.approve(await lmsr.getAddress(), ethers.MaxUint256);
  });

  describe("Deployment", function () {
    it("Should set the correct owner", async function () {
      expect(await lmsr.owner()).to.equal(owner.address);
    });

    it("Should start with zero markets", async function () {
      expect(await lmsr.marketCount()).to.equal(0);
    });

    it("Should support ERC1155 receiver interface", async function () {
      expect(await lmsr.supportsInterface("0x4e2312e0")).to.equal(true);
    });
  });

  describe("Fund Market", function () {
    it("Should fund a new market", async function () {
      const conditionId = ethers.keccak256(ethers.toUtf8Bytes("test-condition"));
      const passPositionId = 1;
      const failPositionId = 2;

      await expect(
        lmsr.fundMarket(
          MARKET_ID,
          await collateralToken.getAddress(),
          B_PARAM,
          FUNDING,
          await ctf1155.getAddress(),
          conditionId,
          passPositionId,
          failPositionId
        )
      ).to.emit(lmsr, "MarketFunded")
        .withArgs(MARKET_ID, FUNDING, B_PARAM);

      expect(await lmsr.marketCount()).to.equal(1);
    });

    it("Should reject duplicate market funding", async function () {
      const conditionId = ethers.keccak256(ethers.toUtf8Bytes("test-condition"));

      await lmsr.fundMarket(
        MARKET_ID, await collateralToken.getAddress(), B_PARAM, FUNDING,
        await ctf1155.getAddress(), conditionId, 1, 2
      );

      await expect(
        lmsr.fundMarket(
          MARKET_ID, await collateralToken.getAddress(), B_PARAM, FUNDING,
          await ctf1155.getAddress(), conditionId, 1, 2
        )
      ).to.be.revertedWith("Market already funded");
    });

    it("Should reject zero liquidity parameter", async function () {
      const conditionId = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(
        lmsr.fundMarket(
          MARKET_ID, await collateralToken.getAddress(), 0, FUNDING,
          await ctf1155.getAddress(), conditionId, 1, 2
        )
      ).to.be.revertedWith("b must be positive");
    });

    it("Should reject zero funding", async function () {
      const conditionId = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(
        lmsr.fundMarket(
          MARKET_ID, await collateralToken.getAddress(), B_PARAM, 0,
          await ctf1155.getAddress(), conditionId, 1, 2
        )
      ).to.be.revertedWith("Funding must be positive");
    });

    it("Should reject non-owner funding", async function () {
      const conditionId = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(
        lmsr.connect(buyer).fundMarket(
          MARKET_ID, await collateralToken.getAddress(), B_PARAM, FUNDING,
          await ctf1155.getAddress(), conditionId, 1, 2
        )
      ).to.be.revertedWithCustomError(lmsr, "OwnableUnauthorizedAccount");
    });

    it("Should transfer collateral from owner", async function () {
      const conditionId = ethers.keccak256(ethers.toUtf8Bytes("test"));
      const balBefore = await collateralToken.balanceOf(owner.address);

      await lmsr.fundMarket(
        MARKET_ID, await collateralToken.getAddress(), B_PARAM, FUNDING,
        await ctf1155.getAddress(), conditionId, 1, 2
      );

      const balAfter = await collateralToken.balanceOf(owner.address);
      expect(balBefore - balAfter).to.equal(FUNDING);
    });
  });

  describe("LMSR Pricing", function () {
    beforeEach(async function () {
      const conditionId = ethers.keccak256(ethers.toUtf8Bytes("test-condition"));
      await lmsr.fundMarket(
        MARKET_ID, await collateralToken.getAddress(), B_PARAM, FUNDING,
        await ctf1155.getAddress(), conditionId, 1, 2
      );
    });

    it("Should return 50/50 prices for balanced market", async function () {
      const [passPrice, failPrice] = await lmsr.getPrices(MARKET_ID);

      // With qPass = qFail = 0, prices should be 50/50
      const halfPrecision = PRECISION / 2n;
      expect(passPrice).to.be.closeTo(halfPrecision, ethers.parseEther("0.01"));
      expect(failPrice).to.be.closeTo(halfPrecision, ethers.parseEther("0.01"));
    });

    it("Should have prices sum to approximately 1", async function () {
      const [passPrice, failPrice] = await lmsr.getPrices(MARKET_ID);
      const sum = passPrice + failPrice;
      expect(sum).to.be.closeTo(PRECISION, ethers.parseEther("0.001"));
    });

    it("Should return 50/50 for inactive market", async function () {
      const [passPrice, failPrice] = await lmsr.getPrices(999); // non-existent
      expect(passPrice).to.equal(ethers.parseEther("0.5"));
      expect(failPrice).to.equal(ethers.parseEther("0.5"));
    });

    it("Should calculate buy cost for PASS tokens", async function () {
      const amount = ethers.parseEther("10");
      const cost = await lmsr.calcBuyCost(MARKET_ID, true, amount);

      // Cost should be positive
      expect(cost).to.be.greaterThan(0);
      // For a balanced market with b=1000, buying 10 tokens should cost roughly 5-6
      expect(cost).to.be.lessThan(amount); // Cost < amount (LMSR subsidy)
    });

    it("Should calculate equal buy costs for PASS and FAIL in balanced market", async function () {
      const amount = ethers.parseEther("10");
      const passCost = await lmsr.calcBuyCost(MARKET_ID, true, amount);
      const failCost = await lmsr.calcBuyCost(MARKET_ID, false, amount);

      // In a balanced market, cost to buy PASS should equal cost to buy FAIL
      expect(passCost).to.be.closeTo(failCost, ethers.parseEther("0.001"));
    });
  });

  describe("Close Market", function () {
    it("Should allow owner to close market", async function () {
      const conditionId = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await lmsr.fundMarket(
        MARKET_ID, await collateralToken.getAddress(), B_PARAM, FUNDING,
        await ctf1155.getAddress(), conditionId, 1, 2
      );

      await expect(lmsr.closeMarket(MARKET_ID))
        .to.emit(lmsr, "MarketClosed")
        .withArgs(MARKET_ID);
    });

    it("Should reject non-owner close", async function () {
      await expect(
        lmsr.connect(buyer).closeMarket(MARKET_ID)
      ).to.be.revertedWithCustomError(lmsr, "OwnableUnauthorizedAccount");
    });
  });

  describe("ERC1155 Receiver", function () {
    it("Should accept single ERC1155 transfers", async function () {
      const selector = lmsr.interface.getFunction("onERC1155Received").selector;
      const result = await lmsr.onERC1155Received(
        ethers.ZeroAddress, ethers.ZeroAddress, 0, 0, "0x"
      );
      expect(result).to.equal(selector);
    });

    it("Should accept batch ERC1155 transfers", async function () {
      const selector = lmsr.interface.getFunction("onERC1155BatchReceived").selector;
      const result = await lmsr.onERC1155BatchReceived(
        ethers.ZeroAddress, ethers.ZeroAddress, [], [], "0x"
      );
      expect(result).to.equal(selector);
    });
  });
});
