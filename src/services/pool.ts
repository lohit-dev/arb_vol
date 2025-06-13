import { ethers } from "ethers";
import { POOL_CONFIGS } from "../config/config";
import { POOL_ABI } from "../contracts/abi";
import { NetworkConfig } from "../types";

export interface PoolConfig {
  address: string;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

export interface PoolReserves {
  reserve0: string;
  reserve1: string;
  reserve0Formatted: string;
  reserve1Formatted: string;
  token0Info: TokenInfo;
  token1Info: TokenInfo;
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
    liquidity?: ethers.BigNumber;
    reserves?: PoolReserves;
  }> {
    try {
      const poolContract = new ethers.Contract(
        poolAddress,
        POOL_ABI,
        network.provider
      );

      const [token0, token1, fee, liquidity, slot0] = await Promise.all([
        poolContract.token0(),
        poolContract.token1(),
        poolContract.fee(),
        poolContract.liquidity(),
        poolContract.slot0(),
      ]);

      console.log(`The slot0 is: ${JSON.stringify(slot0)}`);

      const reserves = await this.getVirtualReserves(
        liquidity,
        slot0[0], // sqrtPriceX96
        token0,
        token1,
        network
      );

      console.log(`The reserves are: ${JSON.stringify(reserves)}`);

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
        liquidity,
        reserves,
      };
    } catch (error: any) {
      console.error("Error getting pool info:", error);
      return { isValid: false };
    }
  }

  private async getTokenInfo(
    tokenAddress: string,
    network: NetworkConfig
  ): Promise<TokenInfo> {
    const ERC20_ABI = [
      "function decimals() external view returns (uint8)",
      "function symbol() external view returns (string)",
    ];

    const tokenContract = new ethers.Contract(
      tokenAddress,
      ERC20_ABI,
      network.provider
    );

    try {
      const [decimals, symbol] = await Promise.all([
        tokenContract.decimals(),
        tokenContract.symbol(),
      ]);

      return {
        address: tokenAddress,
        symbol,
        decimals,
      };
    } catch (error) {
      console.error(`Error getting token info for ${tokenAddress}:`, error);
      // Fallback with default values
      return {
        address: tokenAddress,
        symbol: "UNKNOWN",
        decimals: 18,
      };
    }
  }

  private async getVirtualReserves(
    liquidity: ethers.BigNumber,
    sqrtPriceX96: ethers.BigNumber,
    token0Address: string,
    token1Address: string,
    network: NetworkConfig
  ): Promise<PoolReserves> {
    try {
      // Get token information including symbols and decimals
      const [token0Info, token1Info] = await Promise.all([
        this.getTokenInfo(token0Address, network),
        this.getTokenInfo(token1Address, network),
      ]);

      const Q96 = BigInt(2 ** 96);
      const liquidityBig = BigInt(liquidity.toString());
      const sqrtPriceBig = BigInt(sqrtPriceX96.toString());

      const reserve1 = (liquidityBig * sqrtPriceBig) / Q96;
      const reserve0 = (liquidityBig * Q96) / sqrtPriceBig;

      const decimals0Big = BigInt(10 ** token0Info.decimals);
      const decimals1Big = BigInt(10 ** token1Info.decimals);

      const reserve0Formatted = (reserve0 / decimals0Big).toString();
      const reserve1Formatted = (reserve1 / decimals1Big).toString();

      console.log(
        `Reserve 0 for network (${network.name}): ${reserve0Formatted} ${token0Info.symbol}`
      );
      console.log(
        `Reserve 1 for network (${network.name}): ${reserve1Formatted} ${token1Info.symbol}`
      );

      return {
        reserve0: reserve0.toString(),
        reserve1: reserve1.toString(),
        reserve0Formatted,
        reserve1Formatted,
        token0Info,
        token1Info,
      };
    } catch (error) {
      console.error("Error calculating reserves:", error);
      return this.getVirtualReservesWithDecimals(
        liquidity,
        sqrtPriceX96,
        token0Address,
        token1Address,
        18,
        18
      );
    }
  }

  private getVirtualReservesWithDecimals(
    liquidity: ethers.BigNumber,
    sqrtPriceX96: ethers.BigNumber,
    token0Address: string,
    token1Address: string,
    decimals0: number,
    decimals1: number
  ): PoolReserves {
    const Q96 = BigInt(2 ** 96);
    const liquidityBig = BigInt(liquidity.toString());
    const sqrtPriceBig = BigInt(sqrtPriceX96.toString());

    const reserve1 = (liquidityBig * sqrtPriceBig) / Q96;
    const reserve0 = (liquidityBig * Q96) / sqrtPriceBig;

    const decimals0Big = BigInt(10 ** decimals0);
    const decimals1Big = BigInt(10 ** decimals1);

    return {
      reserve0: reserve0.toString(),
      reserve1: reserve1.toString(),
      reserve0Formatted: (reserve0 / decimals0Big).toString(),
      reserve1Formatted: (reserve1 / decimals1Big).toString(),
      token0Info: {
        address: token0Address,
        symbol: "UNKNOWN",
        decimals: decimals0,
      },
      token1Info: {
        address: token1Address,
        symbol: "UNKNOWN",
        decimals: decimals1,
      },
    };
  }
}
