import { startBot } from "./bot.js";
import { startCronJobs } from "./cron.js";

console.log("🚀 DAC Airdrop Bot v1.0");
console.log(`   Chain: DAC Inception Testnet (ID 21894)`);
console.log(`   RPC: https://rpctest.dachain.tech`);
console.log(`   Portal: https://inception.dachain.io`);

const bot = startBot();

startCronJobs((msg) => {
  const chatId = process.env.CHAT_ID;
  if (chatId) {
    bot.telegram.sendMessage(chatId, msg).catch(() => {});
  }
});

// Graceful shutdown
const shutdown = () => {
  console.log("Shutting down...");
  bot.stop("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
