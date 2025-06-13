import { ethers } from "ethers";
import { NetworkConfig } from "../types";
import { PoolService } from "./pool";

export class QuoteService {
  private seedTradeAmount: string = "1000000000000000000"; // 1 SEED token
  private wethTradeAmount: string = "1000000000000000000"; // 1 WETH token

  constructor(
    private networks: Map<string, NetworkConfig>,
    private poolService: PoolService
  ) {}

  public async getQuote(networkKey: string): Promise<{
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

  public setTradeAmounts(seedAmount: string, wethAmount: string): void {
    this.seedTradeAmount = seedAmount;
    this.wethTradeAmount = wethAmount;
  }
}
