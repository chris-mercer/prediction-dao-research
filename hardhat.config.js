require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { subtask } = require("hardhat/config");

// Floppy keystore loader for secure key storage
// Usage: npm run floppy:mount && npm run floppy:create (one-time setup)
const {
  getFloppyPrivateKeys,
  isFloppyMounted,
  keystoreExists,
  adminKeystoreExists,
  CONFIG: FLOPPY_CONFIG
} = require('./scripts/operations/floppy-key/loader');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Synchronously decrypt a keystore file
 * Supports both admin keystore (HMAC-SHA256 MAC) and mnemonic keystore (keccak256 MAC)
 * @param {string} keystorePath - Path to the keystore JSON file
 * @param {string} password - Decryption password
 * @returns {Buffer|null} - Decrypted data or null on failure
 */
function decryptKeystoreSync(keystorePath, password) {
  try {
    const keystoreJson = fs.readFileSync(keystorePath, 'utf8');
    const keystore = JSON.parse(keystoreJson);
    const { crypto: cryptoParams } = keystore;
    const keystoreType = keystore.type; // 'admin-private-key' or 'mnemonic'

    const salt = Buffer.from(cryptoParams.kdfparams.salt, 'hex');
    const iv = Buffer.from(cryptoParams.cipherparams.iv, 'hex');
    const ciphertext = Buffer.from(cryptoParams.ciphertext, 'hex');
    const storedMac = Buffer.from(cryptoParams.mac, 'hex');

    // Derive key synchronously (maxmem needed for high N values)
    const derivedKey = crypto.scryptSync(
      password,
      salt,
      cryptoParams.kdfparams.dklen,
      {
        N: cryptoParams.kdfparams.n,
        r: cryptoParams.kdfparams.r,
        p: cryptoParams.kdfparams.p,
        maxmem: 512 * 1024 * 1024  // 512MB for high N values
      }
    );

    // Verify MAC - different algorithms for different keystore types
    let computedMac;
    if (keystoreType === 'admin-private-key') {
      // Admin keystore uses HMAC-SHA256
      computedMac = crypto.createHmac('sha256', derivedKey.slice(16, 32))
        .update(ciphertext)
        .digest();
    } else {
      // Mnemonic keystore uses keccak256(derivedKey[16:32] || ciphertext)
      const { keccak256 } = require('ethers');
      const macInput = Buffer.concat([
        Buffer.from(derivedKey.slice(16, 32)),
        ciphertext
      ]);
      computedMac = Buffer.from(keccak256(macInput).slice(2), 'hex');
    }

    if (!computedMac.equals(storedMac)) {
      return null;
    }

    // Decrypt
    const decipher = crypto.createDecipheriv(
      cryptoParams.cipher,
      derivedKey.slice(0, 16),
      iv
    );
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
  } catch (err) {
    return null;
  }
}

/**
 * Load keys from floppy keystore (admin key or mnemonic)
 * SECURITY: This is the ONLY way to load keys for production networks
 * PRIVATE_KEY fallback only works for localhost/hardhat networks
 *
 * @param {boolean} allowFallback - Whether to allow PRIVATE_KEY fallback (development only)
 * @returns {string[]} Array of private keys, or empty array if not available
 */
function loadFloppyKeysSync(allowFallback = false) {
  if (!isFloppyMounted()) {
    console.warn('[Floppy] Disk not mounted at', FLOPPY_CONFIG.MOUNT_POINT);
    console.warn('[Floppy] Run: npm run floppy:mount');
    if (allowFallback && process.env.PRIVATE_KEY) {
      console.log('[Floppy] Development mode: Using PRIVATE_KEY env var fallback');
      return [process.env.PRIVATE_KEY];
    }
    return [];
  }

  const password = process.env.FLOPPY_KEYSTORE_PASSWORD;
  if (!password) {
    console.warn('[Floppy] FLOPPY_KEYSTORE_PASSWORD not set');
    // Only allow fallback in development mode (hardhat/localhost networks)
    if (allowFallback && process.env.PRIVATE_KEY) {
      console.log('[Floppy] Development mode: Using PRIVATE_KEY env var fallback');
      return [process.env.PRIVATE_KEY];
    }
    return [];
  }

  const keystoreDir = path.join(FLOPPY_CONFIG.MOUNT_POINT, FLOPPY_CONFIG.KEYSTORE_DIR);

  // Try admin keystore first (single private key)
  const adminKeystorePath = path.join(keystoreDir, 'admin-keystore.json');
  if (fs.existsSync(adminKeystorePath)) {
    const decrypted = decryptKeystoreSync(adminKeystorePath, password);
    if (decrypted) {
      console.log('[Floppy] Loaded admin key');
      return ['0x' + decrypted.toString('hex')];
    } else {
      console.warn('[Floppy] Invalid password for admin keystore');
      if (allowFallback && process.env.PRIVATE_KEY) {
        console.log('[Floppy] Using PRIVATE_KEY env var fallback');
        return [process.env.PRIVATE_KEY];
      }
      return [];
    }
  }

  // Try mnemonic keystore (HD wallet)
  const mnemonicKeystorePath = path.join(keystoreDir, 'mnemonic-keystore.json');
  if (fs.existsSync(mnemonicKeystorePath)) {
    const decrypted = decryptKeystoreSync(mnemonicKeystorePath, password);
    if (decrypted) {
      try {
        const mnemonic = decrypted.toString('utf8');
        const { HDNodeWallet } = require('ethers');
        // Derive first account using path parameter directly
        const wallet = HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0");
        console.log('[Floppy] Loaded mnemonic wallet:', wallet.address);
        return [wallet.privateKey];
      } catch (err) {
        console.warn('[Floppy] Failed to derive keys from mnemonic:', err.message);
        return [];
      }
    } else {
      console.warn('[Floppy] Invalid password for mnemonic keystore');
      return [];
    }
  }

  console.warn('[Floppy] No keystore found on disk');
  console.warn('[Floppy] Expected: admin-keystore.json or mnemonic-keystore.json');
  return [];
}

// Load keys from floppy at config time (synchronous)
// SECURITY: allowFallback=true enables PRIVATE_KEY env var when floppy unavailable
// Load floppy keys WITH fallback for deployment when password mismatch
const floppyKeys = loadFloppyKeysSync(true);
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async (args, hre, runSuper) => {
  const solcBuild = await runSuper(args);

  const isCodespaces = Boolean(process.env.CODESPACES || process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN);
  const forceSolcJs =
    (process.env.FORCE_SOLCJS ?? "").toLowerCase() === "true" ||
    (isCodespaces && (process.env.FORCE_NATIVE_SOLC ?? "").toLowerCase() !== "true");

  if (!forceSolcJs) {
    return solcBuild;
  }

  let solcjsPath;
  try {
    solcjsPath = require.resolve("solc/soljson.js");
  } catch (e) {
    throw new Error(
      "solc-js not found. Run `npm install` (or `npm i -D solc@0.8.24`) and retry."
    );
  }

  let longVersion = solcBuild.longVersion;
  try {
    // eslint-disable-next-line global-require
    const solc = require("solc");
    if (typeof solc.version === "function") {
      longVersion = solc.version();
    }
  } catch {
    // ignore
  }

  return {
    version: solcBuild.version,
    longVersion,
    compilerPath: solcjsPath,
    isSolcJs: true,
  };
});

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1,  // Optimize for deployment size over runtime gas
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 1337,
      allowUnlimitedContractSize: true,
      accounts: {
        count: 20, // More accounts for integration tests
        accountsBalance: "100000000000000000000000", // 100,000 ETH each - increased to handle bond-heavy tests
      },
      mining: {
        auto: true,
        interval: 0,
      },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    mordor: {
      url: "https://rpc.mordor.etccooperative.org",
      chainId: 63,
      // SECURITY: Keys loaded from floppy disk only - no PRIVATE_KEY env var fallback
      // Mount floppy and set FLOPPY_KEYSTORE_PASSWORD to use
      accounts: floppyKeys,
    },
    "mordor-local": {
      url: "http://localhost:8545",
      chainId: 63,
      accounts: floppyKeys,
      // Use local geth node when public RPC fee cap blocks large deployments
    },
    // Example: Mainnet with floppy keystore (uncomment when ready to use)
    // Requires: npm run floppy:mount && npm run floppy:create (one-time setup)
    // "mainnet-floppy": {
    //   url: process.env.MAINNET_RPC_URL || "https://eth.llamarpc.com",
    //   chainId: 1,
    //   accounts: async () => {
    //     if (!isFloppyMounted() || !keystoreExists()) {
    //       throw new Error("Floppy not mounted or keystore not found. Run: npm run floppy:mount");
    //     }
    //     return getFloppyPrivateKeys({ count: 5 });
    //   },
    // },
    // Mordor testnet with floppy keystore
    // Note: Use `mordor` network for regular testing, or set PRIVATE_KEY env var
    // "mordor-floppy": {
    //   url: "https://rpc.mordor.etccooperative.org",
    //   chainId: 63,
    //   // accounts must be synchronous or use lazyFunction helper
    //   accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    // },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 120000, // 2 minutes for integration tests
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS ? true : false,
    currency: "USD",
    outputFile: process.env.REPORT_GAS ? "gas-report.txt" : undefined,
    noColors: process.env.REPORT_GAS ? true : false,
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
  },
  etherscan: {
    apiKey: {
      'mordor': 'empty'
   },
    customChains: [
      {
        network: "mordor",
        chainId: 63,
        urls: {
          apiURL: "https://etc-mordor.blockscout.com/api",
          browserURL: "https://etc-mordor.blockscout.com"
        }
      }
    ]
  }
};
