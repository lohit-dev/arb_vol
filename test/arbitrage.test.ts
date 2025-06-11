import { ethers } from "ethers";
import { Token } from "@uniswap/sdk-core";
import { ArbitrageService } from "../src/services/arbitrage";
import { VolumeService } from "../src/services/volume";
import { NetworkService } from "../src/services/network";
import { PoolService } from "../src/services/pool";
import { TradeService } from "../src/services/trades";
import { CoinGeckoService } from "../src/services/coingecko";
import { QueueService } from "../src/services/queue";
import { VOLUME_CONFIG } from "../src/config/config";
import { NetworkConfig, SwapEventData, VolumeStatus } from "../src/types";

// Mock dependencies
jest.mock("../src/services/volume");
jest.mock("../src/services/network");
jest.mock("../src/services/pool");
jest.mock("../src/services/trades");
jest.mock("../src/services/coingecko");
jest.mock("../src/services/queue");

describe("ArbitrageService", () => {
  let arbitrageService: ArbitrageService;
  let mockVolumeService: jest.Mocked<VolumeService>;
  let mockNetworkService: jest.Mocked<NetworkService>;
  let mockPoolService: jest.Mocked<PoolService>;
  let mockTradeService: jest.Mocked<TradeService>;
  let mockCoinGeckoService: jest.Mocked<CoinGeckoService>;
  let mockQueueService: jest.Mocked<QueueService>;

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
      mockNetworks
    ) as jest.Mocked<TradeService>;
    mockCoinGeckoService =
      new CoinGeckoService() as jest.Mocked<CoinGeckoService>;
    mockQueueService = new QueueService(() =>
      Promise.resolve()
    ) as jest.Mocked<QueueService>;
    mockVolumeService = new VolumeService(
      mockNetworkService,
      mockPoolService,
      mockTradeService,
      mockCoinGeckoService
    ) as jest.Mocked<VolumeService>;

    // Create new instance for each test
    arbitrageService = new ArbitrageService(
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
    );
  });

  describe("Initialization", () => {
    it("should initialize with correct default values", () => {
      expect(arbitrageService).toBeDefined();
    });

    it("should set up all required services", () => {
      expect(NetworkService).toHaveBeenCalled();
      expect(TradeService).toHaveBeenCalled();
      expect(QueueService).toHaveBeenCalled();
      expect(CoinGeckoService).toHaveBeenCalled();
      expect(PoolService).toHaveBeenCalled();
      expect(VolumeService).toHaveBeenCalled();
    });
  });

  describe("Volume Management", () => {
    it("should track volume across networks", async () => {
      const mockVolume = 5000;
      const mockNetworkKey = "ethereum";

      // Mock volume service response
      (VolumeService.prototype.getVolumeStatus as jest.Mock).mockReturnValue({
        targetVolume: VOLUME_CONFIG.targetVolume,
        networkVolumes: [[mockNetworkKey, mockVolume]],
        rebalanceInProgress: [[mockNetworkKey, false]],
        lastVolumeReset: Date.now(),
      });

      const status = arbitrageService.getVolumeStatus() as VolumeStatus;
      expect(status.networkVolumes).toContainEqual([
        mockNetworkKey,
        mockVolume,
      ]);
    });

    it("should trigger volume rebalancing when below target", async () => {
      const mockNetworkKey = "ethereum";
      const mockVolume = VOLUME_CONFIG.targetVolume - 1000;

      // Mock volume service to return low volume
      (VolumeService.prototype.getVolumeStatus as jest.Mock).mockReturnValue({
        targetVolume: VOLUME_CONFIG.targetVolume,
        networkVolumes: [[mockNetworkKey, mockVolume]],
        rebalanceInProgress: [[mockNetworkKey, false]],
        lastVolumeReset: Date.now(),
      });

      await arbitrageService.manualVolumeCheck();
      expect(VolumeService.prototype.manualVolumeCheck).toHaveBeenCalled();
    });
  });

  describe("Arbitrage Execution", () => {
    it("should identify arbitrage opportunities", async () => {
      const mockOpportunity = {
        buyNetwork: "ethereum",
        sellNetwork: "arbitrum",
        profitPercentage: 1.5,
        buyPrice: "1000000000000000000",
        sellPrice: "1020000000000000000",
      };

      // Mock price data
      (CoinGeckoService.prototype.fetchPrices as jest.Mock).mockResolvedValue({
        ethereum: { usd: 2000 },
        seed: { usd: 1 },
      });

      await arbitrageService.manualScan();
    });

    it("should execute trades when profitable opportunity exists", async () => {
      const mockTradeParams = {
        tokenIn: mockConfig.tokens.ethereum.WETH.address,
        tokenOut: mockConfig.tokens.ethereum.SEED.address,
        amountIn: "1000000000000000000",
        minAmountOut: "0",
        network: "ethereum",
      };

      // Mock successful trade execution
      (TradeService.prototype.executeTrade as jest.Mock).mockResolvedValue({
        success: true,
        txHash: "0x...",
      });

      await arbitrageService.manualScan();
      expect(TradeService.prototype.executeTrade).toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("should handle network errors gracefully", async () => {
      // Mock network error
      (NetworkService.prototype.getNetworks as jest.Mock).mockImplementation(
        () => {
          throw new Error("Network error");
        }
      );

      await expect(arbitrageService.manualScan()).rejects.toThrow(
        "Network error"
      );
    });

    it("should handle failed trades gracefully", async () => {
      // Mock failed trade
      (TradeService.prototype.executeTrade as jest.Mock).mockResolvedValue({
        success: false,
        error: "Insufficient liquidity",
      });

      await arbitrageService.manualScan();
    });
  });

  describe("Event Listening", () => {
    it("should start event listeners for all networks", async () => {
      await arbitrageService.startEventListening();
      expect(NetworkService.prototype.startEventListening).toHaveBeenCalled();
    });

    it("should process events in order", async () => {
      const mockEvent: SwapEventData = {
        network: "ethereum",
        poolAddress: "0xd36ae827a9b62b8a32f0032cad1251b94fab1dd4",
        txHash: "0x123...",
        blockNumber: 12345678,
        sender: "0x456...",
        amount0: ethers.BigNumber.from("1000000000000000000"),
        amount1: ethers.BigNumber.from("2000000000000000000"),
        sqrtPriceX96: ethers.BigNumber.from("79228162514264337593543950336"),
        tick: 0,
      };

      // Mock event processing
      (QueueService.prototype.addToQueue as jest.Mock).mockImplementation(
        (eventData: SwapEventData) => {
          expect(eventData).toEqual(mockEvent);
        }
      );

      await arbitrageService.startEventListening();
    });
  });
});
