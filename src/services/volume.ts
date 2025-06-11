import { ethers } from "ethers";
import { VOLUME_CONFIG } from "../config/config";
import { ExternalAPIVolumeTracker } from "./dexVolume";
import { CoinGeckoService } from "./coingecko";
import { NetworkService } from "./network";
import { TradeService } from "./trades";
import { PoolService } from "./pool";
import { POOL_ABI } from "../contracts/abi";

export class VolumeService {
  private externalVolumeTracker: ExternalAPIVolumeTracker =
    new ExternalAPIVolumeTracker();
  private networkVolumes: Map<string, number> = new Map();
  private lastVolumeReset: number = Date.now();
  private lastVolumeCheck: Map<string, number> = new Map();
  private rebalanceInProgress: Map<string, boolean> = new Map();

  constructor(
    private networkService: NetworkService,
    private poolService: PoolService,
    private tradeService: TradeService,
    private coinGeckoService: CoinGeckoService
  ) {
    this.initializeVolumeTracking();
    this.startVolumeRebalancer();
  }

  private initializeVolumeTracking(): void {
    const networks = this.networkService.getNetworks();
    for (const networkKey of networks.keys()) {
      this.networkVolumes.set(networkKey, 0);
      this.lastVolumeCheck.set(networkKey, Date.now());
      this.rebalanceInProgress.set(networkKey, false);
    }
    console.log(`📊 Volume tracking initialized for all networks`);
  }

  private async fetchNetworkVolume(networkKey: string): Promise<number> {
    try {
      const poolConfigs = this.poolService.getPoolConfigs().get(networkKey);
      if (!poolConfigs) return 0;

      const poolAddress = poolConfigs[0].address;
      const chainId = networkKey === "ethereum" ? "ethereum" : "arbitrum";

      let externalVolume = 0;
      try {
        externalVolume = await this.externalVolumeTracker.getDexScreenerVolume(
          poolAddress,
          chainId
        );
      } catch (error: any) {
        console.warn(
          `DEX Screener API error, falling back to on-chain: ${error.message}`
        );
      }

      if (externalVolume > 0) {
        console.log(
          `📊 Using DEX Screener volume for ${networkKey}: $${externalVolume.toLocaleString()}`
        );
        return externalVolume;
      }

      // Fallback to on-chain calculation
      const networks = this.networkService.getNetworks();
      const network = networks.get(networkKey);
      if (!network) return 0;

      const poolContract = new ethers.Contract(
        poolAddress,
        POOL_ABI,
        network.provider
      );

      const currentBlock = await network.provider.getBlockNumber();
      const fromBlock = Math.max(currentBlock - 100, 0);

      const events = await poolContract.queryFilter(
        poolContract.filters.Swap(),
        fromBlock,
        currentBlock
      );

      let volume = 0;
      const prices = await this.coinGeckoService.fetchPrices();

      for (const event of events) {
        if (!event.args) continue;

        const amount0 = Math.abs(
          parseFloat(ethers.utils.formatUnits(event.args.amount0, 18))
        );
        const amount1 = Math.abs(
          parseFloat(ethers.utils.formatUnits(event.args.amount1, 18))
        );

        const largerAmount = Math.max(amount0, amount1);
        volume += largerAmount * prices.ethereum.usd;
      }

      return volume;
    } catch (error: any) {
      console.error(
        `❌ Failed to fetch volume for ${networkKey}: ${error.message}`
      );
      return 0;
    }
  }

  private async checkAndRebalanceVolume(networkKey: string): Promise<void> {
    if (this.rebalanceInProgress.get(networkKey)) {
      return;
    }

    this.rebalanceInProgress.set(networkKey, true);

    try {
      const currentVolume = await this.fetchNetworkVolume(networkKey);
      const storedVolume = this.networkVolumes.get(networkKey) || 0;
      const totalVolume = storedVolume + currentVolume;

      console.log(
        `📊 ${networkKey} volume: $${totalVolume.toFixed(2)} / $${
          VOLUME_CONFIG.targetVolume
        }`
      );

      if (totalVolume < VOLUME_CONFIG.targetVolume) {
        const volumeDeficit = VOLUME_CONFIG.targetVolume - totalVolume;
        console.log(
          `⚖️ Volume deficit on ${networkKey}: $${volumeDeficit.toFixed(2)}`
        );

        const prices = await this.coinGeckoService.fetchPrices();
        if (!prices?.ethereum?.usd) {
          throw new Error("Failed to fetch prices");
        }

        const result = await this.tradeService.executeRebalanceTrades(
          networkKey,
          volumeDeficit,
          prices.ethereum.usd
        );

        if (result.success) {
          const currentStored = this.networkVolumes.get(networkKey) || 0;
          this.networkVolumes.set(
            networkKey,
            currentStored + result.volumeGenerated
          );
        }
      }
    } catch (error: any) {
      console.error(
        `❌ Volume rebalance check failed for ${networkKey}: ${error.message}`
      );
    } finally {
      this.rebalanceInProgress.set(networkKey, false);
    }
  }

  private startVolumeRebalancer(): void {
    console.log(`📊 Starting volume rebalancer...`);

    // Check volumes periodically
    setInterval(async () => {
      const networks = this.networkService.getNetworks();
      for (const networkKey of networks.keys()) {
        if (this.shouldSkipVolumeProcessing(networkKey)) continue;

        const lastCheck = this.lastVolumeCheck.get(networkKey) || 0;
        if (Date.now() - lastCheck > VOLUME_CONFIG.checkInterval) {
          this.lastVolumeCheck.set(networkKey, Date.now());
          await this.checkAndRebalanceVolume(networkKey);
        }
      }
    }, VOLUME_CONFIG.checkInterval);

    // Reset volumes daily with jitter
    setInterval(() => {
      const jitter = Math.random() * 5 * 60 * 1000; // 5 min random jitter
      setTimeout(() => {
        console.log(`🔄 Resetting daily volume counters`);
        const networks = this.networkService.getNetworks();
        for (const networkKey of networks.keys()) {
          this.networkVolumes.set(networkKey, 0);
        }
        this.lastVolumeReset = Date.now();
      }, jitter);
    }, VOLUME_CONFIG.volumeResetInterval);
  }

  public async manualVolumeCheck(): Promise<void> {
    console.log(`\n🔧 MANUAL VOLUME CHECK TRIGGERED`);
    const networks = this.networkService.getNetworks();
    for (const networkKey of networks.keys()) {
      await this.checkAndRebalanceVolume(networkKey);
    }
  }

  public getVolumeStatus(): object {
    return {
      targetVolume: VOLUME_CONFIG.targetVolume,
      networkVolumes: Array.from(this.networkVolumes.entries()),
      rebalanceInProgress: Array.from(this.rebalanceInProgress.entries()),
      lastVolumeReset: this.lastVolumeReset,
    };
  }

  public shouldSkipVolumeProcessing(networkKey: string): boolean {
    return this.rebalanceInProgress.get(networkKey) || false;
  }
}
