import { ethers } from "ethers";
import { PoolReserves } from "../services/pool";

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

  // Add hard cap of 10 ETH per trade
  const hardCapEth = 10;
  randomizedAmountEth = Math.min(randomizedAmountEth, hardCapEth);

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

export function calculateOptimalTradeAmount(
  buyPoolReserves: PoolReserves, // pool where you buy SEED (low price side)
  sellPoolReserves: PoolReserves // pool where you sell SEED (high price side)
): ethers.BigNumber {
  // arbitrage side low seed price side 
  // a - seed (ETH side)
  // b - weth (arb side)
  // c - weth (arb side)
  // d - seed (ETH side)

  if (!buyPoolReserves || !sellPoolReserves) {
    throw new Error("PoolReserves missing in calculateOptimalTradeAmount");
  }

  let a: number, b: number, c: number, d: number;

  // For ETH pool: a = SEED (ETH side), d = WETH (ETH side)
  if (buyPoolReserves.token0Info.symbol === "SEED") {
    a = parseFloat(buyPoolReserves.token0Info.reserve0);
    d = parseFloat(buyPoolReserves.token0Info.reserve1);
  } else if (buyPoolReserves.token1Info.symbol === "SEED") {
    a = parseFloat(buyPoolReserves.token1Info.reserve1);
    d = parseFloat(buyPoolReserves.token1Info.reserve0);
  } else {
    throw new Error("SEED not found in buyPoolReserves token0 or token1");
  }

  // For Arb pool: b = WETH (arb side), c = WETH (arb side)
  if (sellPoolReserves.token0Info.symbol === "WETH") {
    b = parseFloat(sellPoolReserves.token0Info.reserve0);
    c = parseFloat(sellPoolReserves.token0Info.reserve0);
  } else if (sellPoolReserves.token1Info.symbol === "WETH") {
    b = parseFloat(sellPoolReserves.token1Info.reserve1);
    c = parseFloat(sellPoolReserves.token1Info.reserve1);
  } else {
    throw new Error("WETH not found in sellPoolReserves token0 or token1");
  }

  console.log(`a (SEED, ETH side):`, a);
  console.log(`b (WETH, arb side):`, b);
  console.log(`c (WETH, arb side):`, c);
  console.log(`d (SEED, ETH side):`, d);

  // Optimal amount formula for selling
  const sqrtAbcd = Math.sqrt(a * b * c * d);
  const bc = b * c;
  const aPlusC = a + c;
  const numerator = sqrtAbcd - bc;
  const denominator = aPlusC;
  const result = numerator / denominator;
  console.log("sqrtAbcd value: ", sqrtAbcd);
  console.log("bc value: ", bc);
  console.log("aPlusC value: ", aPlusC);
  console.log(`numerator: ${numerator}`);
  console.log(`Denominator: ${denominator}`);
  console.log("result value: ", result);

  return ethers.utils.parseUnits(result.toString(), 18);
}

// Helper to get reserves in correct order
function getReservesForDirection(
  buyPoolInfo: any,
  sellPoolInfo: any,
  buyTokenIn: string, // address of token you spend to buy SEED (WETH)
  sellTokenOut: string // address of token you receive when selling SEED (WETH)
) {
  // For buy pool: tokenIn (WETH) -> tokenOut (SEED)
  let a, b;
  if (buyPoolInfo.token0Info.address.toLowerCase() === buyTokenIn.toLowerCase()) {
    a = parseFloat(ethers.utils.formatUnits(buyPoolInfo.reserves.reserve0, 18)); // WETH
    b = parseFloat(ethers.utils.formatUnits(buyPoolInfo.reserves.reserve1, 18)); // SEED
  } else {
    a = parseFloat(ethers.utils.formatUnits(buyPoolInfo.reserves.reserve1, 18)); // WETH
    b = parseFloat(ethers.utils.formatUnits(buyPoolInfo.reserves.reserve0, 18)); // SEED
  }

  // For sell pool: tokenIn (SEED) -> tokenOut (WETH)
  let c, d;
  if (sellPoolInfo.token0Info.address.toLowerCase() === sellTokenOut.toLowerCase()) {
    d = parseFloat(ethers.utils.formatUnits(sellPoolInfo.reserves.reserve0, 18)); // WETH
    c = parseFloat(ethers.utils.formatUnits(sellPoolInfo.reserves.reserve1, 18)); // SEED
  } else {
    d = parseFloat(ethers.utils.formatUnits(sellPoolInfo.reserves.reserve1, 18)); // WETH
    c = parseFloat(ethers.utils.formatUnits(sellPoolInfo.reserves.reserve0, 18)); // SEED
  }

  return { a, b, c, d };
}

// arbitrage side low seed price side 
// a - seed 
// b - weth
// c - seed 
// d - weth
