import { Telegraf } from "telegraf";
import { getEnvOrThrow } from "./config.js";
import { runFullCycle, type TaskReport } from "./tasks.js";
import { InceptionClient } from "./api.js";
import { createDacWallet, getBalance, burnDacc } from "./chain.js";
import { getWallets, addWallet } from "./wallets.js";
import { ALL_BADGE_KEYS } from "./badge-keys.js";

let bot: Telegraf | null = null;

function getAllowedChatId(): string {
  return getEnvOrThrow("CHAT_ID");
}

function isAllowed(chatId: number | string): boolean {
  return String(chatId) === getAllowedChatId();
}

function formatReports(reports: TaskReport[]): string {
  if (reports.length === 0) return "No actions taken.";
  const lines = reports.map(
    (r) => `${r.success ? "✓" : "✗"} [${r.action}] ${r.detail.slice(0, 100)}`
  );
  return lines.join("\n");
}

export function startBot(): Telegraf {
  const token = getEnvOrThrow("BOT_TOKEN");
  bot = new Telegraf(token);

  bot.use((ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !isAllowed(chatId)) {
      ctx.reply("Unauthorized.");
      return;
    }
    return next();
  });

  bot.command("start", (ctx) => {
    ctx.reply(
      `DAC Airdrop Bot 🤖\n\nCommands:\n/run — Run full farming cycle\n/status — Show wallet stats\n/balance — Check DACC balance\n/sync — Sync transactions\n/crate — Open crates (max daily)\n/burn <amount> — Burn DACC for QE\n/badges — Claim all badges\n/wallets — List wallets\n/add_wallet <key> — Add wallet`
    );
  });

  bot.command("status", async (ctx) => {
    const wallets = getWallets();
    if (wallets.length === 0) {
      ctx.reply("No wallets configured. Use /add_wallet <private_key>");
      return;
    }
    const lines: string[] = [];
    for (const pk of wallets) {
      try {
        const { account, publicClient } = createDacWallet(pk as `0x${string}`);
        const client = new InceptionClient(account.address);
        await client.login();
        const profile = await client.getProfile();
        const bal = await getBalance(publicClient, account.address);
        lines.push(
          `📊 ${account.address.slice(0, 8)}...${account.address.slice(-4)}\n` +
          `   QE: ${profile.qe_balance} | DACC: ${bal} | TX: ${profile.tx_count}\n` +
          `   Streak: ${profile.streak_days}d | Badges: ${profile.badges.length} | Rank: #${profile.user_rank}`
        );
      } catch (e) {
        lines.push(`❌ Error: ${String(e).slice(0, 80)}`);
      }
    }
    ctx.reply(lines.join("\n\n"), { parse_mode: undefined });
  });

  bot.command("balance", async (ctx) => {
    const wallets = getWallets();
    const lines: string[] = [];
    for (const pk of wallets) {
      const { account, publicClient } = createDacWallet(pk as `0x${string}`);
      const bal = await getBalance(publicClient, account.address);
      lines.push(`${account.address.slice(0, 10)}... → ${bal} DACC`);
    }
    ctx.reply(lines.join("\n") || "No wallets.");
  });

  bot.command("run", async (ctx) => {
    const wallets = getWallets();
    if (wallets.length === 0) {
      ctx.reply("No wallets. Use /add_wallet <private_key>");
      return;
    }
    ctx.reply(`Running full cycle for ${wallets.length} wallet(s)...`);
    for (const pk of wallets) {
      try {
        const reports = await runFullCycle(pk as `0x${string}`);
        const msg = formatReports(reports);
        await ctx.reply(`Wallet done:\n${msg.slice(0, 4000)}`);
      } catch (e) {
        await ctx.reply(`Error: ${String(e).slice(0, 300)}`);
      }
    }
    ctx.reply("✅ Full cycle complete.");
  });

  bot.command("sync", async (ctx) => {
    const wallets = getWallets();
    for (const pk of wallets) {
      const { account } = createDacWallet(pk as `0x${string}`);
      const client = new InceptionClient(account.address);
      await client.login();
      const r = await client.syncTransactions();
      ctx.reply(`Sync ${account.address.slice(0, 10)}: TX=${r.tx_count} DACC=${r.dacc_balance}`);
    }
  });

  bot.command("crate", async (ctx) => {
    const wallets = getWallets();
    for (const pk of wallets) {
      const { account } = createDacWallet(pk as `0x${string}`);
      const client = new InceptionClient(account.address);
      await client.login();
      const history = await client.getCrateHistory().catch(() => null);
      const remaining = 5 - (history?.opens_today ?? 0);
      const results: string[] = [];
      for (let i = 0; i < remaining; i++) {
        try {
          const r = await client.openCrate();
          results.push(`${r.reward.label}${r.reward.multiplier ? ` (${r.reward.multiplier}x boost!)` : ""}`);
        } catch (e) {
          results.push(`Error: ${String(e).slice(0, 60)}`);
          break;
        }
      }
      ctx.reply(
        `🎁 Crates ${account.address.slice(0, 10)}:\n${results.join("\n") || "No opens available"}`
      );
    }
  });

  bot.command("burn", async (ctx) => {
    const amount = ctx.message.text.split(" ")[1];
    if (!amount) {
      ctx.reply("Usage: /burn <amount>");
      return;
    }
    const wallets = getWallets();
    for (const pk of wallets) {
      const { wallet, account } = createDacWallet(pk as `0x${string}`);
      const client = new InceptionClient(account.address);
      await client.login();
      try {
        const txHash = await burnDacc(wallet, account, amount);
        await new Promise((r) => setTimeout(r, 5000));
        const confirm = await client.confirmBurn(txHash, amount);
        ctx.reply(`🔥 Burned ${amount} DACC → ${confirm.qe_awarded ?? "?"} QE | tx: ${txHash.slice(0, 20)}...`);
      } catch (e) {
        ctx.reply(`Burn error: ${String(e).slice(0, 200)}`);
      }
    }
  });

  bot.command("badges", async (ctx) => {
    const wallets = getWallets();
    for (const pk of wallets) {
      const { account } = createDacWallet(pk as `0x${string}`);
      const client = new InceptionClient(account.address);
      await client.login();
      const profile = await client.getProfile();
      const earned = new Set(profile.badges.map((b) => b.badge__key));
      let claimed = 0;
      let qeGained = 0;
      for (const key of ALL_BADGE_KEYS) {
        if (earned.has(key)) continue;
        try {
          const r = await client.claimBadge(key);
          if (r.success) {
            claimed++;
            qeGained += r.qe_awarded ?? 0;
          }
        } catch { /* skip */ }
      }
      ctx.reply(`🏅 ${account.address.slice(0, 10)}: Claimed ${claimed} new badges (+${qeGained} QE)`);
    }
  });

  bot.command("wallets", (ctx) => {
    const wallets = getWallets();
    if (wallets.length === 0) {
      ctx.reply("No wallets configured.");
      return;
    }
    const lines = wallets.map((pk, i) => {
      const { account } = createDacWallet(pk as `0x${string}`);
      return `${i + 1}. ${account.address}`;
    });
    ctx.reply(`Wallets (${wallets.length}):\n${lines.join("\n")}`);
  });

  bot.command("add_wallet", (ctx) => {
    const key = ctx.message.text.split(" ")[1];
    if (!key || !key.startsWith("0x") || key.length !== 66) {
      ctx.reply("Usage: /add_wallet 0x<64hex>");
      return;
    }
    addWallet(key);
    const { account } = createDacWallet(key as `0x${string}`);
    ctx.reply(`Added: ${account.address}`);
  });

  bot.launch();
  console.log("🤖 DAC Airdrop Bot started");
  return bot;
}

export function stopBot(): void {
  bot?.stop();
}
