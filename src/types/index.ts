import { Token } from "@uniswap/sdk-core";
import { ethers } from "ethers";

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
  amount0: ethers.BigNumber;
  amount1: ethers.BigNumber;
  sqrtPriceX96: ethers.BigNumber;
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

export interface DexScreenerResponse {
  pairs: Array<{
    chainId: string;
    dexId: string;
    url: string;
    pairAddress: string;
    baseToken: {
      address: string;
      name: string;
      symbol: string;
    };
    quoteToken: {
      address: string;
      name: string;
      symbol: string;
    };
    priceNative: string;
    priceUsd: string;
    volume: {
      h24: number;
      h6: number;
      h1: number;
      m5: number;
    };
    liquidity: {
      usd: number;
      base: number;
      quote: number;
    };
  }>;
}

export interface TokenConfig {
  chainId: number;
  address: string;
  decimals: number;
  symbol: string;
  name: string;
}

export interface PoolConfig {
  address: string;
}

export interface Config {
  networks: {
    [key: string]: NetworkConfig;
  };
  tokens: {
    [key: string]: {
      [key: string]: TokenConfig;
    };
  };
  poolConfigs: {
    [key: string]: PoolConfig[];
  };
}

export interface VolumeStatus {
  targetVolume: number;
  networkVolumes: [string, number][];
  rebalanceInProgress: [string, boolean][];
  lastVolumeReset: number;
}

export interface RebalanceResult {
  success: boolean;
  volumeGenerated: number;
  attempts: number;
}

export interface SwapEventData {
  network: string;
  poolAddress: string;
  txHash: string;
  blockNumber: number;
  amount0: ethers.BigNumber;
  amount1: ethers.BigNumber;
  sqrtPriceX96: ethers.BigNumber;
  tick: number;
  sender: string;
}

export interface QueueService {
  addToQueue(eventData: SwapEventData): void;
  processEventQueue(): Promise<void>;
  getQueueSize(): number;
  stopProcessing(): void;
  isProcessingStopped(): boolean;
  shouldSkipProcessing(): boolean;
  setProcessingCooldown(milliseconds: number): void;
}
