import { ethers } from "ethers";
import { ERC20_ABI } from "../contracts/abi";
import { VolumeService } from "./volume";
import { TradeService } from "./trades";
import {
  ArbitrageOpportunity,
  NetworkConfig,
  PendingArbitrage,
  PriceData,
  TradeParams,
} from "../types";
import { CoinGeckoService } from "./coingecko";
import { NetworkService } from "./network";
import { PoolService } from "./pool";
import { QueueService } from "./queue";
import { sleep } from "../utils";

export class ArbitrageService {
  private networks: Map<string, NetworkConfig> = new Map();
  private poolService: PoolService;
  private volumeService: VolumeService;
  private tradeService: TradeService;
  private coinGeckoService: CoinGeckoService;
  private networkService: NetworkService;
  private queueService: QueueService;

  private minProfitThreshold: number = 1; // 1% minimum profit
  private seedTradeAmount: string = "1000000000000000000000"; // 1000 SEED tokens
  private wethTradeAmount: string = "1000000000000000000"; // 1 WETH token

  // Sequential processing state
  private currentArbitrages: Map<string, PendingArbitrage> = new Map();

  constructor(private privateKey?: string) {
    privateKey = process.env.PRIVATE_KEY || privateKey;

    // First, initialize NetworkService as it sets up the networks
    this.networkService = new NetworkService(
      null, // We'll set this after QueueService is created
      null, // We'll set this after TradeService is created
      this.scanAndExecute.bind(this),
      privateKey
    );

    // Get the initialized networks
    this.networks = this.networkService.getNetworks();

    // Now initialize other services with the networks
    this.tradeService = new TradeService(this.networks);
    this.queueService = new QueueService(this.scanAndExecute.bind(this));
    this.coinGeckoService = new CoinGeckoService();
    this.poolService = new PoolService(this.networks);

    // Update NetworkService with the created services
    this.networkService.setServices(this.queueService, this.tradeService);

    // Initialize pool service in NetworkService
    this.networkService.initializePoolService(this.poolService);

    // Finally initialize VolumeService which depends on all
    this.volumeService = new VolumeService(
      this.networkService,
      this.poolService,
      this.tradeService,
      this.coinGeckoService
    );
  }

  private async fetchCoinGeckoPrices(): Promise<{
    ethereum: PriceData;
    seed?: PriceData;
  }> {
    return this.coinGeckoService.fetchPrices();
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

  private async getQuote(networkKey: string): Promise<{
    network: string;
    seedToWethRate: number;
    wethToSeedRate: number;
    poolAddress: string;
    fee: number;
  } | null> {
    const network = this.networks.get(networkKey);
    const poolConfigs = this.poolService.getPoolConfigs().get(networkKey);

    if (!network || !poolConfigs || poolConfigs.length === 0) {
      return null;
    }

    const poolConfig = poolConfigs[0];
    const poolInfo = await this.poolService.getPoolInfo(
      poolConfig.address,
      network
    );

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

      // Get network configs
      const buyNetwork = this.networks.get(buyNetworkKey);
      const sellNetwork = this.networks.get(sellNetworkKey);

      if (!buyNetwork || !sellNetwork) {
        throw new Error(`Network configuration not found for ${buyNetworkKey} or ${sellNetworkKey}`);
      }

      // Check if wallets are initialized
      if (!buyNetwork.wallet || !sellNetwork.wallet) {
        throw new Error(`Wallet not initialized for ${buyNetworkKey} or ${sellNetworkKey}`);
      }

      // Check balances
      const buyNetworkBalances = await this.tradeService.checkBalances(
        buyNetworkKey
      );
      const sellNetworkBalances = await this.tradeService.checkBalances(
        sellNetworkKey
      );

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
      const buyPoolConfig = this.poolService
        .getPoolConfigs()
        .get(buyNetworkKey)?.[0];

      if (!buyNetwork || !buyPoolConfig) {
        throw new Error(`Buy network configuration not found`);
      }

      const buyPoolInfo = await this.poolService.getPoolInfo(
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

      const buyResult = await this.tradeService.executeTrade(buyParams);
      if (!buyResult.success) {
        throw new Error(`Buy trade failed: ${buyResult.error}`);
      }

      pendingArbitrage.buyTxHash = buyResult.txHash;
      pendingArbitrage.status = "executing";

      // Wait for the transaction to settle and get updated SEED balance
      await sleep(5000); // Wait 5 seconds for the buy transaction to confirm

      // Get current SEED balance to sell
      const sellPoolConfig = this.poolService
        .getPoolConfigs()
        .get(sellNetworkKey)?.[0];

      if (!sellNetwork || !sellPoolConfig) {
        throw new Error(`Sell network configuration not found`);
      }

      const sellPoolInfo = await this.poolService.getPoolInfo(
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

      const sellResult = await this.tradeService.executeTrade(sellParams);
      if (!sellResult.success) {
        throw new Error(`Sell trade failed: ${sellResult.error}`);
      }

      pendingArbitrage.sellTxHash = sellResult.txHash;
      pendingArbitrage.status = "completed";

      console.log(`✅ ARBITRAGE ${arbitrageId} COMPLETED SUCCESSFULLY`);

      // Reset consecutive errors on success
      this.queueService.resetErrors();

      return true;
    } catch (error: any) {
      console.error(
        `❌ Arbitrage ${arbitrageId} execution failed: ${error.message}`
      );
      pendingArbitrage.status = "failed";

      // Track error using queue service
      this.queueService.trackError();

      return false;
    } finally {
      // Clean up completed/failed arbitrages after some time
      setTimeout(() => {
        this.currentArbitrages.delete(arbitrageId);
      }, 5 * 60 * 1000);
    }
  }

  public setProcessingCooldown(milliseconds: number): void {
    this.queueService.setProcessingCooldown(milliseconds);
  }

  public setMinProfitThreshold(percentage: number): void {
    this.minProfitThreshold = percentage;
    console.log(`📊 Minimum profit threshold set to ${percentage}%`);
  }

  public setTradeAmounts(seedAmount: string, wethAmount: string): void {
    this.seedTradeAmount = seedAmount;
    this.wethTradeAmount = wethAmount;
    console.log(`📊 Trade amounts updated:
    SEED: ${ethers.utils.formatUnits(seedAmount, 18)}
    WETH: ${ethers.utils.formatUnits(wethAmount, 18)}`);
  }

  // getStatus(): object {
  //   return {
  //     ...this.queueService.getStatus(),
  //     minProfitThreshold: this.minProfitThreshold,
  //     tradeAmounts: {
  //       seed: ethers.utils.formatUnits(this.seedTradeAmount, 18),
  //       weth: ethers.utils.formatUnits(this.wethTradeAmount, 18),
  //     },
  //     tradingEnabled: !!this.privateKey,
  //     networksConfigured: Array.from(this.networks.keys()),
  //     poolsListening: Array.from(this.poolContracts.entries()).map(
  //       ([network, contracts]) => ({
  //         network,
  //         poolCount: contracts.length,
  //         pools: contracts.map((c: ethers.Contract) => c.address),
  //       })
  //     ),
  //     currentArbitrages: this.currentArbitrages.size,
  //     sequentialExecution: true,
  //   };
  // }

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

  public async manualVolumeCheck(): Promise<void> {
    await this.volumeService.manualVolumeCheck();
  }

  public getVolumeStatus(): object {
    return this.volumeService.getVolumeStatus();
  }

  public async manualScan(): Promise<void> {
    console.log(`\n🔧 MANUAL ARBITRAGE SCAN TRIGGERED`);
    await this.scanAndExecute();
  }

  public async startEventListening(): Promise<void> {
    this.networkService.startEventListening(
      this.minProfitThreshold,
      this.seedTradeAmount,
      this.wethTradeAmount
    );
  }
}
