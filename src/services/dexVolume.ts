import axios from "axios";
import { DexScreenerResponse } from "../types";

// Made a separate file cuz in future if we want to change from dex screener to something else or use another this is helpful

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
