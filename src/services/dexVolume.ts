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

class ExternalAPIVolumeTracker {
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
          `   Pair: ${pair.baseToken.symbol}/${pair.quoteToken.symbol}`
        );
        console.log(
          `   Liquidity: $${pair.liquidity?.usd?.toLocaleString() || 0}`
        );

        return volume24h;
      }

      return 0;
    } catch (error: any) {
      console.error(`❌ DEX Screener API error: ${error.message}`);
      return 0;
    }
  }
}

export { ExternalAPIVolumeTracker };
