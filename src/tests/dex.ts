import axios from "axios";

interface DexScreenerResponse {
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

interface VolumeData {
  chainId: string;
  pairAddress: string;
  volume24h: number;
  baseToken: string;
  quoteToken: string;
  liquidity: number;
  priceUsd: string;
}

class ExternalAPIVolumeTracker {
  private readonly config = {
    tokens: {
      ethereum: {
        WETH: {
          address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
          decimals: 18,
          symbol: "WETH",
        },
        SEED: {
          address: "0x5eed99d066a8CaF10f3E4327c1b3D8b673485eED",
          decimals: 18,
          symbol: "SEED",
        },
      },
      arbitrum: {
        WETH: {
          address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
          decimals: 18,
          symbol: "WETH",
        },
        SEED: {
          address: "0x86f65121804D2Cdbef79F9f072D4e0c2eEbABC08",
          decimals: 18,
          symbol: "SEED",
        },
      },
    },
    pools: {
      ethereum: [
        {
          address: "0xd36ae827a9b62b8a32f0032cad1251b94fab1dd4",
          token0: "SEED",
          token1: "WETH",
        },
      ],
      arbitrum: [
        {
          address: "0xf9f588394ec5c3b05511368ce016de5fd3812446",
          token0: "WETH",
          token1: "SEED",
        },
      ],
    },
  };

  async getDexScreenerVolume(
    pairAddress: string,
    chainId: string = "ethereum"
  ): Promise<number> {
    try {
      const url = `https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairAddress}`;
      const response = await axios.get<DexScreenerResponse>(url, {
        timeout: 10000,
        headers: {
          "User-Agent": "ArbitrageBot/1.0",
        },
      });

      if (response.data.pairs && response.data.pairs.length > 0) {
        const pair = response.data.pairs[0];
        const volume24h = pair.volume?.h24 || 0;
        console.log(
          `📊 DEX Screener 24h volume: $${volume24h.toLocaleString()}`
        );
        console.log(
          ` Pair: ${pair.baseToken.symbol}/${pair.quoteToken.symbol}`
        );
        console.log(
          ` Liquidity: $${pair.liquidity?.usd?.toLocaleString() || 0}`
        );
        return volume24h;
      }
      return 0;
    } catch (error: any) {
      console.error(`❌ DEX Screener API error: ${error.message}`);
      return 0;
    }
  }

  async getSEEDWETHVolume(
    chainId: "ethereum" | "arbitrum"
  ): Promise<VolumeData | null> {
    try {
      const pools = this.config.pools[chainId];
      if (!pools || pools.length === 0) {
        console.error(`❌ No pools found for ${chainId}`);
        return null;
      }

      const pool = pools[0]; // Get the first (and only) SEED/WETH pool
      const pairAddress = pool.address;

      const url = `https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairAddress}`;
      const response = await axios.get<DexScreenerResponse>(url, {
        timeout: 10000,
        headers: {
          "User-Agent": "ArbitrageBot/1.0",
        },
      });

      if (response.data.pairs && response.data.pairs.length > 0) {
        const pair = response.data.pairs[0];
        const volume24h = pair.volume?.h24 || 0;

        const volumeData: VolumeData = {
          chainId,
          pairAddress,
          volume24h,
          baseToken: pair.baseToken.symbol,
          quoteToken: pair.quoteToken.symbol,
          liquidity: pair.liquidity?.usd || 0,
          priceUsd: pair.priceUsd,
        };

        console.log(`\n🔗 ${chainId.toUpperCase()} Network:`);
        console.log(`📊 SEED/WETH 24h Volume: $${volume24h.toLocaleString()}`);
        console.log(
          `💧 Liquidity: $${(pair.liquidity?.usd || 0).toLocaleString()}`
        );
        console.log(`💰 Price: $${pair.priceUsd}`);
        console.log(`📍 Pair Address: ${pairAddress}`);

        return volumeData;
      }
      return null;
    } catch (error: any) {
      console.error(
        `❌ Error fetching ${chainId} SEED/WETH volume: ${error.message}`
      );
      return null;
    }
  }

  async getAllSEEDWETHVolumes(): Promise<VolumeData[]> {
    console.log("🚀 Fetching SEED/WETH volumes across all networks...\n");

    const promises = (["ethereum", "arbitrum"] as const).map((chainId) =>
      this.getSEEDWETHVolume(chainId)
    );

    const results = await Promise.all(promises);
    const validResults = results.filter(
      (result): result is VolumeData => result !== null
    );

    if (validResults.length > 0) {
      const totalVolume = validResults.reduce(
        (sum, data) => sum + data.volume24h,
        0
      );
      console.log(
        `\n📈 Total 24h Volume Across All Networks: $${totalVolume.toLocaleString()}`
      );
    }

    return validResults;
  }

  async compareVolumes(): Promise<void> {
    const volumes = await this.getAllSEEDWETHVolumes();

    if (volumes.length > 1) {
      const [eth, arb] = volumes.sort((a, b) =>
        a.chainId.localeCompare(b.chainId)
      );
      const volumeDiff = Math.abs(eth.volume24h - arb.volume24h);
      const volumeRatio = eth.volume24h > 0 ? arb.volume24h / eth.volume24h : 0;

      console.log(`\n🔄 Volume Comparison:`);
      console.log(`   Ethereum: $${eth.volume24h.toLocaleString()}`);
      console.log(`   Arbitrum: $${arb.volume24h.toLocaleString()}`);
      console.log(`   Difference: $${volumeDiff.toLocaleString()}`);
      console.log(`   Ratio (ARB/ETH): ${volumeRatio.toFixed(3)}`);
    }
  }
}

async function main() {
  const tracker = new ExternalAPIVolumeTracker();

  await tracker.getAllSEEDWETHVolumes();
  await tracker.compareVolumes();

  // const ethVolume = await tracker.getSEEDWETHVolume("ethereum");
  // const arbVolume = await tracker.getSEEDWETHVolume("arbitrum");
}

main().catch(console.error);
