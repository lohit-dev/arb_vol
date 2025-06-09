import { ethers } from "ethers";
import { VOLUME_CONFIG } from "../config/config";
import { ExternalAPIVolumeTracker } from "./dexVolume";
import { POOL_ABI } from "../contracts/abi";
import { NetworkConfig, TradeParams } from "../types";

export class VolumeService {
  private externalVolumeTracker: ExternalAPIVolumeTracker =
    new ExternalAPIVolumeTracker();
  private networkVolumes: Map<string, number> = new Map();
  private lastVolumeReset: number = Date.now();
  private lastVolumeCheck: Map<string, number> = new Map();
  private rebalanceInProgress: Map<string, boolean> = new Map();

  constructor(
    private networks: Map<string, NetworkConfig>,
    private poolConfigs: Map<string, any[]>,
    private executeTrade: (
      params: TradeParams
    ) => Promise<{ success: boolean; txHash?: string; error?: string }>,
    private fetchCoinGeckoPrices: () => Promise<any>,
    private getPoolInfo: (
      address: string,
      network: NetworkConfig
    ) => Promise<any>
  ) {
    this.initializeVolumeTracking();
    this.startVolumeRebalancer();
  }

  private initializeVolumeTracking(): void {
    for (const networkKey of this.networks.keys()) {
      this.networkVolumes.set(networkKey, 0);
      this.lastVolumeCheck.set(networkKey, Date.now());
      this.rebalanceInProgress.set(networkKey, false);
    }
    console.log(`📊 Volume tracking initialized for all networks`);
  }

  private async fetchNetworkVolume(networkKey: string): Promise<number> {
    try {
      const poolConfigs = this.poolConfigs.get(networkKey);
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

      // Fallback to on-chain calculation, hope this never happens 🙏
      const network = this.networks.get(networkKey);
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
      const prices = await this.fetchCoinGeckoPrices();
      if (!prices?.ethereum?.usd) {
        throw new Error("Failed to fetch ETH price");
      }

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

        await this.executeRebalanceTrades(networkKey, volumeDeficit);
      }
    } catch (error: any) {
      console.error(
        `❌ Volume rebalance check failed for ${networkKey}: ${error.message}`
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Generate a randomized trade amount based on the volume deficit and current ETH price
   * @param volumeDeficit - The remaining volume needed in USD
   * @param ethPrice - Current ETH price in USD
   * @param attemptNumber - Current attempt number (for decreasing trade size)
   * @param minMultiplier - Minimum multiplier (default: 0.5 = 50% of base)
   * @param maxMultiplier - Maximum multiplier (default: 0.8 = 80% of base)
   * @returns Randomized amount in wei as string
   */
  private generateRandomTradeAmount(
    volumeDeficit: number,
    ethPrice: number,
    attemptNumber: number,
    minMultiplier: number = 0.5,
    maxMultiplier: number = 0.8
  ): string {
    // Calculate base amount in ETH (not USD)
    const baseAmountEth = volumeDeficit / ethPrice;

    // Generate random multiplier between min and max (capped at 80% of deficit)
    const randomMultiplier =
      Math.random() * (maxMultiplier - minMultiplier) + minMultiplier;

    // Apply attempt-based scaling (reduce size with each attempt)
    const attemptScale = 1 / Math.sqrt(attemptNumber + 1);

    // Calculate randomized amount in ETH
    let randomizedAmountEth = baseAmountEth * randomMultiplier * attemptScale;

    // Ensure minimum trade size of $150
    const minTradeUsd = 150;
    const minTradeEth = minTradeUsd / ethPrice;

    // Ensure maximum trade size doesn't exceed 80% of volume deficit
    const maxTradeEth = (volumeDeficit * 0.8) / ethPrice;

    // Apply bounds
    randomizedAmountEth = Math.max(randomizedAmountEth, minTradeEth);
    randomizedAmountEth = Math.min(randomizedAmountEth, maxTradeEth);

    // Convert to wei (18 decimals)
    return ethers.utils
      .parseUnits(randomizedAmountEth.toFixed(18), 18)
      .toString();
  }

  private async executeRebalanceTrades(
    networkKey: string,
    volumeDeficit: number
  ): Promise<void> {
    this.rebalanceInProgress.set(networkKey, true);

    try {
      console.log(`🔄 Starting volume rebalancing for ${networkKey}`);

      const network = this.networks.get(networkKey);
      const poolConfigs = this.poolConfigs.get(networkKey);

      if (!network || !poolConfigs || !network.wallet) {
        throw new Error("Missing network configuration");
      }

      const poolInfo = await this.getPoolInfo(poolConfigs[0].address, network);
      if (!poolInfo.isValid) {
        throw new Error("Invalid pool info");
      }

      const prices = await this.fetchCoinGeckoPrices();
      if (!prices?.ethereum?.usd) {
        throw new Error("Failed to fetch prices");
      }

      const ethPrice = prices.ethereum.usd;
      const maxAttempts = Math.min(VOLUME_CONFIG.maxRebalanceAttempts, 10);
      let attempts = 0;
      let volumeGenerated = 0;
      let remainingDeficit = volumeDeficit;

      while (remainingDeficit > 0 && attempts < maxAttempts) {
        const isWethToSeed = attempts % 2 === 0;

        try {
          const minMultiplier = 0.5;
          const maxMultiplier = 2.0;

          const randomizedAmount = this.generateRandomTradeAmount(
            remainingDeficit,
            ethPrice,
            attempts,
            minMultiplier,
            maxMultiplier
          );

          console.log(
            `🎲 Random trade amount for attempt ${
              attempts + 1
            }: ${ethers.utils.formatUnits(randomizedAmount, 18)} ETH`
          );

          const tradeParams: TradeParams = {
            tokenIn: isWethToSeed
              ? network.tokens.WETH.address
              : network.tokens.SEED.address,
            tokenOut: isWethToSeed
              ? network.tokens.SEED.address
              : network.tokens.WETH.address,
            fee: poolInfo.actualFee!,
            amountIn: randomizedAmount,
            network: networkKey,
            minAmountOut: "0",
          };

          const result = await this.executeTrade(tradeParams);

          if (result.success) {
            const tradeValue = parseFloat(
              ethers.utils.formatUnits(randomizedAmount, 18)
            );
            const usdValue = tradeValue * ethPrice;

            volumeGenerated += usdValue;
            remainingDeficit = volumeDeficit - volumeGenerated;
            console.log(
              `✅ Rebalance trade ${attempts + 1}: ${tradeValue.toFixed(
                6
              )} ETH (~$${usdValue.toFixed(2)}) volume`
            );
          }
          const delayMs = 800 + Math.random() * 300; // Random delay between 800-11000ms
          console.log(
            `⏱️ Waiting ${delayMs.toFixed(0)}ms before next trade...`
          );
          await this.sleep(delayMs);
        } catch (error: any) {
          console.error(
            `Trade attempt ${attempts + 1} failed: ${error.message}`
          );
          await this.sleep(1000);
        }

        attempts++;
      }

      // Update stored volume
      const currentStored = this.networkVolumes.get(networkKey) || 0;
      this.networkVolumes.set(networkKey, currentStored + volumeGenerated);

      console.log(
        `🎯 Volume rebalancing complete for ${networkKey}: +$${volumeGenerated.toFixed(
          2
        )} across ${attempts} randomized trades (${remainingDeficit.toFixed(
          2
        )} remaining)`
      );
    } catch (error: any) {
      console.error(
        `❌ Rebalance execution failed for ${networkKey}: ${error.message}`
      );
    } finally {
      this.rebalanceInProgress.set(networkKey, false);
    }
  }

  private startVolumeRebalancer(): void {
    console.log(`📊 Starting volume rebalancer...`);

    // Check volumes periodically
    setInterval(async () => {
      for (const networkKey of this.networks.keys()) {
        if (this.shouldSkipVolumeProcessing(networkKey)) continue;

        const lastCheck = this.lastVolumeCheck.get(networkKey) || 0;
        if (Date.now() - lastCheck > VOLUME_CONFIG.checkInterval) {
          this.lastVolumeCheck.set(networkKey, Date.now());
          await this.checkAndRebalanceVolume(networkKey);
        }
      }
    }, VOLUME_CONFIG.checkInterval);

    setInterval(() => {
      const jitter = Math.random() * 5 * 60 * 1000; // 5 min
      setTimeout(() => {
        console.log(`🔄 Resetting daily volume counters`);
        for (const networkKey of this.networks.keys()) {
          this.networkVolumes.set(networkKey, 0);
        }
        this.lastVolumeReset = Date.now();
      }, jitter);
    }, VOLUME_CONFIG.volumeResetInterval);
  }

  public async manualVolumeCheck(): Promise<void> {
    console.log(`\n🔧 MANUAL VOLUME CHECK TRIGGERED`);
    for (const networkKey of this.networks.keys()) {
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
