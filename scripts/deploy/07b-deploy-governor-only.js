/**
 * 07b-deploy-governor-only.js - Deploy ONLY OlympiaFutarchyGovernor
 *
 * The adapter and LMSR are already deployed on Mordor.
 * Governor deployment failed on public RPC due to 1 ETC tx fee cap.
 * This script deploys just the governor via local node.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/07b-deploy-governor-only.js --network mordor-local
 */

const hre = require("hardhat");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const {
  generateSalt,
  deployDeterministic,
  ensureSingletonFactory,
  verifyOnBlockscout,
} = require("./lib/helpers");

// Already deployed on Mordor (from previous partial deployment)
const DEPLOYED = {
  welfareMetricOracleAdapter: "0x167F60B20583fA897Ccb482689f0c29D0450aB22",
  lmsrMarketMaker: "0x83fca795f56f91b888A51Bb90331636fDd1f94A7",
};

// Core dependencies (from mordor-chain63-core-deployment.json)
const CORE = {
  welfareRegistry: "0x034494F9eA0821FB6167EcA41A6850fd2D11b8b1",
  proposalRegistry: "0x095146344Ab39a0cbF37494Cb50fb293E55AF76E",
  marketFactory: "0xc56631DB29c44bb553a511DD3d4b90d64C95Cd9C",
  privacyCoordinator: "0x9897CBb96b1931A3c019A9d2126dab59630D4414",
  oracleResolver: "0x2AaCC0D91AF255667683ece0A363649Cc9Ed8776",
  ragequitModule: "0xD6b6eDE9EacDC90e20Fe95Db1875EaBB07004A1c",
};

async function main() {
  console.log("=".repeat(60));
  console.log("07b - OlympiaFutarchyGovernor ONLY Deployment");
  console.log("=".repeat(60));

  const network = await ethers.provider.getNetwork();
  console.log(`\nNetwork: ${hre.network.name} (Chain ID: ${network.chainId})`);

  await ensureSingletonFactory();

  const [deployer] = await ethers.getSigners();
  console.log("\nDeployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETC");

  // Deploy OlympiaFutarchyGovernor
  console.log("\n--- OlympiaFutarchyGovernor ---");
  const saltPrefix = "OlympiaDAO-v1.0-";
  const governorSalt = generateSalt(saltPrefix + "OlympiaFutarchyGovernor");

  const governorResult = await deployDeterministic(
    "OlympiaFutarchyGovernor",
    [],
    governorSalt,
    deployer
  );
  console.log("  OlympiaFutarchyGovernor:", governorResult.address);

  // Initialize
  console.log("\n--- Initializing ---");
  const governor = await ethers.getContractAt("OlympiaFutarchyGovernor", governorResult.address);

  try {
    const initTx = await governor.initialize(
      deployer.address,
      CORE.welfareRegistry,
      CORE.proposalRegistry,
      CORE.marketFactory,
      CORE.privacyCoordinator,
      CORE.oracleResolver,
      CORE.ragequitModule,
      deployer.address // treasury (deployer for now)
    );
    await initTx.wait();
    console.log("  Initialized OK");
  } catch (e) {
    if (e.message.includes("Already initialized")) {
      console.log("  Already initialized (skipping)");
    } else {
      throw e;
    }
  }

  // Set collateral token (USC on Mordor)
  try {
    const USC_MORDOR = "0x1953D44391A4C1Fc3A1045702e78A8e76c5f4f01";
    const setTx = await governor.setMarketCollateralToken(USC_MORDOR);
    await setTx.wait();
    console.log("  Collateral token set to USC:", USC_MORDOR);
  } catch (e) {
    console.log("  Collateral token already set or error:", e.message?.slice(0, 80));
  }

  // Save deployment
  const deploymentInfo = {
    network: "mordor",
    chainId: 63,
    deployer: deployer.address,
    saltPrefix,
    contracts: {
      ...DEPLOYED,
      olympiaFutarchyGovernor: governorResult.address,
    },
    dependencies: {
      ...CORE,
      treasuryVault: deployer.address,
    },
    timestamp: new Date().toISOString(),
  };

  const deployDir = path.join(__dirname, "../../deployments");
  const filename = "mordor-chain63-olympia-futarchy-deployment.json";
  fs.writeFileSync(
    path.join(deployDir, filename),
    JSON.stringify(deploymentInfo, null, 2)
  );
  console.log("\n  Saved:", filename);

  // Verify on Blockscout
  if (Number(network.chainId) === 63) {
    console.log("\n--- Verifying on Blockscout ---");
    try {
      await verifyOnBlockscout("OlympiaFutarchyGovernor", governorResult.address, []);
    } catch (e) {
      console.warn("  Verification:", e.message?.slice(0, 100));
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Governor Deployment Complete");
  console.log("=".repeat(60));
  console.log("\nAll ECIP-1117 Contracts:");
  console.log("  OlympiaFutarchyGovernor:", governorResult.address);
  console.log("  LMSRMarketMaker:", DEPLOYED.lmsrMarketMaker);
  console.log("  WelfareMetricOracleAdapter:", DEPLOYED.welfareMetricOracleAdapter);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
