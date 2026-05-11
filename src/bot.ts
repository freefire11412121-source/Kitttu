import { Telegraf } from "telegraf";
import { getEnvOrThrow } from "./config.js";
import { ViewpointsClient } from "./api.js";
import { runSurveyCycle, type SurveyResult } from "./survey.js";
import { saveCookies, getCookies, getStats, getRecentSurveys, saveEndpoint, getAllEndpoints } from "./store.js";

let bot: Telegraf | null = null;

function getAllowedChatId(): string {
  return getEnvOrThrow("CHAT_ID");
}

function isAllowed(chatId: number | string): boolean {
  return String(chatId) === getAllowedChatId();
}

function getClient(): ViewpointsClient | null {
  const cookies = getCookies();
  if (!cookies) return null;
  return new ViewpointsClient(cookies);
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
      `/set_cookies <cookies> — Set Facebook cookies\n` +
      `/check — Validate current session\n` +
      `/run — Run survey auto-complete cycle\n` +
      `/programs — List available programs\n` +
      `/status — Show bot stats\n` +
      `/history — Recent survey completions\n` +
      `/points — Check points balance\n` +
      `/profile — Show FB profile info\n\n` +
      `Setup: Copy your Facebook cookies from browser and send them with /set_cookies`
    );
  });

  bot.command("set_cookies", (ctx) => {
    const parts = ctx.message.text.split(" ");
    const newCookies = parts.slice(1).join(" ").trim();
    if (!newCookies) {
      ctx.reply(
        "Usage: /set_cookies <cookie_string>\n\n" +
        "How to get cookies:\n" +
        "1. Open facebook.com in Chrome (logged in)\n" +
        "2. Press F12 → Application tab → Cookies\n" +
        "3. Copy: c_user, xs, datr, fr cookies\n" +
        "4. Format: c_user=XXX;xs=XXX;datr=XXX;fr=XXX"
      );
      return;
    }
    saveCookies(newCookies);
    ctx.reply("Cookies saved. Use /check to validate the session.");
  });

  bot.command("check", async (ctx) => {
    const client = getClient();
    if (!client) {
      ctx.reply("No cookies set. Use /set_cookies <cookies>");
      return;
    }
    ctx.reply("Validating session...");
    const valid = await client.validateCookies();
    if (valid) {
      try {
        const profile = await client.getProfile();
        ctx.reply(`Session valid!\nLogged in as: ${profile.name} (ID: ${profile.id})`);
      } catch {
        ctx.reply("Session is valid but could not fetch profile.");
      }
    } else {
      ctx.reply("Session expired. Get new cookies from browser and use /set_cookies");
    }
  });

  bot.command("profile", async (ctx) => {
    const client = getClient();
    if (!client) {
      ctx.reply("No cookies set. Use /set_cookies <cookies>");
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
      ctx.reply("No cookies set. Use /set_cookies <cookies>");
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
      ctx.reply("No cookies set. Use /set_cookies <cookies>");
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
      ctx.reply("No cookies set. Use /set_cookies <cookies>");
      return;
    }
    try {
      const points = await client.getPointsBalance();
      ctx.reply(`Points balance: ${points}`);
    } catch (e) {
      ctx.reply(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  bot.command("add_endpoint", (ctx) => {
    const parts = ctx.message.text.split(" ");
    if (parts.length < 3) {
      ctx.reply(
        "Usage: /add_endpoint <name> <doc_id> [variables_json]\n\n" +
        "Names: programs, survey_detail, submit, join, points\n\n" +
        "Example:\n/add_endpoint programs 12345678901234567\n" +
        "/add_endpoint survey_detail 98765432109876543 {\"scale\":3}\n\n" +
        "How to find doc_ids:\n" +
        "1. Install HTTP Toolkit on PC\n" +
        "2. Connect phone to HTTP Toolkit\n" +
        "3. Open Viewpoints app on phone\n" +
        "4. Look for POST requests to graph.facebook.com/graphql\n" +
        "5. Copy the doc_id from the request body"
      );
      return;
    }
    const name = parts[1];
    const docId = parts[2];
    const varsJson = parts.slice(3).join(" ").trim() || undefined;
    saveEndpoint(name, docId, varsJson);
    ctx.reply(`Endpoint '${name}' saved with doc_id=${docId}`);
  });

  bot.command("endpoints", (ctx) => {
    const endpoints = getAllEndpoints();
    if (endpoints.length === 0) {
      ctx.reply(
        "No endpoints configured.\n\n" +
        "Use /add_endpoint <name> <doc_id> to add Viewpoints API endpoints.\n" +
        "You need to intercept traffic from the Viewpoints app to find doc_ids."
      );
      return;
    }
    const lines = endpoints.map((e) => `${e.name}: ${e.doc_id}`);
    ctx.reply(`Configured endpoints:\n\n${lines.join("\n")}`);
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
