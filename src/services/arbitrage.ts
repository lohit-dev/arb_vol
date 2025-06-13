import { ethers } from "ethers";
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
import { DiscordNotificationService } from "./notification";
import { DiSCORD_WEBHOOK_URL } from "../config/config";
import { QuoteService } from "./quote";
import { ERC20_ABI } from "../contracts/abi";
import { calculateOptimalTradeAmount } from "../utils";

export class ArbitrageService {
  private networks: Map<string, NetworkConfig> = new Map();
  private poolService: PoolService;
  private volumeService: VolumeService;
  private tradeService: TradeService;
  private coinGeckoService: CoinGeckoService;
  private networkService: NetworkService;
  private queueService: QueueService;
  private quoteService: QuoteService;
  private readonly notificationService: DiscordNotificationService;

  private maxPriceDeviationThreshold: number = 0.2; // Stop trading when prices are within 0.2%
  private minProfitThreshold: number = 0.1; // 0.1% minimum profit

  // Sequential processing state
  private currentArbitrages: Map<string, PendingArbitrage> = new Map();
  private consecutiveErrors: number = 0;
  private lastErrorTime: number = 0;
  private isProcessing: boolean = false;

  constructor(private privateKey?: string) {
    privateKey = process.env.PRIVATE_KEY || privateKey;
    this.notificationService = new DiscordNotificationService(
      DiSCORD_WEBHOOK_URL
    );

    // First, initialize NetworkService as it sets up the networks
    this.networkService = new NetworkService(
      // @ts-ignore
      null, // We'll set this after QueueService is created
      null, // We'll set this after TradeService is created
      this.scanAndExecute.bind(this),
      privateKey
    );

    // Get the initialized networks
    this.networks = this.networkService.getNetworks();

    // Initialize pool service first as it's needed by QuoteService
    this.poolService = new PoolService(this.networks);

    // Initialize QuoteService
    this.quoteService = new QuoteService(this.networks, this.poolService);

    // Now initialize other services with the networks
    this.tradeService = new TradeService(
      this.networks,
      this.notificationService,
      this.quoteService,
      this.poolService
    );
    this.queueService = new QueueService(this.scanAndExecute.bind(this));
    this.coinGeckoService = new CoinGeckoService();

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

  public setProcessingCooldown(milliseconds: number): void {
    this.queueService.setProcessingCooldown(milliseconds);
  }

  public setMinProfitThreshold(percentage: number): void {
    this.minProfitThreshold = percentage;
    console.log(`📊 Minimum profit threshold set to ${percentage}%`);
  }

  public setMaxPriceDeviationThreshold(percentage: number): void {
    this.maxPriceDeviationThreshold = percentage;
    console.log(`📊 Maximum price deviation threshold set to ${percentage}%`);
  }

  async scanAndExecute(): Promise<void> {
    if (this.isProcessing) {
      console.log("⏸️ Already processing, skipping...");
      return;
    }

    this.isProcessing = true;
    console.log(`\n🔍 SCANNING FOR ARBITRAGE OPPORTUNITIES`);
    console.log("=".repeat(60));

    try {
      // Fetch real-time prices
      const prices = await this.fetchCoinGeckoPrices();

      // Get quotes from both networks
      const [ethQuote, arbQuote] = await Promise.all([
        this.quoteService.getQuote("ethereum"),
        this.quoteService.getQuote("arbitrum"),
      ]);

      if (!ethQuote || !arbQuote) {
        console.log("❌ Failed to get quotes from both networks");
        return;
      }

      // Calculate arbitrage opportunity
      const opportunity = await this.calculateArbitrageOpportunityWithOptimalAmount(
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
        `Buy on: ${opportunity.buyNetwork} at ${opportunity.buyPrice.toFixed(6)}`
      );
      console.log(
        `Sell on: ${opportunity.sellNetwork} at ${opportunity.sellPrice.toFixed(6)}`
      );
      console.log(
        `Profit: ${opportunity.profitPercentage.toFixed(2)}% (${opportunity.estimatedProfit.toFixed(6)})`
      );

      // First check: If price deviation is too small, stop immediately
      if (opportunity.profitPercentage <= this.maxPriceDeviationThreshold) {
        console.log(
          `\n⚖️ Prices are balanced (deviation: ${opportunity.profitPercentage.toFixed(2)}% <= ${this.maxPriceDeviationThreshold}%)`
        );
        console.log(`💤 Skipping arbitrage to maintain balance`);
        return;
      }

      // Second check: Only if deviation is high enough, check minimum profit
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
          `\n💤 Profit ${opportunity.profitPercentage.toFixed(2)}% below threshold ${this.minProfitThreshold}%`
        );
      }
    } catch (error: any) {
      console.error(`❌ Scan failed: ${error.message}`);
    } finally {
      this.isProcessing = false;
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
      "0", '0',
      this.notificationService
    );
  }

  public getWalletAddress(): string {
    const network = this.networks.get("ethereum");
    return network?.wallet?.address || "No wallet configured";
  }

  private async calculateArbitrageOpportunityWithOptimalAmount(
    ethQuote: any,
    arbQuote: any,
    prices: any
  ): Promise<ArbitrageOpportunity | null> {
    if (!ethQuote || !arbQuote || !prices.ethereum) {
      return null;
    }

    // Get pool reserves for both networks
    const ethPoolConfigs = this.poolService.getPoolConfigs().get("ethereum");
    const arbPoolConfigs = this.poolService.getPoolConfigs().get("arbitrum");

    if (!ethPoolConfigs?.[0] || !arbPoolConfigs?.[0]) {
      return null;
    }

    const ethNetwork = this.networks.get("ethereum");
    const arbNetwork = this.networks.get("arbitrum");

    if (!ethNetwork || !arbNetwork) {
      return null;
    }

    // Get pool info and reserves
    const [ethPoolInfo, arbPoolInfo] = await Promise.all([
      this.poolService.getPoolInfo(ethPoolConfigs[0].address, ethNetwork),
      this.poolService.getPoolInfo(arbPoolConfigs[0].address, arbNetwork),
    ]);

    if (
      !ethPoolInfo.isValid ||
      !arbPoolInfo.isValid ||
      !ethPoolInfo.reserves ||
      !arbPoolInfo.reserves
    ) {
      return null;
    }

    const optimalAmount = calculateOptimalTradeAmount(
      ethPoolInfo.reserves,
      arbPoolInfo.reserves
    );

    console.log("Optimal amount:", optimalAmount.toString());
    console.log("Optimal amount in 18 decimals:", ethers.utils.formatUnits(optimalAmount, 18));

    const ethSeedUsdPrice = ethQuote.seedToWethRate * prices.ethereum.usd;
    const arbSeedUsdPrice = arbQuote.seedToWethRate * prices.ethereum.usd;

    console.log('\n🔍 PRICE CALCULATION DETAILS:');
    console.log('Ethereum Quote:', {
      seedToWethRate: ethQuote.seedToWethRate,
      ethUsdPrice: prices.ethereum.usd,
      calculatedSeedUsdPrice: ethSeedUsdPrice
    });
    console.log('Arbitrum Quote:', {
      seedToWethRate: arbQuote.seedToWethRate,
      ethUsdPrice: prices.ethereum.usd,
      calculatedSeedUsdPrice: arbSeedUsdPrice
    });

    const priceDifference = Math.abs(ethSeedUsdPrice - arbSeedUsdPrice);
    const averagePrice = (ethSeedUsdPrice + arbSeedUsdPrice) / 2;
    const priceDeviationPercentage = (priceDifference / averagePrice) * 100;

    console.log('\n📊 PRICE COMPARISON:');
    console.log(`Price Difference: ${priceDifference}`);
    console.log(`Average Price: ${averagePrice}`);
    console.log(`Deviation Percentage: ${priceDeviationPercentage.toFixed(2)}%`);

    let buyNetwork, sellNetwork, buyPrice, sellPrice;
    if (ethSeedUsdPrice < arbSeedUsdPrice) {
      // Ethereum is cheaper: buy on Ethereum, sell on Arbitrum
      buyNetwork = "ethereum";
      sellNetwork = "arbitrum";
      buyPrice = ethSeedUsdPrice;
      sellPrice = arbSeedUsdPrice;
      console.log("Arbitrage: Buy on Ethereum (a), Sell on Arbitrum (b)");
    } else {
      // Arbitrum is cheaper: buy on Arbitrum, sell on Ethereum
      buyNetwork = "arbitrum";
      sellNetwork = "ethereum";
      buyPrice = arbSeedUsdPrice;
      sellPrice = ethSeedUsdPrice;
      console.log("Arbitrage: Buy on Arbitrum (a), Sell on Ethereum (b)");
    }

    // Calculate actual profit percentage based on buy/sell prices
    const profitPercentage = ((sellPrice - buyPrice) / buyPrice) * 100;

    return {
      buyNetwork,
      sellNetwork,
      buyPrice,
      sellPrice,
      profitPercentage,
      estimatedProfit: priceDifference,
      gasEstimate: 150000 + 80000,
      tradeAmount: parseFloat(ethers.utils.formatUnits(optimalAmount, 18)),
      ethFee: ethPoolInfo.actualFee,
      arbFee: arbPoolInfo.actualFee,
    };
  }

  private async executeArbitrage(
    opportunity: ArbitrageOpportunity
  ): Promise<boolean> {
    const arbitrageId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const pendingArbitrage: PendingArbitrage = {
      id: arbitrageId,
      buyNetwork: opportunity.buyNetwork,
      sellNetwork: opportunity.sellNetwork,
      buyTxHash: "",
      sellTxHash: "",
      status: "pending",
      timestamp: Date.now(),
    };

    this.currentArbitrages.set(arbitrageId, pendingArbitrage);

    try {
      console.log(`\n⚖️ EXECUTING ARBITRAGE ${arbitrageId}`);
      console.log(
        `Buy ${opportunity.buyNetwork} → Sell ${opportunity.sellNetwork}`
      );
      console.log(`Price Deviation: ${opportunity.profitPercentage.toFixed(2)}%`);

      const buyNetworkKey = opportunity.buyNetwork.toLowerCase();
      const sellNetworkKey = opportunity.sellNetwork.toLowerCase();

      const buyNetwork = this.networks.get(buyNetworkKey);
      const sellNetwork = this.networks.get(sellNetworkKey);

      if (!buyNetwork || !sellNetwork) {
        throw new Error("Network configuration not found");
      }

      // Get pool info for buy side
      const buyPoolConfigs = this.poolService.getPoolConfigs().get(buyNetworkKey);
      if (!buyPoolConfigs?.[0]) {
        throw new Error("Buy pool configuration not found");
      }

      const buyPoolInfo = await this.poolService.getPoolInfo(
        buyPoolConfigs[0].address,
        buyNetwork
      );
      if (!buyPoolInfo.isValid) {
        throw new Error(`Invalid buy pool`);
      }

      // Execute buy trade with calculated amount
      const buyParams: TradeParams = {
        tokenIn: buyNetwork.tokens.WETH.address,
        tokenOut: buyNetwork.tokens.SEED.address,
        fee: buyPoolInfo.actualFee!,
        amountIn: ethers.utils.parseUnits(opportunity.tradeAmount.toString(), 18).toString(),
        network: opportunity.buyNetwork,
        minAmountOut: "0", // We'll handle slippage on the sell side
      };

      // Check WETH balance before trade
      const wethContract = new ethers.Contract(
        buyNetwork.tokens.WETH.address,
        ERC20_ABI,
        buyNetwork.provider
      );
      const wethBalance = await wethContract.balanceOf(buyNetwork.wallet!.address);
      console.log(`WETH Balance before trade: ${ethers.utils.formatUnits(wethBalance, 18)} WETH`);
      console.log(`Required WETH amount: ${opportunity.tradeAmount} WETH`);

      // Add buffer for gas costs
      const gasBuffer = ethers.utils.parseUnits("0.01", 18); // 0.01 ETH buffer for gas
      if (wethBalance.lt(ethers.utils.parseUnits(opportunity.tradeAmount.toString(), 18).add(gasBuffer))) {
        throw new Error(`Insufficient WETH balance. Have: ${ethers.utils.formatUnits(wethBalance, 18)}, Need: ${opportunity.tradeAmount} + gas buffer`);
      }

      // Get initial SEED balance before buy trade
      const seedContract = new ethers.Contract(
        buyNetwork.tokens.SEED.address,
        ERC20_ABI,
        buyNetwork.provider
      );
      const initialSeedBalance = await seedContract.balanceOf(buyNetwork.wallet!.address);
      console.log(`Initial SEED balance: ${ethers.utils.formatUnits(initialSeedBalance, 18)}`);

      // Execute buy trade
      console.log(`\n1️⃣ Executing buy trade on ${buyNetworkKey}...`);
      const buyResult = await this.tradeService.executeTrade(buyParams);
      if (!buyResult.success) {
        throw new Error(`Buy trade failed: ${buyResult.error}`);
      }

      pendingArbitrage.buyTxHash = buyResult.txHash || "";
      pendingArbitrage.status = "executing";

      // Wait for the transaction to settle
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Get the new SEED balance after buy trade
      const finalSeedBalance = await seedContract.balanceOf(buyNetwork.wallet!.address);
      const receivedSeedAmount = finalSeedBalance.sub(initialSeedBalance);
      console.log(`Final SEED balance: ${ethers.utils.formatUnits(finalSeedBalance, 18)}`);
      console.log(`Received from buy trade: ${ethers.utils.formatUnits(receivedSeedAmount, 18)} SEED`);

      if (receivedSeedAmount.eq(0)) {
        throw new Error(`No SEED received from buy trade`);
      }

      // Get pool info for sell side
      const sellPoolConfigs = this.poolService.getPoolConfigs().get(sellNetworkKey);
      if (!sellPoolConfigs?.[0]) {
        throw new Error("Sell pool configuration not found");
      }

      const sellPoolInfo = await this.poolService.getPoolInfo(
        sellPoolConfigs[0].address,
        sellNetwork
      );
      if (!sellPoolInfo.isValid) {
        throw new Error(`Invalid sell pool`);
      }

      // Execute sell trade with EXACT amount received from buy
      const sellParams: TradeParams = {
        tokenIn: sellNetwork.tokens.SEED.address,
        tokenOut: sellNetwork.tokens.WETH.address,
        fee: sellPoolInfo.actualFee!,
        amountIn: receivedSeedAmount.toString(), // Sell exactly what we received
        network: opportunity.sellNetwork,
        minAmountOut: "0", // Accept any amount for now
      };

      console.log(`\n2️⃣ Executing sell trade on ${sellNetworkKey}...`);
      console.log(`Selling exactly ${ethers.utils.formatUnits(receivedSeedAmount, 18)} SEED received from buy`);
      const sellResult = await this.tradeService.executeTrade(sellParams);
      if (!sellResult.success) {
        console.error(`Sell trade failed with error: ${sellResult.error}`);
        console.error(`Transaction details:`, sellParams);
        throw new Error(`Sell trade failed: ${sellResult.error}`);
      }

      pendingArbitrage.sellTxHash = sellResult.txHash || "";
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
      }, 300000); // 5 minutes
    }
  }
}

