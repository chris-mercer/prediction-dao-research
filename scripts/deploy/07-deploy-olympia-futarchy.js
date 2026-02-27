/**
 * 07-deploy-olympia-futarchy.js - ECIP-1117 Futarchy Governance Deployment
 *
 * Deploys Olympia-specific contracts:
 * - OlympiaFutarchyGovernor (paired prediction markets per proposal)
 * - LMSRMarketMaker (automated market maker for baseline liquidity)
 * - WelfareMetricOracleAdapter (welfare metric-based oracle resolution)
 *
 * Prerequisites:
 *   - Run 01-deploy-core.js first (for welfareRegistry, proposalRegistry, etc.)
 *   - Run 02-deploy-rbac.js first
 *   - Run 03-deploy-markets.js first (for CTF1155)
 *
 * Usage:
 *   npx hardhat run scripts/deploy/07-deploy-olympia-futarchy.js --network localhost
 *   npx hardhat run scripts/deploy/07-deploy-olympia-futarchy.js --network mordor
 */

const hre = require("hardhat");
const { ethers } = require("hardhat");

const {
  SALT_PREFIXES,
  TOKENS,
} = require("./lib/constants");

const {
  generateSalt,
  deployDeterministic,
  ensureSingletonFactory,
  saveDeployment,
  getDeploymentFilename,
  loadDeployment,
  verifyOnBlockscout,
} = require("./lib/helpers");

async function main() {
  console.log("=".repeat(60));
  console.log("07 - Olympia Futarchy Governance Deployment (ECIP-1117)");
  console.log("=".repeat(60));

  const network = await ethers.provider.getNetwork();
  console.log(`\nNetwork: ${hre.network.name} (Chain ID: ${network.chainId})`);

  await ensureSingletonFactory();

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer available");
  }
  console.log("\nDeployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETC");

  // Load previous deployments
  const coreDeployment = loadDeployment(getDeploymentFilename(network, "core-deployment"));
  const marketsDeployment = loadDeployment(getDeploymentFilename(network, "markets-deployment"));

  if (!coreDeployment?.contracts) {
    throw new Error("Core deployment not found. Run 01-deploy-core.js first.");
  }

  console.log("\nDependencies (from core deployment):");
  console.log("  WelfareRegistry:", coreDeployment.contracts.welfareRegistry);
  console.log("  ProposalRegistry:", coreDeployment.contracts.proposalRegistry);
  console.log("  MarketFactory:", coreDeployment.contracts.marketFactory);
  console.log("  PrivacyCoordinator:", coreDeployment.contracts.privacyCoordinator);
  console.log("  OracleResolver:", coreDeployment.contracts.oracleResolver);
  console.log("  RagequitModule:", coreDeployment.contracts.ragequitModule);
  console.log("  FutarchyGovernor (existing):", coreDeployment.contracts.futarchyGovernor);

  const saltPrefix = "OlympiaDAO-v1.0-";
  const deployments = {};

  // =========================================================================
  // Deploy WelfareMetricOracleAdapter
  // =========================================================================
  console.log("\n--- WelfareMetricOracleAdapter ---");

  const adapterSalt = generateSalt(saltPrefix + "WelfareMetricOracleAdapter");
  const adapterResult = await deployDeterministic(
    "WelfareMetricOracleAdapter",
    [deployer.address, coreDeployment.contracts.welfareRegistry],
    adapterSalt,
    deployer
  );
  deployments.welfareMetricOracleAdapter = adapterResult.address;
  console.log("  WelfareMetricOracleAdapter:", adapterResult.address);

  // =========================================================================
  // Deploy LMSRMarketMaker
  // =========================================================================
  console.log("\n--- LMSRMarketMaker ---");

  const lmsrSalt = generateSalt(saltPrefix + "LMSRMarketMaker");
  const lmsrResult = await deployDeterministic(
    "LMSRMarketMaker",
    [],
    lmsrSalt,
    deployer
  );
  deployments.lmsrMarketMaker = lmsrResult.address;
  console.log("  LMSRMarketMaker:", lmsrResult.address);

  // =========================================================================
  // Deploy OlympiaFutarchyGovernor
  // =========================================================================
  console.log("\n--- OlympiaFutarchyGovernor ---");

  const governorSalt = generateSalt(saltPrefix + "OlympiaFutarchyGovernor");
  const governorResult = await deployDeterministic(
    "OlympiaFutarchyGovernor",
    [],
    governorSalt,
    deployer
  );
  deployments.olympiaFutarchyGovernor = governorResult.address;
  console.log("  OlympiaFutarchyGovernor:", governorResult.address);

  // =========================================================================
  // Initialize OlympiaFutarchyGovernor
  // =========================================================================
  console.log("\n--- Initializing OlympiaFutarchyGovernor ---");

  const governor = await ethers.getContractAt("OlympiaFutarchyGovernor", governorResult.address);

  // Use deployer as treasury vault for now (can be changed later to the ECIP-1112 vault)
  const treasuryVault = deployer.address;

  const initTx = await governor.initialize(
    deployer.address,
    coreDeployment.contracts.welfareRegistry,
    coreDeployment.contracts.proposalRegistry,
    coreDeployment.contracts.marketFactory,
    coreDeployment.contracts.privacyCoordinator,
    coreDeployment.contracts.oracleResolver,
    coreDeployment.contracts.ragequitModule,
    treasuryVault
  );
  await initTx.wait();
  console.log("  Initialized with treasury vault:", treasuryVault);

  // Set collateral token (USC stablecoin on Mordor)
  const chainId = Number(network.chainId);
  const tokens = TOKENS[hre.network.name] || TOKENS.mordor;
  if (tokens?.USC) {
    const setCollateralTx = await governor.setMarketCollateralToken(tokens.USC);
    await setCollateralTx.wait();
    console.log("  Collateral token set to USC:", tokens.USC);
  } else {
    console.warn("  WARNING: No USC token configured for this network. Set collateral manually.");
  }

  // =========================================================================
  // Save deployment
  // =========================================================================
  const deploymentInfo = {
    network: hre.network.name,
    chainId: chainId,
    deployer: deployer.address,
    saltPrefix,
    contracts: deployments,
    dependencies: {
      welfareRegistry: coreDeployment.contracts.welfareRegistry,
      proposalRegistry: coreDeployment.contracts.proposalRegistry,
      marketFactory: coreDeployment.contracts.marketFactory,
      privacyCoordinator: coreDeployment.contracts.privacyCoordinator,
      oracleResolver: coreDeployment.contracts.oracleResolver,
      ragequitModule: coreDeployment.contracts.ragequitModule,
      treasuryVault,
    },
    timestamp: new Date().toISOString(),
  };

  const filename = getDeploymentFilename(network, "olympia-futarchy-deployment");
  saveDeployment(filename, deploymentInfo);

  // =========================================================================
  // Verify on Blockscout (non-blocking)
  // =========================================================================
  if (chainId === 63 || chainId === 61) {
    console.log("\n--- Verifying on Blockscout ---");
    try {
      await verifyOnBlockscout("WelfareMetricOracleAdapter", adapterResult.address, [
        deployer.address,
        coreDeployment.contracts.welfareRegistry,
      ]);
    } catch (e) {
      console.warn("  Adapter verification:", e.message);
    }
    try {
      await verifyOnBlockscout("LMSRMarketMaker", lmsrResult.address, []);
    } catch (e) {
      console.warn("  LMSR verification:", e.message);
    }
    try {
      await verifyOnBlockscout("OlympiaFutarchyGovernor", governorResult.address, []);
    } catch (e) {
      console.warn("  Governor verification:", e.message);
    }
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log("\n" + "=".repeat(60));
  console.log("ECIP-1117 Futarchy Deployment Complete");
  console.log("=".repeat(60));
  console.log("\nContracts:");
  console.log("  OlympiaFutarchyGovernor:", deployments.olympiaFutarchyGovernor);
  console.log("  LMSRMarketMaker:", deployments.lmsrMarketMaker);
  console.log("  WelfareMetricOracleAdapter:", deployments.welfareMetricOracleAdapter);
  console.log("\nNext steps:");
  console.log("  1. Transfer MarketFactory ownership to OlympiaFutarchyGovernor");
  console.log("  2. Register WelfareMetricOracleAdapter in OracleRegistry");
  console.log("  3. Fund LMSR markets with collateral");
  console.log("  4. Update frontend contract addresses");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
