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
import { DiscordNotificationService } from "./notification";
import { DiSCORD_WEBHOOK_URL } from "../config/config";
import { QuoteService } from "./quote";

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

  private minPriceDeviationThreshold: number = 0.1;
  private minProfitThreshold: number = 1; // 1% minimum profit
  private seedTradeAmount: string = "1000000000000000000"; // 1 SEED token
  private wethTradeAmount: string = "1000000000000000000"; // 1 WETH token

  // Sequential processing state
  private currentArbitrages: Map<string, PendingArbitrage> = new Map();

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
      this.quoteService
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

  private async calculateArbitrageOpportunity(
    ethQuote: any,
    arbQuote: any,
    prices: any
  ): Promise<ArbitrageOpportunity | null> {
    if (!ethQuote || !arbQuote || !prices.ethereum) {
      return null;
    }

    const ethSeedUsdPrice = ethQuote.seedToWethRate * prices.ethereum.usd;
    const arbSeedUsdPrice = arbQuote.seedToWethRate * prices.ethereum.usd;

    console.log(`Quote value: `, ethQuote.seedToWethRate);
    console.log(`ethereum price: ${prices.ethereum.usd}`);

    const priceDifference = Math.abs(ethSeedUsdPrice - arbSeedUsdPrice);
    const averagePrice = (ethSeedUsdPrice + arbSeedUsdPrice) / 2;
    const priceDeviationPercentage = (priceDifference / averagePrice) * 100;

    let buyNetwork, sellNetwork, buyPrice, sellPrice;
    if (ethSeedUsdPrice < arbSeedUsdPrice) {
      buyNetwork = "ethereum";
      sellNetwork = "arbitrum";
      buyPrice = ethSeedUsdPrice;
      sellPrice = arbSeedUsdPrice;
    } else {
      buyNetwork = "arbitrum";
      sellNetwork = "ethereum";
      buyPrice = arbSeedUsdPrice;
      sellPrice = ethSeedUsdPrice;
    }

    return {
      buyNetwork,
      sellNetwork,
      buyPrice,
      sellPrice,
      profitPercentage: priceDeviationPercentage, // Now represents price deviation
      estimatedProfit: priceDifference, // Now represents absolute price difference
      gasEstimate: 150000 + 80000, // Estimated gas for both trades,
      tradeAmount: averagePrice,
    };
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
    this.quoteService.setTradeAmounts(seedAmount, wethAmount);
  }

  async scanAndExecute(): Promise<void> {
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
          await this.tradeService.executeEquilibriumTrade(opportunity);
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

  public setMinPriceDeviationThreshold(deviation: number) {
    this.minPriceDeviationThreshold = deviation;
  }

  public async manualScan(): Promise<void> {
    console.log(`\n🔧 MANUAL ARBITRAGE SCAN TRIGGERED`);
    await this.scanAndExecute();
  }

  public async startEventListening(): Promise<void> {
    this.networkService.startEventListening(
      this.minProfitThreshold,
      this.seedTradeAmount,
      this.wethTradeAmount,
      this.notificationService
    );
  }

  public getWalletAddress(): string {
    const network = this.networks.get("ethereum");
    return network?.wallet?.address || "No wallet configured";
  }
}
