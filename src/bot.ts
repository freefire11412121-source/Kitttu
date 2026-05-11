import { Telegraf } from "telegraf";
import { getEnvOrThrow } from "./config.js";
import { ViewpointsClient } from "./api.js";
import { runSurveyCycle, type SurveyResult } from "./survey.js";
import { saveToken, getToken, getStats, getRecentSurveys } from "./store.js";

let bot: Telegraf | null = null;

function getAllowedChatId(): string {
  return getEnvOrThrow("CHAT_ID");
}

function isAllowed(chatId: number | string): boolean {
  return String(chatId) === getAllowedChatId();
}

function getClient(): ViewpointsClient | null {
  const token = getToken();
  if (!token) return null;
  return new ViewpointsClient(token);
}

function formatResults(results: SurveyResult[]): string {
  if (results.length === 0) return "No new surveys found.";
  const lines = results.map(
    (r) =>
      `${r.success ? "✓" : "✗"} ${r.title}\n   ${
        r.success ? `+${r.pointsEarned} pts` : `Error: ${r.error?.slice(0, 80) ?? "unknown"}`
      }`
  );
  const totalPts = results
    .filter((r) => r.success)
    .reduce((sum, r) => sum + r.pointsEarned, 0);
  lines.push(`\nTotal earned: ${totalPts} pts | Completed: ${results.filter((r) => r.success).length}/${results.length}`);
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
      `Viewpoints Auto Bot\n\n` +
      `Commands:\n` +
      `/set_token <token> — Set Facebook access token\n` +
      `/check_token — Validate current token\n` +
      `/run — Run survey auto-complete cycle\n` +
      `/programs — List available programs\n` +
      `/status — Show bot stats\n` +
      `/history — Recent survey completions\n` +
      `/points — Check points balance\n` +
      `/profile — Show FB profile info\n\n` +
      `Setup: Extract your Facebook access token from the Viewpoints app and send it with /set_token`
    );
  });

  bot.command("set_token", (ctx) => {
    const parts = ctx.message.text.split(" ");
    const newToken = parts.slice(1).join(" ").trim();
    if (!newToken) {
      ctx.reply(
        "Usage: /set_token <facebook_access_token>\n\n" +
        "How to get your token:\n" +
        "1. Install HTTP Toolkit or mitmproxy on your PC\n" +
        "2. Connect your phone through the proxy\n" +
        "3. Open Viewpoints app and look for requests to graph.facebook.com\n" +
        "4. Copy the access_token parameter from any request"
      );
      return;
    }
    saveToken(newToken);
    ctx.reply("Token saved. Use /check_token to validate it.");
  });

  bot.command("check_token", async (ctx) => {
    const client = getClient();
    if (!client) {
      ctx.reply("No token set. Use /set_token <token>");
      return;
    }
    ctx.reply("Validating token...");
    const valid = await client.validateToken();
    if (valid) {
      try {
        const profile = await client.getProfile();
        ctx.reply(`Token valid!\nLogged in as: ${profile.name} (ID: ${profile.id})`);
      } catch {
        ctx.reply("Token is valid but could not fetch profile.");
      }
    } else {
      ctx.reply("Token is invalid or expired. Please get a new one and use /set_token");
    }
  });

  bot.command("profile", async (ctx) => {
    const client = getClient();
    if (!client) {
      ctx.reply("No token set. Use /set_token <token>");
      return;
    }
    try {
      const profile = await client.getProfile();
      const points = await client.getPointsBalance();
      ctx.reply(
        `Profile:\n` +
        `Name: ${profile.name}\n` +
        `ID: ${profile.id}\n` +
        `Points: ${points}`
      );
    } catch (e) {
      ctx.reply(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  bot.command("programs", async (ctx) => {
    const client = getClient();
    if (!client) {
      ctx.reply("No token set. Use /set_token <token>");
      return;
    }
    ctx.reply("Fetching programs...");
    try {
      const programs = await client.getAvailablePrograms();
      if (programs.length === 0) {
        ctx.reply("No programs available right now. Check back later.");
        return;
      }
      const lines = programs.map(
        (p) =>
          `[${p.status}] ${p.name}\n   Type: ${p.type} | Points: ${p.points_reward}${
            p.expires_at ? ` | Expires: ${p.expires_at}` : ""
          }`
      );
      ctx.reply(`Programs (${programs.length}):\n\n${lines.join("\n\n")}`);
    } catch (e) {
      ctx.reply(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  bot.command("run", async (ctx) => {
    const client = getClient();
    if (!client) {
      ctx.reply("No token set. Use /set_token <token>");
      return;
    }
    ctx.reply("Starting survey auto-complete cycle...");
    try {
      const results = await runSurveyCycle(client);
      const msg = formatResults(results);
      await ctx.reply(msg);
    } catch (e) {
      ctx.reply(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  bot.command("status", (ctx) => {
    const stats = getStats();
    ctx.reply(
      `Bot Status:\n` +
      `Surveys completed: ${stats.total_surveys}\n` +
      `Total points earned: ${stats.total_points}\n` +
      `Last check: ${stats.last_check ?? "never"}\n` +
      `Last completion: ${stats.last_complete ?? "never"}`
    );
  });

  bot.command("history", (ctx) => {
    const surveys = getRecentSurveys(10);
    if (surveys.length === 0) {
      ctx.reply("No survey history yet.");
      return;
    }
    const lines = surveys.map(
      (s) =>
        `${s.status === "completed" ? "✓" : "○"} ${s.title}\n   ${s.points} pts | ${
          s.completed_at ?? "pending"
        }`
    );
    ctx.reply(`Recent Surveys:\n\n${lines.join("\n\n")}`);
  });

  bot.command("points", async (ctx) => {
    const client = getClient();
    if (!client) {
      ctx.reply("No token set. Use /set_token <token>");
      return;
    }
    try {
      const points = await client.getPointsBalance();
      ctx.reply(`Points balance: ${points}`);
    } catch (e) {
      ctx.reply(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  bot.launch();
  console.log("Telegram bot started");
  return bot;
}

export function sendNotification(message: string): void {
  if (!bot) return;
  const chatId = process.env.CHAT_ID;
  if (chatId) {
    bot.telegram.sendMessage(chatId, message).catch(() => {});
  }
}
