import { startBot } from "./bot.js";
import { startCronJobs } from "./cron.js";
import { WalletVault } from "./vault.js";
import { MultiRunner } from "./multi-runner.js";
import { AutoScheduler } from "./auto-scheduler.js";
import { getWallets } from "./wallets.js";
import { createDacWallet } from "./chain.js";

console.log("🚀 DAC Airdrop Bot v2.0 (with AutoScheduler + MultiRunner)");
console.log(`   Chain: DAC Inception Testnet (ID 21894)`);
console.log(`   RPC: https://rpctest.dachain.tech`);
console.log(`   Portal: https://inception.dachain.io`);

// ─── Initialize Vault & Sync Wallets ───────────────────────────────────

const vault = new WalletVault();

// Sync wallets from env/wallets.json into the vault DB
const envWallets = getWallets();
if (envWallets.length > 0) {
  console.log(`📥 Syncing ${envWallets.length} wallet(s) from env/file into vault...`);
  for (const pk of envWallets) {
    const { account } = createDacWallet(pk as `0x${string}`);
    vault.addWallet(account.address, pk);
  }
}

const vaultWallets = vault.listWallets();
console.log(`💼 Vault has ${vaultWallets.length} wallet(s) total`);

// ─── Initialize MultiRunner ────────────────────────────────────────────

const runner = new MultiRunner(vault);

// ─── Start Telegram Bot ────────────────────────────────────────────────

const bot = startBot();

// Attach TG notifier to runner
runner.attachNotifier(async (msg: string) => {
  const chatId = process.env.CHAT_ID;
  if (chatId) {
    try {
      await bot.telegram.sendMessage(chatId, msg.slice(0, 4000));
    } catch { /* silent */ }
  }
});

// ─── Register Extra Bot Commands ───────────────────────────────────────

// /auto_run — trigger the multi-runner manually
bot.command("auto_run", async (ctx) => {
  if (runner.state.running) {
    ctx.reply("⚠️ Run already in progress. Use /auto_stop to cancel.");
    return;
  }
  ctx.reply(`🚀 Starting multi-runner for ${vaultWallets.length} wallet(s)...`);
  runner.runAllToday().catch((e) => {
    ctx.reply(`❌ Multi-run error: ${String(e).slice(0, 300)}`);
  });
});

// /auto_stop — stop the running multi-runner
bot.command("auto_stop", (ctx) => {
  if (!runner.state.running) {
    ctx.reply("ℹ️ No run in progress.");
    return;
  }
  runner.stop();
  ctx.reply("🛑 Stop signal sent. Will halt after current action.");
});

// /auto_status — show current runner state
bot.command("auto_status", (ctx) => {
  const s = runner.state;
  if (!s.running) {
    ctx.reply("💤 Runner idle. Use /auto_run to start.");
    return;
  }
  const elapsed = Math.floor((Date.now() - s.startedAt) / 1000);
  ctx.reply(
    `🔄 Running for ${elapsed}s\n` +
    `   Wallet: ${s.currentWallet.slice(0, 10) || "—"}…\n` +
    `   Action: ${s.currentAction || "—"}\n` +
    `   ✅ ${s.completed} | ❌ ${s.failed}`
  );
});

// /auto_reset — reset today's progress for all wallets (re-run from scratch)
bot.command("auto_reset", (ctx) => {
  runner.resetTodayForAll();
  ctx.reply("🔄 Reset today's progress for all wallets. Next /auto_run will start fresh.");
});

// /vault_stats — show vault wallet count and today's progress summary
bot.command("vault_stats", (ctx) => {
  const wallets = vault.listWallets();
  const date = new Date().toISOString().slice(0, 10);
  let doneCount = 0;
  let pendingCount = 0;
  for (const w of wallets) {
    const plan = vault.getDailyPlan(w.id, date);
    if (plan?.status === "done") doneCount++;
    else pendingCount++;
  }
  ctx.reply(
    `💼 Vault: ${wallets.length} wallets\n` +
    `📅 Today (${date}):\n` +
    `   ✅ Done: ${doneCount}\n` +
    `   ⏳ Pending: ${pendingCount}`
  );
});

// ─── Start Cron Jobs (legacy) ──────────────────────────────────────────

startCronJobs((msg) => {
  const chatId = process.env.CHAT_ID;
  if (chatId) {
    bot.telegram.sendMessage(chatId, msg).catch(() => {});
  }
});

// ─── Start AutoScheduler ───────────────────────────────────────────────

const scheduler = new AutoScheduler(runner);
scheduler.start();
console.log("⏰ AutoScheduler initialized");

// ─── Graceful Shutdown ─────────────────────────────────────────────────

const shutdown = () => {
  console.log("Shutting down...");
  scheduler.stop();
  runner.stop();
  bot.stop("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
