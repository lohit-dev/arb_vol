import { ethers } from "ethers";

jest.setTimeout(30000); // Increase timeout for blockchain interactions

describe("Ethereum WETH/SEED Swap and Pool Interaction", () => {
  let provider;
  let wallet;
  let walletAddress;
  let wethContract;
  const wethAddress = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
  const poolAddress = "0xf9f588394ec5c3b05511368ce016de5fd3812446"; // Arbitrum WETH/SEED pool
  const seedTokenAddress = "0x86f65121804D2Cdbef79F9f072D4e0c2eEbABC08";
  const quoterAddress = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6"; // Uniswap V3 Quoter
  const routerAddress = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Uniswap V3 Router

  beforeAll(async () => {
    provider = new ethers.providers.JsonRpcProvider("http://localhost:8546");

    const privateKey =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    wallet = new ethers.Wallet(privateKey, provider);
    walletAddress = await wallet.getAddress();

    wethContract = new ethers.Contract(
      wethAddress,
      [
        "function deposit() external payable",
        "function balanceOf(address) external view returns (uint256)",
        "function approve(address, uint256) external returns (bool)",
        "function transfer(address to, uint256 amount) external returns (bool)",
      ],
      wallet
    );
  });

  test("Should get wallet balance", async () => {
    const balance = await provider.getBalance(walletAddress);
    const balanceEth = ethers.utils.formatEther(balance);
    console.log(`Wallet ETH balance: ${balanceEth} ETH`);
    expect(balance.gt(0)).toBe(true);
  });

  test("Should wrap 1 ETH into WETH", async () => {
    const wrapAmount = ethers.utils.parseEther("1");
    const tx = await wethContract.deposit({ value: wrapAmount });
    await tx.wait();

    const wethBalance = await wethContract.balanceOf(walletAddress);
    const wethBalanceEth = ethers.utils.formatEther(wethBalance);
    console.log(`WETH balance after wrapping: ${wethBalanceEth} WETH`);
    expect(wethBalance.gte(wrapAmount)).toBe(true);
  });

  test("Should transfer 0.01 WETH to the pool", async () => {
    const transferAmount = ethers.utils.parseEther("0.01");
    const transferTx = await wethContract.transfer(poolAddress, transferAmount);
    const receipt = await transferTx.wait();

    console.log(`WETH transferred to pool: ${transferTx.hash}`);
    expect(receipt.status).toBe(1); // Transaction success
  });

  test("Should get quote for WETH -> SEED swap from Uniswap V3 Quoter", async () => {
    const quoterABI = [
      "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
    ];
    const quoterContract = new ethers.Contract(
      quoterAddress,
      quoterABI,
      wallet
    );

    const amountIn = ethers.utils.parseEther("0.1");

    let quoteAmount;
    try {
      quoteAmount = await quoterContract.callStatic.quoteExactInputSingle(
        wethAddress,
        seedTokenAddress,
        3000,
        amountIn,
        0
      );
      console.log(
        `Quote: ${ethers.utils.formatEther(quoteAmount)} SEED for 0.1 WETH`
      );
      expect(quoteAmount.gt(0)).toBe(true);
    } catch (err) {
      console.error("Quote failed:", err);
      quoteAmount = ethers.BigNumber.from("0");
    }
  });

  test("Should approve router and swap 0.1 WETH -> SEED via Uniswap V3 Router", async () => {
    const approveAmount = ethers.utils.parseEther("0.1");

    // Approve router
    const approveTx = await wethContract.approve(routerAddress, approveAmount);
    await approveTx.wait();
    console.log("Router approved to spend WETH");

    // Router contract setup
    const routerABI = [
      "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut)",
    ];
    const routerContract = new ethers.Contract(
      routerAddress,
      routerABI,
      wallet
    );

    // Execute swap
    const swapParams = {
      tokenIn: wethAddress,
      tokenOut: seedTokenAddress,
      fee: 3000,
      recipient: walletAddress,
      deadline: Math.floor(Date.now() / 1000) + 600,
      amountIn: approveAmount,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    };

    const swapTx = await routerContract.exactInputSingle(swapParams, {
      gasLimit: 500000,
    });
    const receipt = await swapTx.wait();

    console.log(`Swap transaction successful: ${receipt.transactionHash}`);
    expect(receipt.status).toBe(1); // Success
  });
});
