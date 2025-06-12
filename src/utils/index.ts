import { ethers } from "ethers";

/**
 * Generate a randomized trade amount based on the volume deficit and current ETH price
 * @param volumeDeficit - The remaining volume needed in USD
 * @param ethPrice - Current ETH price in USD
 * @param attemptNumber - Current attempt number (for decreasing trade size)
 * @param minMultiplier - Minimum multiplier (default: 0.5 = 50% of base)
 * @param maxMultiplier - Maximum multiplier (default: 0.8 = 80% of base)
 * @returns Randomized amount in wei as string
 */
export function generateRandomTradeAmount(
  volumeDeficit: number,
  ethPrice: number,
  attemptNumber: number,
  minMultiplier: number = 0.5,
  maxMultiplier: number = 0.8
): string {
  // Calculate base amount in ETH (not USD)
  const baseAmountEth = volumeDeficit / ethPrice;

  // Generate random multiplier between min and max (capped at 80% of deficit)
  const randomMultiplier =
    Math.random() * (maxMultiplier - minMultiplier) + minMultiplier;

  // Apply attempt-based scaling (reduce size with each attempt)
  const attemptScale = 1 / Math.sqrt(attemptNumber + 1);

  // Calculate randomized amount in ETH
  let randomizedAmountEth = baseAmountEth * randomMultiplier * attemptScale;

  // Ensure minimum trade size of $150
  const minTradeUsd = 150;
  const minTradeEth = minTradeUsd / ethPrice;

  // Ensure maximum trade size doesn't exceed 80% of volume deficit
  const maxTradeEth = (volumeDeficit * 0.8) / ethPrice;

  // Apply bounds
  randomizedAmountEth = Math.max(randomizedAmountEth, minTradeEth);
  randomizedAmountEth = Math.min(randomizedAmountEth, maxTradeEth);

  // Convert to wei (18 decimals)
  return ethers.utils
    .parseUnits(randomizedAmountEth.toFixed(18), 18)
    .toString();
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function usdToWeth(usdAmount: number, ethPrice: number): string {
  const ethAmount = usdAmount / ethPrice;
  return ethers.utils.parseUnits(ethAmount.toFixed(18), 18).toString();
}

export function usdToSeed(usdAmount: number, seedPrice: number): string {
  const seedAmount = usdAmount / seedPrice;
  return ethers.utils.parseUnits(seedAmount.toFixed(18), 18).toString();
}
