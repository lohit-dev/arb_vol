import axios from "axios";
import { COINGECKO_CONFIG } from "../config/config";
import { PriceData } from "../types";

export class CoinGeckoService {
  private lastRequest: number = 0;
  private currentKeyIndex: number = 0;

  private async rotateApiKey(): Promise<string> {
    const currentKey = COINGECKO_CONFIG.apiKeys[this.currentKeyIndex];
    this.currentKeyIndex =
      (this.currentKeyIndex + 1) % COINGECKO_CONFIG.apiKeys.length;
    return currentKey;
  }

  public async fetchPrices(): Promise<{
    ethereum: PriceData;
    seed?: PriceData;
  }> {
    const now = Date.now();
    if (now - this.lastRequest < COINGECKO_CONFIG.rateLimit) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          COINGECKO_CONFIG.rateLimit - (now - this.lastRequest)
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

      this.lastRequest = Date.now();

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
}
