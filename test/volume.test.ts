import { ethers } from "ethers";
import { Token } from "@uniswap/sdk-core";
import { VolumeService } from "../src/services/volume";
import { NetworkService } from "../src/services/network";
import { PoolService } from "../src/services/pool";
import { TradeService } from "../src/services/trades";
import { CoinGeckoService } from "../src/services/coingecko";
import { DiSCORD_WEBHOOK_URL, VOLUME_CONFIG } from "../src/config/config";
import { NetworkConfig, RebalanceResult, VolumeStatus } from "../src/types";
import { DiscordNotificationService } from "../src/services/notification";

// Mock dependencies
jest.mock("../src/services/network");
jest.mock("../src/services/pool");
jest.mock("../src/services/trades");
jest.mock("../src/services/coingecko");

describe("VolumeService", () => {
  let volumeService: VolumeService;
  let mockNetworkService: jest.Mocked<NetworkService>;
  let mockPoolService: jest.Mocked<PoolService>;
  let mockTradeService: jest.Mocked<TradeService>;
  let mockCoinGeckoService: jest.Mocked<CoinGeckoService>;

  // Mock config
  const mockConfig = {
    networks: {
      ethereum: {
        chainId: 1,
        name: "Ethereum",
        gasPrice: "30",
        provider: new ethers.providers.JsonRpcProvider("http://localhost:8545"),
        quoter: new ethers.Contract(
          "0x0000000000000000000000000000000000000000",
          [],
          new ethers.providers.JsonRpcProvider("http://localhost:8545")
        ),
        tokens: {
          WETH: new Token(
            1,
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            18,
            "WETH",
            "Wrapped Ether"
          ),
          SEED: new Token(
            1,
            "0x5eed99d066a8CaF10f3E4327c1b3D8b673485eED",
            18,
            "SEED",
            "Seed Token"
          ),
        },
      },
      arbitrum: {
        chainId: 42161,
        name: "Arbitrum",
        gasPrice: "0.1",
        provider: new ethers.providers.JsonRpcProvider("http://localhost:8546"),
        quoter: new ethers.Contract(
          "0x0000000000000000000000000000000000000000",
          [],
          new ethers.providers.JsonRpcProvider("http://localhost:8546")
        ),
        tokens: {
          WETH: new Token(
            42161,
            "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
            18,
            "WETH",
            "Wrapped Ether"
          ),
          SEED: new Token(
            42161,
            "0x86f65121804D2Cdbef79F9f072D4e0c2eEbABC08",
            18,
            "SEED",
            "Seed Token"
          ),
        },
      },
    },
    tokens: {
      ethereum: {
        WETH: {
          chainId: 1,
          address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
          decimals: 18,
          symbol: "WETH",
          name: "Wrapped Ether",
        },
        SEED: {
          chainId: 1,
          address: "0x5eed99d066a8CaF10f3E4327c1b3D8b673485eED",
          decimals: 18,
          symbol: "SEED",
          name: "Seed Token",
        },
      },
      arbitrum: {
        WETH: {
          chainId: 42161,
          address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
          decimals: 18,
          symbol: "WETH",
          name: "Wrapped Ether",
        },
        SEED: {
          chainId: 42161,
          address: "0x86f65121804D2Cdbef79F9f072D4e0c2eEbABC08",
          decimals: 18,
          symbol: "SEED",
          name: "Seed Token",
        },
      },
    },
    poolConfigs: {
      ethereum: [
        {
          address: "0xd36ae827a9b62b8a32f0032cad1251b94fab1dd4",
        },
      ],
      arbitrum: [
        {
          address: "0xf9f588394ec5c3b05511368ce016de5fd3812446",
        },
      ],
    },
  } as const;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Create mock instances with required constructor arguments
    const mockNetworks = new Map(Object.entries(mockConfig.networks)) as Map<
      string,
      NetworkConfig
    >;
    mockNetworkService = new NetworkService(
      null as any, // QueueService will be set later
      null as any, // TradeService will be set later
      () => Promise.resolve(), // scanAndExecute callback
      undefined // privateKey
    ) as jest.Mocked<NetworkService>;
    mockPoolService = new PoolService(mockNetworks) as jest.Mocked<PoolService>;
    mockTradeService = new TradeService(
      mockNetworks,
      new DiscordNotificationService(DiSCORD_WEBHOOK_URL)
    ) as jest.Mocked<TradeService>;
    mockCoinGeckoService =
      new CoinGeckoService() as jest.Mocked<CoinGeckoService>;

    // Create new instance for each test
    volumeService = new VolumeService(
      mockNetworkService,
      mockPoolService,
      mockTradeService,
      mockCoinGeckoService
    );
  });

  describe("Volume Tracking", () => {
    it("should initialize volume tracking for all networks", () => {
      const networks = ["ethereum", "arbitrum"];
      mockNetworkService.getNetworks.mockReturnValue(
        new Map(networks.map((n) => [n, mockConfig.networks[n]]))
      );

      volumeService = new VolumeService(
        mockNetworkService,
        mockPoolService,
        mockTradeService,
        mockCoinGeckoService
      );

      const status = volumeService.getVolumeStatus() as VolumeStatus;
      expect(status.networkVolumes).toHaveLength(networks.length);
      networks.forEach((network) => {
        expect(status.networkVolumes).toContainEqual([network, 0]);
      });
    });

    it("should track volume correctly", async () => {
      const mockNetworkKey = "ethereum";
      const mockVolume = 5000;

      // Mock volume data
      (mockPoolService as any).getPoolVolume = jest
        .fn()
        .mockResolvedValue(mockVolume);

      await volumeService.manualVolumeCheck();
      const status = volumeService.getVolumeStatus() as VolumeStatus;
      expect(status.networkVolumes).toContainEqual([
        mockNetworkKey,
        mockVolume,
      ]);
    });
  });

  describe("Volume Rebalancing", () => {
    it("should trigger rebalancing when volume is below target", async () => {
      const mockNetworkKey = "ethereum";
      const mockVolume = VOLUME_CONFIG.targetVolume - 1000;

      // Mock low volume
      (mockPoolService as any).getPoolVolume = jest
        .fn()
        .mockResolvedValue(mockVolume);

      // Mock successful rebalancing
      const mockRebalanceResult: RebalanceResult = {
        success: true,
        volumeGenerated: 1000,
        attempts: 1,
      };
      mockTradeService.executeRebalanceTrades.mockResolvedValue(
        mockRebalanceResult
      );

      await volumeService.manualVolumeCheck();
      expect(mockTradeService.executeRebalanceTrades).toHaveBeenCalled();
    });

    it("should not trigger rebalancing when volume is above target", async () => {
      const mockNetworkKey = "ethereum";
      const mockVolume = VOLUME_CONFIG.targetVolume + 1000;

      // Mock high volume
      (mockPoolService as any).getPoolVolume = jest
        .fn()
        .mockResolvedValue(mockVolume);

      await volumeService.manualVolumeCheck();
      expect(mockTradeService.executeRebalanceTrades).not.toHaveBeenCalled();
    });

    it("should handle rebalancing failures gracefully", async () => {
      const mockNetworkKey = "ethereum";
      const mockVolume = VOLUME_CONFIG.targetVolume - 1000;

      // Mock low volume
      (mockPoolService as any).getPoolVolume = jest
        .fn()
        .mockResolvedValue(mockVolume);

      // Mock failed rebalancing
      const mockRebalanceResult: RebalanceResult = {
        success: false,
        volumeGenerated: 0,
        attempts: 1,
      };
      mockTradeService.executeRebalanceTrades.mockResolvedValue(
        mockRebalanceResult
      );

      await volumeService.manualVolumeCheck();
      const status = volumeService.getVolumeStatus() as VolumeStatus;
      expect(status.rebalanceInProgress).toContainEqual([
        mockNetworkKey,
        false,
      ]);
    });
  });

  describe("Volume Reset", () => {
    it("should reset volumes after configured interval", async () => {
      const mockNetworkKey = "ethereum";
      const mockVolume = 5000;

      // Set initial volume
      (mockPoolService as any).getPoolVolume = jest
        .fn()
        .mockResolvedValue(mockVolume);
      await volumeService.manualVolumeCheck();

      // Fast forward time
      jest.advanceTimersByTime(VOLUME_CONFIG.volumeResetInterval);

      const status = volumeService.getVolumeStatus() as VolumeStatus;
      expect(status.networkVolumes).toContainEqual([mockNetworkKey, 0]);
    });
  });

  describe("Error Handling", () => {
    it("should handle network errors during volume check", async () => {
      (mockPoolService as any).getPoolVolume = jest
        .fn()
        .mockRejectedValue(new Error("Network error"));

      await expect(volumeService.manualVolumeCheck()).rejects.toThrow(
        "Network error"
      );
    });

    it("should handle price fetch errors during rebalancing", async () => {
      const mockNetworkKey = "ethereum";
      const mockVolume = VOLUME_CONFIG.targetVolume - 1000;

      // Mock low volume
      (mockPoolService as any).getPoolVolume = jest
        .fn()
        .mockResolvedValue(mockVolume);

      // Mock price fetch error
      mockCoinGeckoService.fetchPrices.mockRejectedValue(
        new Error("Price fetch failed")
      );

      await volumeService.manualVolumeCheck();
      expect(mockTradeService.executeRebalanceTrades).not.toHaveBeenCalled();
    });
  });
});
