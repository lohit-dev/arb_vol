import { Token } from "@uniswap/sdk-core";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const configPath = path.join(__dirname, "../../config.json");
const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));

const getEnvVar = (key: string, fallback?: string): string => {
  return process.env[key] || fallback || "";
};

export const NETWORKS = {
  ethereum: {
    chainId: rawConfig.networks.ethereum.chainId,
    rpcUrl: getEnvVar("ETHEREUM_RPC", "http://localhost:8545"),
    name: rawConfig.networks.ethereum.name,
    gasPrice: getEnvVar(
      "GAS_PRICE_ETHEREUM",
      rawConfig.networks.ethereum.gasPrice
    ),
  },
  arbitrum: {
    chainId: rawConfig.networks.arbitrum.chainId,
    rpcUrl: getEnvVar("ARBITRUM_RPC", "http://localhost:8546"),
    name: rawConfig.networks.arbitrum.name,
    gasPrice: getEnvVar(
      "GAS_PRICE_ARBITRUM",
      rawConfig.networks.arbitrum.gasPrice
    ),
  },
} as const;

export const VOLUME_CONFIG = {
  targetVolume: parseInt(
    getEnvVar("TARGET_VOLUME", rawConfig.volumeConfig.targetVolume.toString())
  ),
  checkInterval: parseInt(
    getEnvVar("CHECK_INTERVAL", rawConfig.volumeConfig.checkInterval.toString())
  ),
  rebalanceAmount: rawConfig.volumeConfig.rebalanceAmount,
  maxRebalanceAttempts: rawConfig.volumeConfig.maxRebalanceAttempts,
  volumeResetInterval: rawConfig.volumeConfig.volumeResetInterval,
} as const;

// CoinGecko Configuration
const apiKeysString = getEnvVar("COINGECKO_API_KEYS", "");
const apiKeys = apiKeysString
  ? apiKeysString.split(",").map((key) => key.trim())
  : [];

export const COINGECKO_CONFIG = {
  url: rawConfig.coingeckoConfig.url,
  apiKeys,
  currentKeyIndex: rawConfig.coingeckoConfig.currentKeyIndex,
  rateLimit: rawConfig.coingeckoConfig.rateLimit,
  lastRequest: rawConfig.coingeckoConfig.lastRequest,
};

const createTokens = (networkTokens: any) => {
  const tokens: { [key: string]: Token } = {};

  for (const [symbol, tokenData] of Object.entries(networkTokens)) {
    const data = tokenData as any;
    tokens[symbol] = new Token(
      data.chainId,
      data.address,
      data.decimals,
      data.symbol,
      data.name
    );
  }

  return tokens;
};

// Token Definitions
export const TOKENS = {
  ethereum: createTokens(rawConfig.tokens.ethereum) as {
    WETH: Token;
    SEED: Token;
  },
  arbitrum: createTokens(rawConfig.tokens.arbitrum) as {
    WETH: Token;
    SEED: Token;
  },
} as const;

// Pool configurations
export const POOL_CONFIGS = {
  ethereum: rawConfig.poolConfigs.ethereum,
  arbitrum: rawConfig.poolConfigs.arbitrum,
};

// Swap Router Addresses
export const SWAP_ROUTER_ADDRESSES: { [key in 1 | 42161]: string } = {
  1: rawConfig.swapRouterAddresses["1"],
  42161: rawConfig.swapRouterAddresses["42161"],
};

// Interfaces (unchanged)
export interface NetworkConfig {
  chainId: number;
  provider: ethers.providers.JsonRpcProvider;
  wallet?: ethers.Wallet;
  quoter: ethers.Contract;
  swapRouter?: ethers.Contract;
  tokens: { WETH: Token; SEED: Token };
  name: string;
  gasPrice: string;
}

export interface PriceData {
  ethereum: number;
  usd: number;
}

export interface ArbitrageOpportunity {
  buyNetwork: string;
  sellNetwork: string;
  buyPrice: number;
  sellPrice: number;
  profitPercentage: number;
  estimatedProfit: number;
  gasEstimate: number;
}

export interface TradeParams {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: string;
  network: string;
  minAmountOut: string;
}

export interface SwapEventData {
  network: string;
  poolAddress: string;
  txHash: string;
  blockNumber: number;
  amount0: any; // ethers.BigNumber
  amount1: any; // ethers.BigNumber
  sqrtPriceX96: any; // ethers.BigNumber
  tick: number;
  sender: string;
}

export interface PendingArbitrage {
  id: string;
  opportunity: ArbitrageOpportunity;
  timestamp: number;
  status: "pending" | "executing" | "completed" | "failed";
  buyTxHash?: string;
  sellTxHash?: string;
}

// Utility function to reload configuration (useful for hot-reloading)
export const reloadConfig = () => {
  // Clear require cache for config.json
  delete require.cache[require.resolve("../../config.json")];
  // Re-import and return new config
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
};
