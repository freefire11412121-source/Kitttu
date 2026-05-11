import { startBot, sendNotification } from "./bot.js";
import { startCronJobs } from "./cron.js";

console.log("Viewpoints Auto Bot v1.0");
console.log("  Survey automation for Meta Viewpoints");
console.log("  Telegram-controlled | Auto-scheduled");

const bot = startBot();

startCronJobs((msg) => {
  sendNotification(msg);
});

const shutdown = () => {
  console.log("Shutting down...");
  bot.stop("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
