import { ethers } from "ethers";
import { POOL_CONFIGS } from "../config/config";
import { POOL_ABI } from "../contracts/abi";
import { NetworkConfig } from "../types";

export interface PoolConfig {
  address: string;
}

export class PoolService {
  private poolConfigs: Map<string, PoolConfig[]> = new Map();
  private poolContracts: Map<string, ethers.Contract[]> = new Map();

  constructor(private networks: Map<string, NetworkConfig>) {
    this.initializePoolConfigs();
    this.initializePoolContracts();
  }

  public getPoolConfigs(): Map<string, PoolConfig[]> {
    return this.poolConfigs;
  }

  public getPoolContracts(): Map<string, ethers.Contract[]> {
    return this.poolContracts;
  }

  private initializePoolConfigs(): void {
    this.poolConfigs.set("ethereum", POOL_CONFIGS.ethereum);
    this.poolConfigs.set("arbitrum", POOL_CONFIGS.arbitrum);
  }

  private initializePoolContracts(): void {
    for (const [networkKey, network] of this.networks.entries()) {
      const poolConfigs = this.poolConfigs.get(networkKey);
      if (!poolConfigs) continue;

      const contracts = poolConfigs.map(
        (config) =>
          new ethers.Contract(config.address, POOL_ABI, network.provider)
      );

      this.poolContracts.set(networkKey, contracts);
    }
  }

  public async getPoolInfo(
    poolAddress: string,
    network: NetworkConfig
  ): Promise<{
    isValid: boolean;
    actualFee?: number;
    token0?: string;
    token1?: string;
    token0IsSeed?: boolean;
  }> {
    try {
      const poolContract = new ethers.Contract(
        poolAddress,
        POOL_ABI,
        network.provider
      );
      const [token0, token1, fee, liquidity] = await Promise.all([
        poolContract.token0(),
        poolContract.token1(),
        poolContract.fee(),
        poolContract.liquidity(),
      ]);

      const token0Lower = token0.toLowerCase();
      const token1Lower = token1.toLowerCase();
      const seedLower = network.tokens.SEED.address.toLowerCase();
      const wethLower = network.tokens.WETH.address.toLowerCase();

      const hasSeed = token0Lower === seedLower || token1Lower === seedLower;
      const hasWeth = token0Lower === wethLower || token1Lower === wethLower;

      if (!hasSeed || !hasWeth || liquidity.eq(0)) {
        return { isValid: false };
      }

      return {
        isValid: true,
        actualFee: fee,
        token0,
        token1,
        token0IsSeed: token0Lower === seedLower,
      };
    } catch (error: any) {
      return { isValid: false };
    }
  }
}
