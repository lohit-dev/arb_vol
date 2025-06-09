import { ethers } from "ethers";

jest.setTimeout(60000); // extend timeout for async blockchain ops

describe("Swap flow on Arbitrum fork", () => {
  let provider;
  let wallet;
  let walletAddress;
  let wethContract;
  let router;
  let poolContract;

  const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
  const ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
  const SEED_TOKEN_ADDRESS = "0x86f65121804D2Cdbef79F9f072D4e0c2eEbABC08";
  const POOL_ADDRESS = "0xf9f588394ec5c3b05511368ce016de5fd3812446";

  beforeAll(async () => {
    provider = new ethers.providers.JsonRpcProvider("http://localhost:8546");

    const privateKey =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    wallet = new ethers.Wallet(privateKey, provider);
    walletAddress = await wallet.getAddress();

    wethContract = new ethers.Contract(
      WETH_ADDRESS,
      [
        "function deposit() external payable",
        "function balanceOf(address) external view returns (uint256)",
        "function approve(address, uint256) external returns (bool)",
        "function allowance(address owner, address spender) external view returns (uint256)",
      ],
      wallet
    );

    router = new ethers.Contract(
      ROUTER_ADDRESS,
      [
        "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160)) external payable returns (uint256)",
      ],
      wallet
    );

    poolContract = new ethers.Contract(
      POOL_ADDRESS,
      [
        "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
      ],
      provider
    );
  });

  test("should have sufficient ETH balance", async () => {
    const balance = await provider.getBalance(walletAddress);
    expect(balance.gt(ethers.utils.parseEther("1"))).toBe(true);
  });

  test("should wrap 1 ETH to WETH", async () => {
    const wrapAmount = ethers.utils.parseEther("1");
    const tx = await wethContract.deposit({ value: wrapAmount });
    const receipt = await tx.wait();

    expect(receipt.status).toBe(1);

    const wethBalance = await wethContract.balanceOf(walletAddress);
    expect(wethBalance.gte(wrapAmount)).toBe(true);
  });

  test("should approve router to spend 0.1 WETH", async () => {
    const approveAmount = ethers.utils.parseEther("0.1");
    const tx = await wethContract.approve(ROUTER_ADDRESS, approveAmount);
    const receipt = await tx.wait();

    expect(receipt.status).toBe(1);

    const allowance = await wethContract.allowance(
      walletAddress,
      ROUTER_ADDRESS
    );
    expect(allowance.gte(approveAmount)).toBe(true);
  });

  test("should execute swap from WETH to SEED", async () => {
    const amountIn = ethers.utils.parseEther("0.1");
    const deadline = Math.floor(Date.now() / 1000) + 600;

    const tx = await router.exactInputSingle(
      [
        WETH_ADDRESS, // tokenIn
        SEED_TOKEN_ADDRESS, // tokenOut
        3000, // fee 0.3%
        walletAddress, // recipient
        deadline, // deadline
        amountIn, // amountIn
        0, // amountOutMinimum
        0, // sqrtPriceLimitX96
      ],
      { gasLimit: 500000 }
    );

    const receipt = await tx.wait();

    expect(receipt.status).toBe(1);
    expect(receipt.gasUsed.toNumber()).toBeGreaterThan(0);

    // Save receipt for potential use in next tests (if needed)
    // You can store in global or test scope if necessary
  });

  test("should detect Swap event in the pool contract", async () => {
    const currentBlock = await provider.getBlockNumber();
    const events = await poolContract.queryFilter(
      poolContract.filters.Swap(),
      currentBlock - 10,
      currentBlock
    );

    expect(events.length).toBeGreaterThan(0);

    // Check event properties (first event)
    const event = events[0];
    expect(event.args).toHaveProperty("sender");
    expect(event.args).toHaveProperty("recipient");
    expect(typeof event.args.sender).toBe("string");
    expect(typeof event.args.recipient).toBe("string");
  });
});
