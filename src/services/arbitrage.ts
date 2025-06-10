import { ethers } from "ethers";
import { QUOTER_ADDRESSES } from "@uniswap/sdk-core";
import axios from "axios";
import {
  NETWORKS,
  TOKENS,
  POOL_CONFIGS,
  SWAP_ROUTER_ADDRESSES,
  COINGECKO_CONFIG,
} from "../config/config";
import {
  ERC20_ABI,
  POOL_ABI,
  QUOTER_V2_ABI,
  SWAP_ROUTER_ABI,
} from "../contracts/abi";
import { VolumeService } from "./volume";
import {
  ArbitrageOpportunity,
  NetworkConfig,
  PendingArbitrage,
  PriceData,
  SwapEventData,
  TradeParams,
} from "../types";

interface PoolConfig {
  address: string;
}

export class ArbitrageService {
  private networks: Map<string, NetworkConfig> = new Map();
  private poolConfigs: Map<string, PoolConfig[]> = new Map();
  private poolContracts: Map<string, ethers.Contract[]> = new Map();
  private volumeService: VolumeService;

  private minProfitThreshold: number = 1; // 1% minimum profit
  private seedTradeAmount: string = "1000000000000000000000"; // 1000 SEED tokens
  private wethTradeAmount: string = "1000000000000000000"; // 1 WETH token

  // Sequential processing state
  private currentArbitrages: Map<string, PendingArbitrage> = new Map();
  private isProcessingArbitrage: boolean = false;
  private eventQueue: SwapEventData[] = [];
  private processQueue: boolean = true;
  private maxQueueSize: number = 100;

  // Tracking our own transactions to avoid infinite loops
  private ourTransactions: Set<string> = new Set();
  private ourAddresses: Set<string> = new Set();
  private isGloballyProcessing: boolean = false;

  // Rate limiting and cooldown
  private lastProcessedTime: number = 0;
  private processingCooldown: number = 1000; // 1 second cooldown

  // Enhanced error handling
  private consecutiveErrors: number = 0;
  private maxConsecutiveErrors: number = 5;
  private errorBackoffTime: number = 30000; // 30 seconds
  private lastErrorTime: number = 0;

  constructor(private privateKey?: string) {
    privateKey = process.env.PRIVATE_KEY || privateKey;
    this.initializeNetworks();
    this.initializePoolConfigs();
    this.initializePoolContracts();

    // Initialize volume service
    this.volumeService = new VolumeService(
      this.networks,
      this.poolConfigs,
      this.executeTrade.bind(this),
      this.fetchCoinGeckoPrices.bind(this),
      this.getPoolInfo.bind(this)
    );

    this.startQueueProcessor();
  }

  private initializeNetworks(): void {
    // Ethereum
    const ethProvider = new ethers.providers.JsonRpcProvider(
      NETWORKS.ethereum.rpcUrl
    );
    const ethQuoter = new ethers.Contract(
      QUOTER_ADDRESSES[NETWORKS.ethereum.chainId],
      QUOTER_V2_ABI,
      ethProvider
    );

    let ethWallet, ethSwapRouter;
    if (this.privateKey) {
      ethWallet = new ethers.Wallet(this.privateKey, ethProvider);
      ethSwapRouter = new ethers.Contract(
        SWAP_ROUTER_ADDRESSES[1],
        SWAP_ROUTER_ABI,
        ethWallet
      );
    }

    this.networks.set("ethereum", {
      chainId: NETWORKS.ethereum.chainId,
      provider: ethProvider,
      wallet: ethWallet,
      quoter: ethQuoter,
      swapRouter: ethSwapRouter,
      tokens: TOKENS.ethereum,
      name: NETWORKS.ethereum.name,
      gasPrice: NETWORKS.ethereum.gasPrice,
    });

    // Arbitrum
    const arbProvider = new ethers.providers.JsonRpcProvider(
      NETWORKS.arbitrum.rpcUrl
    );
    const arbQuoter = new ethers.Contract(
      QUOTER_ADDRESSES[NETWORKS.arbitrum.chainId],
      QUOTER_V2_ABI,
      arbProvider
    );

    let arbWallet, arbSwapRouter;
    if (this.privateKey) {
      arbWallet = new ethers.Wallet(this.privateKey, arbProvider);
      arbSwapRouter = new ethers.Contract(
        SWAP_ROUTER_ADDRESSES[42161],
        SWAP_ROUTER_ABI,
        arbWallet
      );
    }

    this.networks.set("arbitrum", {
      chainId: NETWORKS.arbitrum.chainId,
      provider: arbProvider,
      wallet: arbWallet,
      quoter: arbQuoter,
      swapRouter: arbSwapRouter,
      tokens: TOKENS.arbitrum,
      name: NETWORKS.arbitrum.name,
      gasPrice: NETWORKS.arbitrum.gasPrice,
    });
  }

  private initializePoolConfigs(): void {
    this.poolConfigs.set("ethereum", POOL_CONFIGS.ethereum);
    this.poolConfigs.set("arbitrum", POOL_CONFIGS.arbitrum);
  }

  private initializePoolContracts(): void {
    for (const [networkKey, network] of this.networks.entries()) {
      const poolConfigs = this.poolConfigs.get(networkKey);
      if (!poolConfigs) continue;

      const contracts = poolConfigs.map(
        (config) =>
          new ethers.Contract(config.address, POOL_ABI, network.provider)
      );

      this.poolContracts.set(networkKey, contracts);
    }
  }

  private async rotateApiKey(): Promise<string> {
    const currentKey =
      COINGECKO_CONFIG.apiKeys[COINGECKO_CONFIG.currentKeyIndex];
    COINGECKO_CONFIG.currentKeyIndex =
      (COINGECKO_CONFIG.currentKeyIndex + 1) % COINGECKO_CONFIG.apiKeys.length;
    return currentKey;
  }

  private async fetchCoinGeckoPrices(): Promise<{
    ethereum: PriceData;
    seed?: PriceData;
  }> {
    const now = Date.now();
    if (now - COINGECKO_CONFIG.lastRequest < COINGECKO_CONFIG.rateLimit) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          COINGECKO_CONFIG.rateLimit - (now - COINGECKO_CONFIG.lastRequest)
        )
      );
    }

    const apiKey = await this.rotateApiKey();

    try {
      const response = await axios.get(COINGECKO_CONFIG.url, {
        headers: {
          "x-cg-demo-api-key": apiKey,
        },
        params: {
          ids: "ethereum,seed-token",
          vs_currencies: "usd",
        },
        timeout: 10000, // 10 second timeout
      });

      COINGECKO_CONFIG.lastRequest = Date.now();

      return {
        ethereum: {
          ethereum: 1,
          usd: response.data.ethereum?.usd || 0,
        },
        seed: response.data["seed-token"]
          ? {
              ethereum:
                response.data["seed-token"].usd / response.data.ethereum.usd,
              usd: response.data["seed-token"].usd,
            }
          : undefined,
      };
    } catch (error: any) {
      console.error(`❌ CoinGecko API error: ${error.message}`);
      throw new Error("Failed to fetch prices");
    }
  }

  private async calculateMinAmountOut(
    networkKey: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    fee: number,
    slippagePercent: number = 5
  ): Promise<string> {
    const network = this.networks.get(networkKey);
    if (!network) return "0";

    try {
      const quote = await network.quoter.callStatic.quoteExactInputSingle(
        tokenIn,
        tokenOut,
        fee,
        amountIn,
        0
      );

      // Apply slippage tolerance
      const minAmount = quote.mul(100 - slippagePercent).div(100);
      return minAmount.toString();
    } catch (error) {
      console.error(`Failed to calculate min amount: ${error}`);
      return "0"; // Accept any amount if calculation fails
    }
  }

  private async getPoolInfo(
    poolAddress: string,
    network: NetworkConfig
  ): Promise<{
    isValid: boolean;
    actualFee?: number;
    token0?: string;
    token1?: string;
    token0IsSeed?: boolean;
  }> {
    try {
      const poolContract = new ethers.Contract(
        poolAddress,
        POOL_ABI,
        network.provider
      );
      const [token0, token1, fee, liquidity] = await Promise.all([
        poolContract.token0(),
        poolContract.token1(),
        poolContract.fee(),
        poolContract.liquidity(),
      ]);

      const token0Lower = token0.toLowerCase();
      const token1Lower = token1.toLowerCase();
      const seedLower = network.tokens.SEED.address.toLowerCase();
      const wethLower = network.tokens.WETH.address.toLowerCase();

      const hasSeed = token0Lower === seedLower || token1Lower === seedLower;
      const hasWeth = token0Lower === wethLower || token1Lower === wethLower;

      if (!hasSeed || !hasWeth || liquidity.eq(0)) {
        return { isValid: false };
      }

      return {
        isValid: true,
        actualFee: fee,
        token0,
        token1,
        token0IsSeed: token0Lower === seedLower,
      };
    } catch (error: any) {
      return { isValid: false };
    }
  }

  private async getQuote(networkKey: string): Promise<{
    network: string;
    seedToWethRate: number;
    wethToSeedRate: number;
    poolAddress: string;
    fee: number;
  } | null> {
    const network = this.networks.get(networkKey);
    const poolConfigs = this.poolConfigs.get(networkKey);

    if (!network || !poolConfigs || poolConfigs.length === 0) {
      return null;
    }

    const poolConfig = poolConfigs[0];
    const poolInfo = await this.getPoolInfo(poolConfig.address, network);

    if (!poolInfo.isValid || poolInfo.actualFee === undefined) {
      return null;
    }

    try {
      const seedToWethQuote =
        await network.quoter.callStatic.quoteExactInputSingle(
          network.tokens.SEED.address,
          network.tokens.WETH.address,
          poolInfo.actualFee,
          this.seedTradeAmount,
          0
        );

      const wethToSeedQuote =
        await network.quoter.callStatic.quoteExactInputSingle(
          network.tokens.WETH.address,
          network.tokens.SEED.address,
          poolInfo.actualFee,
          this.wethTradeAmount,
          0
        );

      return {
        network: network.name,
        seedToWethRate: parseFloat(
          ethers.utils.formatUnits(seedToWethQuote, 18)
        ),
        wethToSeedRate: parseFloat(
          ethers.utils.formatUnits(wethToSeedQuote, 18)
        ),
        poolAddress: poolConfig.address,
        fee: poolInfo.actualFee,
      };
    } catch (error: any) {
      console.error(`❌ Quote failed for ${network.name}: ${error.message}`);
      return null;
    }
  }

  private async calculateArbitrageOpportunity(
    ethQuote: any,
    arbQuote: any,
    prices: any
  ): Promise<ArbitrageOpportunity | null> {
    if (!ethQuote || !arbQuote || !prices.ethereum) {
      return null;
    }

    // Calculate USD prices for SEED on each network
    const ethSeedUsdPrice = ethQuote.seedToWethRate * prices.ethereum.usd;
    const arbSeedUsdPrice = arbQuote.seedToWethRate * prices.ethereum.usd;

    // Determine arbitrage direction
    let buyNetwork, sellNetwork, buyPrice, sellPrice;
    if (ethSeedUsdPrice < arbSeedUsdPrice) {
      buyNetwork = "Ethereum";
      sellNetwork = "Arbitrum";
      buyPrice = ethSeedUsdPrice;
      sellPrice = arbSeedUsdPrice;
    } else {
      buyNetwork = "Arbitrum";
      sellNetwork = "Ethereum";
      buyPrice = arbSeedUsdPrice;
      sellPrice = ethSeedUsdPrice;
    }

    const profitPercentage = ((sellPrice - buyPrice) / buyPrice) * 100;
    const estimatedProfit = sellPrice - buyPrice;

    // Estimate gas costs
    const buyGasEstimate = buyNetwork === "Ethereum" ? 150000 : 80000;
    const sellGasEstimate = sellNetwork === "Ethereum" ? 150000 : 80000;
    const totalGasEstimate = buyGasEstimate + sellGasEstimate;

    return {
      buyNetwork,
      sellNetwork,
      buyPrice,
      sellPrice,
      profitPercentage,
      estimatedProfit,
      gasEstimate: totalGasEstimate,
    };
  }

  private async checkBalances(networkKey: string): Promise<{
    weth: string;
    seed: string;
    nativeToken: string;
  }> {
    const network = this.networks.get(networkKey);
    if (!network || !network.wallet) {
      throw new Error(`Network ${networkKey} not configured with wallet`);
    }

    const wethContract = new ethers.Contract(
      network.tokens.WETH.address,
      ERC20_ABI,
      network.provider
    );

    const seedContract = new ethers.Contract(
      network.tokens.SEED.address,
      ERC20_ABI,
      network.provider
    );

    const [wethBalance, seedBalance, nativeBalance] = await Promise.all([
      wethContract.balanceOf(network.wallet.address),
      seedContract.balanceOf(network.wallet.address),
      network.provider.getBalance(network.wallet.address),
    ]);

    return {
      weth: ethers.utils.formatUnits(wethBalance, 18),
      seed: ethers.utils.formatUnits(seedBalance, 18),
      nativeToken: ethers.utils.formatUnits(nativeBalance, 18),
    };
  }

  private async executeTrade(params: TradeParams): Promise<{
    success: boolean;
    txHash?: string;
    error?: string;
  }> {
    const network = this.networks.get(params.network.toLowerCase());
    if (!network || !network.wallet || !network.swapRouter) {
      return {
        success: false,
        error: `Network ${params.network} not configured for trading`,
      };
    }

    const tokenContract = new ethers.Contract(
      params.tokenIn,
      ERC20_ABI,
      network.wallet
    );
    const currentAllowance = await tokenContract.allowance(
      network.wallet.address,
      network.swapRouter.address
    );
    if (currentAllowance.lt(params.amountIn)) {
      const approveTx = await tokenContract.approve(
        network.swapRouter.address,
        ethers.constants.MaxUint256
      );
      await approveTx.wait();
    }

    try {
      console.log(`Executing trade on ${params.network}...`);

      const swapParams = {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        fee: params.fee,
        recipient: network.wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 300,
        amountIn: params.amountIn,
        amountOutMinimum: params.minAmountOut,
        sqrtPriceLimitX96: 0,
      };

      const gasPrice = await network.provider.getGasPrice();
      console.log(
        `Current gas price: ${ethers.utils.formatUnits(gasPrice, "gwei")} Gwei`
      );
      const txOptions = {
        gasLimit: 500000,
        gasPrice: gasPrice.mul(110).div(100), // 10% above current gas
      };

      const swapTx = await network.swapRouter.exactInputSingle(
        swapParams,
        txOptions
      );
      console.log(`Transaction hash: ${swapTx.hash}`);

      // Track our transaction
      this.ourTransactions.add(swapTx.hash.toLowerCase());

      await swapTx.wait(1);
      console.log(`✅ Trade executed successfully`);

      return {
        success: true,
        txHash: swapTx.hash,
      };
    } catch (error: any) {
      const errorMessage = error.reason || error.message;
      const simpleError = errorMessage.split("(")[0].trim();

      return {
        success: false,
        error: simpleError,
      };
    }
  }

  private async executeArbitrage(
    opportunity: ArbitrageOpportunity
  ): Promise<boolean> {
    const arbitrageId = `${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    console.log(`\n🚀 EXECUTING ARBITRAGE ${arbitrageId}`);
    console.log(
      `Buy ${opportunity.buyNetwork} → Sell ${opportunity.sellNetwork}`
    );
    console.log(`Expected profit: ${opportunity.profitPercentage.toFixed(2)}%`);

    // Create pending arbitrage record
    const pendingArbitrage: PendingArbitrage = {
      id: arbitrageId,
      opportunity,
      timestamp: Date.now(),
      status: "executing",
    };

    this.currentArbitrages.set(arbitrageId, pendingArbitrage);

    try {
      const buyNetworkKey = opportunity.buyNetwork.toLowerCase();
      const sellNetworkKey = opportunity.sellNetwork.toLowerCase();

      // Check balances
      const buyNetworkBalances = await this.checkBalances(buyNetworkKey);
      const sellNetworkBalances = await this.checkBalances(sellNetworkKey);

      console.log(`\nBalances before arbitrage:`);
      console.log(
        `${opportunity.buyNetwork}: ${buyNetworkBalances.seed} SEED, ${buyNetworkBalances.weth} WETH`
      );
      console.log(
        `${opportunity.sellNetwork}: ${sellNetworkBalances.seed} SEED, ${sellNetworkBalances.weth} WETH`
      );

      // Validate we have sufficient funds
      const requiredWeth = parseFloat(
        ethers.utils.formatUnits(this.wethTradeAmount, 18)
      );

      if (parseFloat(buyNetworkBalances.weth) < requiredWeth) {
        throw new Error(
          `Insufficient WETH on ${opportunity.buyNetwork}. Have: ${buyNetworkBalances.weth}, Need: ${requiredWeth}`
        );
      }

      // Step 1: Buy SEED on the cheaper network
      const buyNetwork = this.networks.get(buyNetworkKey);
      const buyPoolConfig = this.poolConfigs.get(buyNetworkKey)?.[0];

      if (!buyNetwork || !buyPoolConfig) {
        throw new Error(`Buy network configuration not found`);
      }

      const buyPoolInfo = await this.getPoolInfo(
        buyPoolConfig.address,
        buyNetwork
      );
      if (!buyPoolInfo.isValid) {
        throw new Error(`Invalid buy pool`);
      }

      const expectedSeedOutput = await this.calculateMinAmountOut(
        buyNetworkKey,
        buyNetwork.tokens.WETH.address,
        buyNetwork.tokens.SEED.address,
        this.wethTradeAmount,
        buyPoolInfo.actualFee!,
        10 // 10% slippage tolerance
      );

      const buyParams: TradeParams = {
        tokenIn: buyNetwork.tokens.WETH.address,
        tokenOut: buyNetwork.tokens.SEED.address,
        fee: buyPoolInfo.actualFee!,
        amountIn: this.wethTradeAmount,
        network: opportunity.buyNetwork,
        minAmountOut: expectedSeedOutput,
      };

      // Check if we actually have the tokens we're trying to trade
      const tokenInContract = new ethers.Contract(
        buyParams.tokenIn,
        ERC20_ABI,
        buyNetwork.provider
      );

      const actualBalance = await tokenInContract.balanceOf(
        buyNetwork.wallet.address
      );
      if (actualBalance.lt(buyParams.amountIn)) {
        throw new Error(`Insufficient ${buyParams.tokenIn} balance`);
      }

      const buyResult = await this.executeTrade(buyParams);
      if (!buyResult.success) {
        throw new Error(`Buy trade failed: ${buyResult.error}`);
      }

      pendingArbitrage.buyTxHash = buyResult.txHash;
      pendingArbitrage.status = "executing";

      // Wait for the transaction to settle and get updated SEED balance
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Get current SEED balance to sell
      const sellNetwork = this.networks.get(sellNetworkKey);
      const sellPoolConfig = this.poolConfigs.get(sellNetworkKey)?.[0];

      if (!sellNetwork || !sellPoolConfig) {
        throw new Error(`Sell network configuration not found`);
      }

      const sellPoolInfo = await this.getPoolInfo(
        sellPoolConfig.address,
        sellNetwork
      );
      if (!sellPoolInfo.isValid) {
        throw new Error(`Invalid sell pool`);
      }

      const seedContract = new ethers.Contract(
        sellNetwork.tokens.SEED.address,
        ERC20_ABI,
        sellNetwork.provider
      );

      const currentSeedBalance = await seedContract.balanceOf(
        sellNetwork.wallet!.address
      );

      if (currentSeedBalance.eq(0)) {
        throw new Error(
          `No SEED balance available to sell on ${opportunity.sellNetwork}`
        );
      }

      const expectedWethOutput = await this.calculateMinAmountOut(
        sellNetworkKey,
        sellNetwork.tokens.SEED.address,
        sellNetwork.tokens.WETH.address,
        this.seedTradeAmount.toString(),
        sellPoolInfo.actualFee!,
        10 // 10% slippage tolerance
      );

      const sellParams: TradeParams = {
        tokenIn: sellNetwork.tokens.SEED.address,
        tokenOut: sellNetwork.tokens.WETH.address,
        fee: sellPoolInfo.actualFee!,
        amountIn: this.seedTradeAmount.toString(),
        network: opportunity.sellNetwork,
        minAmountOut: expectedWethOutput,
      };

      const sellResult = await this.executeTrade(sellParams);
      if (!sellResult.success) {
        throw new Error(`Sell trade failed: ${sellResult.error}`);
      }

      pendingArbitrage.sellTxHash = sellResult.txHash;
      pendingArbitrage.status = "completed";

      console.log(`✅ ARBITRAGE ${arbitrageId} COMPLETED SUCCESSFULLY`);

      // Reset consecutive errors on success
      this.consecutiveErrors = 0;

      return true;
    } catch (error: any) {
      console.error(
        `❌ Arbitrage ${arbitrageId} execution failed: ${error.message}`
      );
      pendingArbitrage.status = "failed";

      this.consecutiveErrors++;
      this.lastErrorTime = Date.now();

      return false;
    } finally {
      // Clean up completed/failed arbitrages after some time
      setTimeout(() => {
        this.currentArbitrages.delete(arbitrageId);
      }, 5 * 60 * 1000);
    }
  }

  private isOurTransaction(eventData: SwapEventData): boolean {
    const txHashLower = eventData.txHash.toLowerCase();
    const senderLower = eventData.sender.toLowerCase();

    return (
      this.ourTransactions.has(txHashLower) ||
      this.ourAddresses.has(senderLower)
    );
  }

  private startQueueProcessor(): void {
    // Process queue every few seconds if there are pending events
    setInterval(() => {
      if (
        this.eventQueue.length > 0 &&
        !this.isProcessingArbitrage &&
        this.processQueue
      ) {
        this.processEventQueue().catch((error) => {
          console.error(`❌ Queue processor error: ${error.message}`);
        });
      }
    }, 3000); // Check every 3 seconds
  }

  private setupEventListeners(): void {
    console.log(`\n🎧 SETTING UP EVENT LISTENERS`);
    console.log("=".repeat(50));

    for (const [networkKey, contracts] of this.poolContracts.entries()) {
      const network = this.networks.get(networkKey);
      if (!network) continue;

      console.log(`📡 Listening to ${network.name} pools:`);

      contracts.forEach((contract: ethers.Contract, index: number) => {
        console.log(`   Pool ${index + 1}: ${contract.address}`);

        contract.on(
          "Swap",
          (
            sender: string,
            recipient: string,
            amount0: ethers.BigNumber,
            amount1: ethers.BigNumber,
            sqrtPriceX96: ethers.BigNumber,
            liquidity: ethers.BigNumber,
            tick: number,
            event: ethers.Event
          ) => {
            const eventData: SwapEventData = {
              network: network.name,
              poolAddress: contract.address,
              txHash: event.transactionHash,
              blockNumber: event.blockNumber,
              amount0,
              amount1,
              sqrtPriceX96,
              tick,
              sender,
            };

            // Handle the event asynchronously
            this.handleSwapEvent(eventData).catch((error) => {
              console.error(`❌ Error in swap event handler: ${error.message}`);
            });
          }
        );

        // Handle connection errors
        contract.provider.on("error", (error) => {
          console.error(
            `❌ Provider error for ${network.name}: ${error.message}`
          );
          // Attempt to reconnect after a delay
          setTimeout(() => {
            console.log(`🔄 Attempting to reconnect ${network.name}...`);
            this.reconnectNetwork(networkKey);
          }, 5000);
        });
      });
    }

    console.log(`✅ Event listeners setup complete`);
    console.log(`🎯 Listening for swap events on all configured pools`);
  }

  private async reconnectNetwork(networkKey: string): Promise<void> {
    try {
      const network = this.networks.get(networkKey);
      if (!network) return;

      // Remove old listeners
      const contracts = this.poolContracts.get(networkKey);
      if (contracts) {
        contracts.forEach((contract: ethers.Contract) =>
          contract.removeAllListeners()
        );
      }

      // Recreate provider and contracts
      const newProvider = new ethers.providers.JsonRpcProvider(
        networkKey === "ethereum"
          ? NETWORKS.ethereum.rpcUrl
          : NETWORKS.arbitrum.rpcUrl
      );

      network.provider = newProvider;

      // Update quoter
      network.quoter = new ethers.Contract(
        QUOTER_ADDRESSES[network.chainId],
        QUOTER_V2_ABI,
        newProvider
      );

      // Update wallet and swap router if available
      if (this.privateKey) {
        network.wallet = new ethers.Wallet(this.privateKey, newProvider);
        network.swapRouter = new ethers.Contract(
          SWAP_ROUTER_ADDRESSES[network.chainId as 1 | 42161],
          SWAP_ROUTER_ABI,
          network.wallet
        );
      }

      // Recreate pool contracts
      const poolConfigs = this.poolConfigs.get(networkKey);
      if (poolConfigs) {
        const newContracts = poolConfigs.map(
          (config) => new ethers.Contract(config.address, POOL_ABI, newProvider)
        );
        this.poolContracts.set(networkKey, newContracts);
      }

      console.log(`✅ Successfully reconnected ${network.name}`);

      // Re-setup listeners for this network
      this.setupEventListenersForNetwork(networkKey);
    } catch (error: any) {
      console.error(`❌ Failed to reconnect ${networkKey}: ${error.message}`);
    }
  }
  private setupEventListenersForNetwork(networkKey: string): void {
    const contracts = this.poolContracts.get(networkKey);
    const network = this.networks.get(networkKey);

    if (!contracts || !network) return;

    contracts.forEach((contract: ethers.Contract) => {
      contract.on(
        "Swap",
        (
          sender: string,
          recipient: string,
          amount0: ethers.BigNumber,
          amount1: ethers.BigNumber,
          sqrtPriceX96: ethers.BigNumber,
          liquidity: ethers.BigNumber,
          tick: number,
          event: ethers.Event
        ) => {
          const eventData: SwapEventData = {
            network: network.name,
            poolAddress: contract.address,
            txHash: event.transactionHash,
            blockNumber: event.blockNumber,
            amount0,
            amount1,
            sqrtPriceX96,
            tick,
            sender,
          };

          this.handleSwapEvent(eventData).catch((error) => {
            console.error(`❌ Error in swap event handler: ${error.message}`);
          });
        }
      );
    });
  }

  async scanAndExecute(): Promise<void> {
    console.log(`\n🔍 SCANNING FOR ARBITRAGE OPPORTUNITIES`);
    console.log("=".repeat(60));

    try {
      const prices = await this.fetchCoinGeckoPrices();

      const [ethQuote, arbQuote] = await Promise.all([
        this.getQuote("ethereum"),
        this.getQuote("arbitrum"),
      ]);

      if (!ethQuote || !arbQuote) {
        console.log("❌ Failed to get quotes from both networks");
        return;
      }

      const opportunity = await this.calculateArbitrageOpportunity(
        ethQuote,
        arbQuote,
        prices
      );

      if (!opportunity) {
        console.log("❌ No arbitrage opportunity found");
        return;
      }

      console.log(`\n📊 ARBITRAGE OPPORTUNITY FOUND`);
      console.log(
        `Buy on: ${opportunity.buyNetwork} at ${opportunity.buyPrice.toFixed(
          6
        )}`
      );
      console.log(
        `Sell on: ${opportunity.sellNetwork} at ${opportunity.sellPrice.toFixed(
          6
        )}`
      );
      console.log(
        `Profit: ${opportunity.profitPercentage.toFixed(
          2
        )}% (${opportunity.estimatedProfit.toFixed(6)})`
      );

      if (opportunity.profitPercentage >= this.minProfitThreshold) {
        if (this.privateKey) {
          console.log(`\n🎯 Profit threshold met! Executing arbitrage...`);
          await this.executeArbitrage(opportunity);
        } else {
          console.log(
            `\n⚠️  Profitable opportunity found but no private key provided for trading`
          );
          console.log(
            `   Add private key to constructor to enable automatic trading`
          );
        }
      } else {
        console.log(
          `\n💤 Profit ${opportunity.profitPercentage.toFixed(
            2
          )}% below threshold ${this.minProfitThreshold}%`
        );
      }
    } catch (error: any) {
      console.error(`❌ Scan failed: ${error.message}`);
    }
  }

  // Fixed handleSwapEvent method for sequential processing
  private async handleSwapEvent(eventData: SwapEventData): Promise<void> {
    // Check if this is our own transaction to avoid processing our own swaps
    // if (this.isOurTransaction(eventData)) {
    //   console.log(
    //     `⭐ Detected our own transaction: ${eventData.txHash} - skipping`
    //   );
    //   return;
    // }

    // Check if we should skip processing due to various conditions
    if (this.shouldSkipProcessing()) {
      return;
    }

    // Add to event queue if we're using queue processing
    if (this.eventQueue.length >= this.maxQueueSize) {
      console.log(
        `⚠️ Event queue full (${this.maxQueueSize}), dropping oldest events`
      );
      this.eventQueue.shift();
    }

    this.eventQueue.push(eventData);

    // If we're not globally processing and queue processing is enabled, trigger processing
    if (!this.isGloballyProcessing && this.processQueue) {
      this.processEventQueue().catch((error) => {
        console.error(`❌ Error processing event queue: ${error.message}`);
      });
    }
  }

  private async processEventQueue(): Promise<void> {
    if (this.isGloballyProcessing || this.eventQueue.length === 0) {
      return;
    }

    this.isGloballyProcessing = true;
    const now = Date.now();

    try {
      const eventData = this.eventQueue.pop();
      if (!eventData) {
        return;
      }

      // Clear the queue as we're processing
      this.eventQueue = [];

      const timestamp = new Date().toLocaleString();
      console.log(`\n🔔 PROCESSING SWAP EVENT`);
      console.log(`⏰ ${timestamp}`);
      console.log(`🌐 Network: ${eventData.network}`);
      console.log(`🏊 Pool: ${eventData.poolAddress}`);
      console.log(`📋 Tx: ${eventData.txHash}`);
      console.log(`#️⃣ Block: ${eventData.blockNumber}`);
      console.log(`👤 Sender: ${eventData.sender}`);
      console.log("=".repeat(60));

      this.lastProcessedTime = now;

      // Scan and execute arbitrages sequentially
      await this.scanAndExecute();
    } catch (error: any) {
      console.error(`❌ Error processing event queue: ${error.message}`);
      this.consecutiveErrors++;
      this.lastErrorTime = Date.now();
    } finally {
      this.isGloballyProcessing = false;
    }
  }

  private shouldSkipProcessing(): boolean {
    const now = Date.now();

    // Skip if already processing (sequential execution)
    if (this.isGloballyProcessing) {
      console.log(`⏸️ Already processing, skipping...`);
      return true;
    }

    // Skip if too many consecutive errors and in backoff period
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      if (now - this.lastErrorTime < this.errorBackoffTime) {
        console.log(
          `⏸️ In error backoff period (${this.consecutiveErrors} consecutive errors)`
        );
        return true;
      } else {
        // Reset error count after backoff period
        this.consecutiveErrors = 0;
      }
    }

    // Basic cooldown
    if (now - this.lastProcessedTime < this.processingCooldown) {
      return true;
    }

    return false;
  }

  async startEventListening(): Promise<void> {
    console.log(`\n🚀 STARTING EVENT-DRIVEN ARBITRAGE BOT`);
    console.log("=".repeat(60));
    console.log(`💰 Minimum profit threshold: ${this.minProfitThreshold}%`);
    console.log(
      `🎯 Trade amounts: ${ethers.utils.formatUnits(
        this.seedTradeAmount,
        18
      )} SEED, ${ethers.utils.formatUnits(this.wethTradeAmount, 18)} WETH`
    );
    console.log(
      `${this.privateKey ? "✅" : "❌"} Trading ${
        this.privateKey ? "ENABLED" : "DISABLED"
      }`
    );
    console.log(`⏱️  Processing cooldown: ${this.processingCooldown}ms`);
    console.log(`🔄 Sequential execution: ENABLED`);

    this.setupEventListeners();

    console.log(`\n🎧 Bot is now listening for swap events...`);
    console.log(`🔄 Arbitrage opportunities will be checked when swaps occur`);
    console.log(`📊 This is much more efficient than polling!`);

    // Perform initial scan
    console.log(`\n🔍 Performing initial arbitrage scan...`);
    await this.scanAndExecute();

    console.log(`\n✅ Event listeners active. Bot is running...`);
    console.log(`Press Ctrl+C to stop the bot`);

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      console.log(`\n\n🛑 Shutting down bot...`);
      this.cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.log(`\n\n🛑 Shutting down bot...`);
      this.cleanup();
      process.exit(0);
    });

    // Keep the process running
    return new Promise(() => {});
  }

  private cleanup(): void {
    console.log(`🧹 Cleaning up event listeners...`);

    for (const [networkKey, contracts] of this.poolContracts.entries()) {
      contracts.forEach((contract: ethers.Contract) => {
        contract.removeAllListeners();
      });
    }

    console.log(`✅ Cleanup complete`);
  }

  // Configuration methods
  public setMinProfitThreshold(percentage: number): void {
    this.minProfitThreshold = percentage;
  }

  public setTradeAmounts(seedAmount: string, wethAmount: string): void {
    this.seedTradeAmount = seedAmount;
    this.wethTradeAmount = wethAmount;
  }

  public setProcessingCooldown(milliseconds: number): void {
    this.processingCooldown = milliseconds;
  }

  // Volume service methods
  public async manualVolumeCheck(): Promise<void> {
    await this.volumeService.manualVolumeCheck();
  }

  public getVolumeStatus(): object {
    return this.volumeService.getVolumeStatus();
  }

  // Status and testing methods
  getStatus(): object {
    return {
      isGloballyProcessing: this.isGloballyProcessing,
      lastProcessedTime: this.lastProcessedTime,
      minProfitThreshold: this.minProfitThreshold,
      tradeAmounts: {
        seed: ethers.utils.formatUnits(this.seedTradeAmount, 18),
        weth: ethers.utils.formatUnits(this.wethTradeAmount, 18),
      },
      processingCooldown: this.processingCooldown,
      tradingEnabled: !!this.privateKey,
      networksConfigured: Array.from(this.networks.keys()),
      poolsListening: Array.from(this.poolContracts.entries()).map(
        ([network, contracts]) => ({
          network,
          poolCount: contracts.length,
          pools: contracts.map((c: ethers.Contract) => c.address),
        })
      ),
      eventQueueSize: this.eventQueue.length,
      consecutiveErrors: this.consecutiveErrors,
      currentArbitrages: this.currentArbitrages.size,
      sequentialExecution: true,
    };
  }

  public async manualScan(): Promise<void> {
    console.log(`\n🔧 MANUAL ARBITRAGE SCAN TRIGGERED`);
    await this.scanAndExecute();
  }
}
