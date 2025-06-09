import { ArbitrageService } from "./services/arbitrage";
import { VOLUME_CONFIG } from "./config/config";

async function main(): Promise<void> {
  const privateKey =
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
  const bot = new ArbitrageService(privateKey);

  bot.setMinProfitThreshold(0.1);
  bot.setTradeAmount("1000000000000000000"); // 1 token
  bot.setProcessingCooldown(2000); // 2 second cooldown between processing

  await bot.manualVolumeCheck();

  console.log(
    `💹 Volume rebalancer: $${VOLUME_CONFIG.targetVolume} target per network`
  );
  console.log(
    `⏱️ Volume check interval: ${VOLUME_CONFIG.checkInterval / 1000}s`
  );
  console.log(`✅ Event-Driven Arbitrage Bot initialized`);
  console.log(`🌐 Networks: Ethereum, Arbitrum`);
  console.log(`💎 Tokens: SEED/WETH pairs`);
  console.log(`📡 Price source: CoinGecko API`);
  console.log(`🎧 Event-driven: Listens to actual swap events`);

  await bot.startEventListening();
}

// // Alternative execution for testing without events
// async function testScan(): Promise<void> {
//   const bot = new ArbitrageService(
//     "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
//   );

//   bot.setMinProfitThreshold(0.1);
//   bot.setTradeAmount("1000000000000000000"); // 1 token
//   bot.setProcessingCooldown(1000);

//   console.log(`🧪 Testing arbitrage scan without trading...`);
//   await bot.manualScan();

//   console.log(`\n📊 Bot Status:`);
//   console.log(JSON.stringify(bot.getStatus(), null, 2));
// }

if (require.main === module) {
  main().catch(console.error);
  // testScan().catch(console.error);
}
