/**
 * Deployed Contract Addresses on Mordor Testnet
 *
 * These addresses are deterministically deployed and should remain consistent
 * across deployments. Update these if contracts are redeployed.
 *
 * Last updated: 2026-02-27 (ECIP-1117 Olympia Futarchy contracts)
 */

export const DEPLOYED_CONTRACTS = {
  // Deployer / Treasury
  deployer: '0x52502d049571C7893447b86c4d8B38e6184bF6e1',
  treasury: '0x52502d049571C7893447b86c4d8B38e6184bF6e1',

  // Core Contracts (01-deploy-core.js)
  roleManagerCore: '0x6a6422Ed3198332AC8DA2852BBff4749B66a3D8D',
  welfareRegistry: '0x034494F9eA0821FB6167EcA41A6850fd2D11b8b1',
  proposalRegistry: '0x095146344Ab39a0cbF37494Cb50fb293E55AF76E',
  marketFactory: '0xc56631DB29c44bb553a511DD3d4b90d64C95Cd9C',
  privacyCoordinator: '0x9897CBb96b1931A3c019A9d2126dab59630D4414',
  oracleResolver: '0x2AaCC0D91AF255667683ece0A363649Cc9Ed8776',
  ragequitModule: '0xD6b6eDE9EacDC90e20Fe95Db1875EaBB07004A1c',
  futarchyGovernor: '0x0292a5bdf60E851c043bDceE378D505801A6aEef',
  tokenMintFactory: '0xD5cAcc508F7e0d578D014E9552d73F8cd18CA5CC',
  daoFactory: '0x9B1692272D54CA7b4dEAa7622aBddb6059eb8202',

  // RBAC Contracts (02-deploy-rbac.js)
  tieredRoleManager: '0x55e6346Be542B13462De504FCC379a2477D227f0',
  tierRegistry: '0x476cf3dEA109D6FC95aD19d246FD4e95693c47a3',
  usageTracker: '0x10f1b557a53C05A92DF820CCfDC77EaB0c732Bde',
  membershipManager: '0xCD172d9888a6F47203dD6f0684f250f6Ac56f6Ed',
  paymentProcessor: '0x6e063138809263820F61146c34a74EB3B2629A59',
  membershipPaymentManager: '0x9CDc3D0Aff85F89C04d03b6b9E9Ba99fDf033E34',

  // Market Contracts (03-deploy-markets.js) - v1.1 with bookmaker + resolution types
  ctf1155: '0x5baBA40b92EE6C9D4245DFd39f7d9Ab1Abf9E1D5',
  friendGroupMarketFactory: '0xB32679E6B64B706Ed635c3e109f90012876bA1cF',

  // Perpetual Futures Contracts (v2.1 - fixed decimals + ownership)
  fundingRateEngine: '0x32AD4F7a1e05138fc0F485c786aeDB90dBE100e8',
  perpFactory: '0xE3B84aecc9Ee0D2a35530BfAcb3D184c372cdc71',

  // Registry Contracts (04-deploy-registries.js)
  marketCorrelationRegistry: '0x2a820A38997743fC3303cDcA56b996598963B909',
  nullifierRegistry: '0x5569FEe7f8Bab39EEd08bf448Dd6824640C7d272',

  // ECIP-1117 Olympia Futarchy Contracts (07-deploy-olympia-futarchy.js)
  olympiaFutarchyGovernor: '0xEc4AA90c812a997EA0Aa5BDc1A5777B75fB2db54',
  lmsrMarketMaker: '0x83fca795f56f91b888A51Bb90331636fDd1f94A7',
  welfareMetricOracleAdapter: '0x167F60B20583fA897Ccb482689f0c29D0450aB22',

  // Back-compat aliases
  roleManager: '0x55e6346Be542B13462De504FCC379a2477D227f0',
}

/**
 * Get contract address from environment or use deployed default
 * @param {string} contractName - Name of the contract
 * @returns {string} Contract address
 */
export function getContractAddress(contractName) {
  // Check environment variables first (for custom deployments)
  // Support both legacy style (VITE_ROLEMANAGER_ADDRESS) and snake-case style (VITE_ROLE_MANAGER_ADDRESS)
  const upper = contractName.toUpperCase()
  const snake = contractName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()

  const envKeys = [`VITE_${upper}_ADDRESS`, `VITE_${snake}_ADDRESS`]
  for (const envKey of envKeys) {
    const envAddress = import.meta.env[envKey]
    if (envAddress) return envAddress
  }

  // Fall back to deployed contract addresses
  return DEPLOYED_CONTRACTS[contractName]
}

/**
 * Network configuration for Mordor testnet
 */
export const NETWORK_CONFIG = {
  chainId: parseInt(import.meta.env.VITE_NETWORK_ID || '63', 10),
  name: 'Mordor Testnet',
  rpcUrl: import.meta.env.VITE_RPC_URL || 'https://rpc.mordor.etccooperative.org',
  blockExplorer: 'https://etc-mordor.blockscout.com'
}
