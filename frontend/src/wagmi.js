import { http, createConfig } from 'wagmi'
import { injected, walletConnect } from 'wagmi/connectors'

// Define Ethereum Classic mainnet
const ethereumClassic = {
  id: 61,
  name: 'Ethereum Classic',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETC',
  },
  rpcUrls: {
    default: { http: ['https://etc.rivet.link'] },
    public: { http: ['https://etc.rivet.link'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://etc.blockscout.com' },
  },
  testnet: false,
}

// Define Mordor testnet
const mordor = {
  id: 63,
  name: 'Mordor',
  nativeCurrency: {
    decimals: 18,
    name: 'Mordor Ether',
    symbol: 'METC',
  },
  rpcUrls: {
    default: { http: ['https://rpc.mordor.etccooperative.org'] },
    public: { http: ['https://rpc.mordor.etccooperative.org'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://etc-mordor.blockscout.com' },
  },
  testnet: true,
}

// Define Hardhat local network (for development)
const hardhat = {
  id: 1337,
  name: 'Hardhat',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: { http: ['http://127.0.0.1:8545'] },
    public: { http: ['http://127.0.0.1:8545'] },
  },
  testnet: true,
}

// Get network ID from environment or default to Mordor testnet
const networkId = import.meta.env.VITE_NETWORK_ID 
  ? parseInt(import.meta.env.VITE_NETWORK_ID, 10) 
  : 63

// Get RPC URL from environment
const rpcUrl = import.meta.env.VITE_RPC_URL || 'https://rpc.mordor.etccooperative.org'

// Get WalletConnect project ID from environment
// Using a fallback demo project ID if none is provided to ensure WalletConnect option is always available
const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'e7a122e5963ecec9bb2ab09e08bca54f'

// Warn if using fallback project ID (only in development)
if (!import.meta.env.VITE_WALLETCONNECT_PROJECT_ID && import.meta.env.DEV) {
  console.warn(
    'WalletConnect: Using fallback project ID. For production, please set VITE_WALLETCONNECT_PROJECT_ID in your .env file. ' +
    'Get your project ID at https://cloud.walletconnect.com'
  )
}

// Get app URL for WalletConnect metadata
const resolveAppUrl = () => {
  const envUrl = import.meta.env.VITE_APP_URL

  if (envUrl) {
    return envUrl
  }

  // Silently use window.location.origin in production if VITE_APP_URL is not set
  // Only warn in development mode
  if (import.meta.env.DEV) {
    console.warn('VITE_APP_URL is not set. Using window.location.origin as fallback. Set VITE_APP_URL in .env for production deployments.')
  }

  // In development, fall back to the current origin when available
  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    return window.location.origin
  }

  // As a last resort, return a fallback domain
  return 'https://olympia.etccooperative.org'
}

const appUrl = resolveAppUrl()

// Define supported chains
const chains = [ethereumClassic, mordor, hardhat]

// Create wagmi config
export const config = createConfig({
  chains,
  connectors: [
    // Generic injected connector - works with any browser wallet (MetaMask, Coinbase, etc.)
    injected({
      shimDisconnect: true,
    }),
    // WalletConnect is always available for hardware wallet and mobile wallet support
    walletConnect({
      projectId: walletConnectProjectId,
      metadata: {
        name: 'Olympia Futarchy',
        description: 'Futarchy governance for Ethereum Classic (ECIP-1117)',
        url: appUrl,
        icons: [`${appUrl}/assets/olympia-logo.svg`]
      },
      showQrModal: true,
    }),
  ],
  transports: {
    [ethereumClassic.id]: http(),
    [mordor.id]: http(rpcUrl),
    [hardhat.id]: http('http://localhost:8545'),
  },
})

// Helper to get expected chain info
export const getExpectedChain = () => {
  switch (networkId) {
    case 61:
      return ethereumClassic
    case 63:
      return mordor
    case 1337:
      return hardhat
    default:
      return mordor
  }
}

export const EXPECTED_CHAIN_ID = networkId
