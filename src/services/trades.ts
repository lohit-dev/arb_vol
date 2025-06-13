import { ethers } from "ethers";
import { ERC20_ABI } from "../contracts/abi";
import { ArbitrageOpportunity, NetworkConfig, TradeParams } from "../types";
import { generateRandomTradeAmount, sleep } from "../utils";
import { DiscordNotificationService } from "./notification";
import { VOLUME_CONFIG } from "../config/config";

export class TradeService {
  private ourTransactions: Set<string> = new Set();
  private ourAddresses: Set<string> = new Set();

  constructor(
    private networks: Map<string, NetworkConfig>,
    private notificationService: DiscordNotificationService
  ) {}

  async executeTrade(params: TradeParams): Promise<{
    success: boolean;
    txHash?: string;
    error?: string;
  }> {
    const network = this.getNetwork(params.network);
    if (!network || !network.wallet || !network.swapRouter) {
      return {
        success: false,
        error: `Network ${params.network} not configured for trading`,
      };
    }

    const tokenContract = new ethers.Contract(
      params.tokenIn,
      ERC20_ABI,
      network.wallet
    );
    const currentAllowance = await tokenContract.allowance(
      network.wallet.address,
      network.swapRouter.address
    );
    if (currentAllowance.lt(params.amountIn)) {
      const approveTx = await tokenContract.approve(
        network.swapRouter.address,
        ethers.constants.MaxUint256
      );
      await approveTx.wait();
    }

    try {
      console.log(`Executing trade on ${params.network}...`);

      const swapParams = {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        fee: params.fee,
        recipient: network.wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 300,
        amountIn: params.amountIn,
        amountOutMinimum: params.minAmountOut,
        sqrtPriceLimitX96: 0,
      };

      const gasPrice = await network.provider.getGasPrice();
      console.log(
        `Current gas price: ${ethers.utils.formatUnits(gasPrice, "gwei")} Gwei`
      );
      const txOptions = {
        gasLimit: 500000,
        gasPrice: gasPrice.mul(110).div(100), // 10% above current gas
      };

      const swapTx = await network.swapRouter.exactInputSingle(
        swapParams,
        txOptions
      );
      console.log(`Transaction hash: ${swapTx.hash}`);

      // Track our transaction
      this.ourTransactions.add(swapTx.hash.toLowerCase());

      await swapTx.wait(1);
      console.log(`✅ Trade executed successfully`);

      return {
        success: true,
        txHash: swapTx.hash,
      };
    } catch (error: any) {
      const errorMessage = error.reason || error.message;
      const simpleError = errorMessage.split("(")[0].trim();

      return {
        success: false,
        error: simpleError,
      };
    }
  }

  async calculateMinAmountOut(
    networkKey: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    fee: number,
    slippagePercent: number = 5
  ): Promise<string> {
    const network = this.getNetwork(networkKey);
    if (!network) return "0";

    try {
      const quote = await network.quoter.callStatic.quoteExactInputSingle(
        tokenIn,
        tokenOut,
        fee,
        amountIn,
        0
      );

      // Apply slippage tolerance
      const minAmount = quote.mul(100 - slippagePercent).div(100);
      return minAmount.toString();
    } catch (error) {
      console.error(`Failed to calculate min amount: ${error}`);
      return "0"; // Accept any amount if calculation fails
    }
  }

  public async executeEquilibriumTrade(
    opportunity: ArbitrageOpportunity
  ): Promise<boolean> {
    const tradeId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    console.log(`\n⚖️ EXECUTING EQUILIBRIUM TRADE ${tradeId}`);
    console.log(
      `Buy ${opportunity.buyNetwork} → Sell ${opportunity.sellNetwork}`
    );
    console.log(`Price Deviation: ${opportunity.profitPercentage.toFixed(2)}%`);

    try {
      const buyNetworkKey = opportunity.buyNetwork.toLowerCase();
      const sellNetworkKey = opportunity.sellNetwork.toLowerCase();

      const buyNetwork = this.getNetwork(buyNetworkKey);
      const sellNetwork = this.getNetwork(sellNetworkKey);

      if (!buyNetwork || !sellNetwork) {
        throw new Error("Network configuration not found");
      }

      // Check balances
      const buyNetworkBalances = await this.checkBalances(buyNetworkKey);
      const sellNetworkBalances = await this.checkBalances(sellNetworkKey);

      console.log(`\nBalances before equilibrium trade:`);
      console.log(
        `${opportunity.buyNetwork}: ${buyNetworkBalances.seed} SEED, ${buyNetworkBalances.weth} WETH`
      );
      console.log(
        `${opportunity.sellNetwork}: ${sellNetworkBalances.seed} SEED, ${sellNetworkBalances.weth} WETH`
      );

      // Calculate dynamic trade amount based on price deviation
      const baseAmount = ethers.utils.parseUnits("1", 18); // 1 WETH base amount
      const scaleFactor = Math.min(opportunity.profitPercentage / 100, 2.0); // Cap at 200%
      const tradeAmount = baseAmount
        .mul(Math.floor(scaleFactor * 100))
        .div(100);

      // Execute buy trade
      const buyParams: TradeParams = {
        tokenIn: buyNetwork.tokens.WETH.address,
        tokenOut: buyNetwork.tokens.SEED.address,
        fee: 3000, // Default fee tier
        amountIn: tradeAmount.toString(),
        network: buyNetworkKey,
        minAmountOut: "0", // Market maker can accept any price
      };

      console.log(`\n1️⃣ Executing buy trade on ${buyNetworkKey}...`);
      const buyResult = await this.executeTrade(buyParams);
      if (!buyResult.success) {
        throw new Error(`Buy trade failed: ${buyResult.error}`);
      }

      // Small delay between trades
      await sleep(2000);

      // Execute sell trade on the other network
      const sellParams: TradeParams = {
        tokenIn: sellNetwork.tokens.WETH.address,
        tokenOut: sellNetwork.tokens.SEED.address,
        fee: 3000,
        amountIn: tradeAmount.toString(),
        network: sellNetworkKey,
        minAmountOut: "0",
      };

      console.log(`\n2️⃣ Executing sell trade on ${sellNetworkKey}...`);
      const sellResult = await this.executeTrade(sellParams);
      if (!sellResult.success) {
        throw new Error(`Sell trade failed: ${sellResult.error}`);
      }

      // Check final balances
      const finalBuyBalances = await this.checkBalances(buyNetworkKey);
      const finalSellBalances = await this.checkBalances(sellNetworkKey);

      console.log(`\nBalances after equilibrium trades:`);
      console.log(
        `${opportunity.buyNetwork}: ${finalBuyBalances.seed} SEED, ${finalBuyBalances.weth} WETH`
      );
      console.log(
        `${opportunity.sellNetwork}: ${finalSellBalances.seed} SEED, ${finalSellBalances.weth} WETH`
      );

      console.log(
        `\n✅ EQUILIBRIUM TRADE ${tradeId} COMPLETED - PRICES BALANCED`
      );

      await sleep(5000);

      // Notify about successful equilibrium trade
      await this.notificationService.sendCustomMessage(
        "⚖️ Equilibrium Trade Complete",
        `Trade ID: ${tradeId}\n` +
          `Networks: ${buyNetworkKey} ↔️ ${sellNetworkKey}\n` +
          `Initial Deviation: ${opportunity.profitPercentage.toFixed(2)}%\n` +
          `Trade Amount: ${ethers.utils.formatUnits(tradeAmount, 18)} WETH`,
        0x00ff00 // Green color
      );

      return true;
    } catch (error: any) {
      console.error(`❌ Equilibrium trade ${tradeId} failed: ${error.message}`);

      // Notify about failed trade
      await this.notificationService.sendCustomMessage(
        "❌ Equilibrium Trade Failed",
        `Trade ID: ${tradeId}\n` + `Error: ${error.message}`,
        0xff0000 // Red color
      );

      return false;
    }
  }

  async checkBalances(networkKey: string): Promise<{
    weth: string;
    seed: string;
    nativeToken: string;
  }> {
    const network = this.getNetwork(networkKey);
    if (!network || !network.wallet) {
      throw new Error(`Network ${networkKey} not configured with wallet`);
    }

    const wethContract = new ethers.Contract(
      network.tokens.WETH.address,
      ERC20_ABI,
      network.provider
    );

    const seedContract = new ethers.Contract(
      network.tokens.SEED.address,
      ERC20_ABI,
      network.provider
    );

    const [wethBalance, seedBalance, nativeBalance] = await Promise.all([
      wethContract.balanceOf(network.wallet.address),
      seedContract.balanceOf(network.wallet.address),
      network.provider.getBalance(network.wallet.address),
    ]);

    return {
      weth: ethers.utils.formatUnits(wethBalance, 18),
      seed: ethers.utils.formatUnits(seedBalance, 18),
      nativeToken: ethers.utils.formatUnits(nativeBalance, 18),
    };
  }

  isOurTransaction(txHash: string, sender: string): boolean {
    const txHashLower = txHash.toLowerCase();
    const senderLower = sender.toLowerCase();

    return (
      this.ourTransactions.has(txHashLower) ||
      this.ourAddresses.has(senderLower)
    );
  }

  private getNetwork(networkKey: string): NetworkConfig | undefined {
    let network = this.networks.get(networkKey);
    if (network) return network;

    network = this.networks.get(networkKey.toLowerCase());
    if (network) return network;

    network = this.networks.get(
      networkKey.charAt(0).toUpperCase() + networkKey.slice(1).toLowerCase()
    );
    return network;
  }

  public async executeRebalanceTrades(
    networkKey: string,
    volumeDeficit: number,
    ethPrice: number
  ): Promise<{
    success: boolean;
    volumeGenerated: number;
    attempts: number;
  }> {
    let attempts = 0;
    let volumeGenerated = 0;
    const maxAttempts = 10;

    try {
      console.log(`🔄 Starting volume rebalancing trades for ${networkKey}`);

      const network = this.getNetwork(networkKey);
      if (!network || !network.wallet) {
        throw new Error("Missing network configuration");
      }

      let remainingDeficit = volumeDeficit;

      while (remainingDeficit > 0 && attempts < maxAttempts) {
        const isWethToSeed = attempts % 2 === 0;

        try {
          const minMultiplier = 0.5;
          const maxMultiplier = 2.0;

          const randomizedAmount = generateRandomTradeAmount(
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
            fee: 3000, // Default fee
            amountIn: randomizedAmount.toString(),
            network: networkKey,
            minAmountOut: "0", // Accept any amount for rebalancing
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

          // Add random delay between trades
          const delayMs = 800 + Math.random() * 300;
          console.log(
            `⏱️ Waiting ${delayMs.toFixed(0)}ms before next trade...`
          );
          await sleep(delayMs);
        } catch (error: any) {
          console.error(
            `Trade attempt ${attempts + 1} failed: ${error.message}`
          );
          await sleep(1000); // Wait 1 second before retrying
        }

        attempts++;
      }

      await this.notificationService.sendCustomMessage(
        "🔄 Volume Rebalancing Complete",
        `Network: ${networkKey.toUpperCase()}\n` +
          `Current Volume: $${(
            VOLUME_CONFIG.targetVolume - volumeDeficit
          ).toFixed(2)}\n` +
          `Target Volume: $${VOLUME_CONFIG.targetVolume}\n` +
          `Generated Volume: $${volumeGenerated.toFixed(2)}\n` +
          `Total Trades: ${attempts}`,
        0x00ff00 // Green color
      );

      return { success: true, volumeGenerated, attempts };
    } catch (error: any) {
      console.error(`❌ Rebalance trades failed: ${error.message}`);
      return { success: false, volumeGenerated, attempts };
    }
  }
}
