import { ethers } from "ethers";
import { QUOTER_ADDRESSES } from "@uniswap/sdk-core";
import { NETWORKS, TOKENS, SWAP_ROUTER_ADDRESSES } from "../config/config";
import { POOL_ABI, QUOTER_V2_ABI, SWAP_ROUTER_ABI } from "../contracts/abi";
import { NetworkConfig, SwapEventData } from "../types";
import { QueueService } from "./queue";
import { TradeService } from "./trades";
import { PoolService } from "./pool";
import { DiscordNotificationService } from "./notification";

export class NetworkService {
  private networks: Map<string, NetworkConfig> = new Map();
  private poolContracts: Map<string, ethers.Contract[]> = new Map();
  private poolService!: PoolService;

  constructor(
    private queueService: QueueService,
    private tradeService: TradeService,
    private scanAndExecute: () => Promise<void>,
    private privateKey?: string
  ) {
    this.initializeNetworks();
  }

  public getNetworks(): Map<string, NetworkConfig> {
    return this.networks;
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

  public async reconnectNetwork(
    networkKey: string,
    poolContracts: Map<string, ethers.Contract[]>,
    onEventCallback: (eventData: SwapEventData) => Promise<void> // needed for binding
  ): Promise<void> {
    try {
      const network = this.networks.get(networkKey);
      if (!network) return;

      const contracts = poolContracts.get(networkKey);
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

      console.log(`✅ Successfully reconnected ${network.name}`);
    } catch (error: any) {
      console.error(`❌ Failed to reconnect ${networkKey}: ${error.message}`);
    }
  }

  private async handleSwapEvent(eventData: SwapEventData): Promise<void> {
    // if (
    //   this.tradeService.isOurTransaction(eventData.txHash, eventData.sender)
    // ) {
    //   console.log(
    //     `⭐ Detected our own transaction: ${eventData.txHash} - skipping`
    //   );
    //   return;
    // }

    if (this.queueService.shouldSkipProcessing()) {
      return;
    }

    this.queueService.addToQueue(eventData);
  }

  public setupEventListenersForNetwork(
    networkKey: string,
    contracts: ethers.Contract[]
  ): void {
    const network = this.networks.get(networkKey);
    if (!network) return;

    // Store contracts for reconnection
    this.poolContracts.set(networkKey, contracts);

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

      // on error reconnect
      contract.provider.on("error", (error) => {
        console.error(
          `❌ Provider error for ${network.name}: ${error.message}`
        );

        setTimeout(() => {
          console.log(`🔄 Attempting to reconnect ${network.name}...`);
          this.reconnectNetwork(
            networkKey,
            this.poolContracts,
            this.handleSwapEvent.bind(this)
          );
        }, 5000);
      });
    });
  }

  // Add method to initialize pool service
  public initializePoolService(poolService: PoolService) {
    this.poolService = poolService;
    this.initializePoolContracts();
  }

  // Add method to initialize pool contracts
  private initializePoolContracts(): void {
    if (!this.poolService) {
      console.error("❌ Pool service not initialized");
      return;
    }

    const poolConfigs = this.poolService.getPoolConfigs();

    for (const [networkKey, network] of this.networks.entries()) {
      const networkPools = poolConfigs.get(networkKey) || [];

      const contracts = networkPools.map(
        (config) =>
          new ethers.Contract(config.address, POOL_ABI, network.provider)
      );

      this.poolContracts.set(networkKey, contracts);
      console.log(
        `📡 Initialized ${contracts.length} pool contracts for ${networkKey}`
      );
    }
  }

  // Add method to refresh pool contracts
  public async refreshPoolContracts(): Promise<void> {
    console.log("🔄 Refreshing pool contracts...");

    // Clear existing listeners
    for (const contracts of this.poolContracts.values()) {
      contracts.forEach((contract) => contract.removeAllListeners());
    }

    // Reinitialize contracts
    this.initializePoolContracts();

    // Reset listeners
    for (const [networkKey, contracts] of this.poolContracts.entries()) {
      this.setupEventListenersForNetwork(networkKey, contracts);
    }

    console.log("✅ Pool contracts refreshed");
  }

  public async startEventListening(
    minProfitThreshold: number,
    seedTradeAmount: string,
    wethTradeAmount: string,
    notificationService: DiscordNotificationService
  ): Promise<void> {
    console.log(`\n🎧 Starting event listeners for all networks`);
    console.log(`Minimum profit threshold: ${minProfitThreshold}%`);
    console.log(`Trade amounts are now calculated dynamically based on pool reserves`);

    // Initialize pool service if not already initialized
    if (!this.poolService) {
      console.error("❌ Pool service not initialized");
      return;
    }

    // Initialize pool contracts
    this.initializePoolContracts();

    // Setup event listeners for all networks
    for (const [networkKey, contracts] of this.poolContracts.entries()) {
      this.setupEventListenersForNetwork(networkKey, contracts);
    }

    // Set up periodic pool refresh (every 1 hour)
    setInterval(() => {
      this.refreshPoolContracts().catch((error) =>
        console.error("Failed to refresh pool contracts:", error)
      );
    }, 60 * 60 * 1000);

    // Perform initial scan
    console.log(`\n🔍 Performing initial arbitrage scan...`);
    await this.scanAndExecute();

    // Keep the process alive
    console.log(`\n✅ Event listeners active. Bot is running...`);
    console.log(`Press Ctrl+C to stop the bot`);

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      console.log(`\n\n🛑 Shutting down bot...`);
      await notificationService.sendShutdownNotification();
      this.cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.log(`\n\n🛑 Shutting down bot...`);
      await notificationService.sendShutdownNotification();

      this.cleanup();
      process.exit(0);
    });

    // Keep the process running
    return new Promise(() => { });
  }

  cleanup(): void {
    console.log(`🧹 Cleaning up event listeners...`);

    // Clean up pool contracts listeners
    for (const [networkKey, contracts] of this.poolContracts.entries()) {
      contracts.forEach((contract) => {
        contract.removeAllListeners();
        console.log(`📡 Removed listeners for pool ${contract.address}`);
      });
    }

    this.queueService.stopProcessing();
    console.log(`✅ Cleanup complete`);
  }

  public setServices(
    queueService: QueueService,
    tradeService: TradeService
  ): void {
    this.queueService = queueService;
    this.tradeService = tradeService;
  }
}
