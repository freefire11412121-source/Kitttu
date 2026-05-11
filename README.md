# Viewpoints Auto Bot

Automated survey completion bot for Meta Viewpoints — earns points by auto-completing surveys.

## Features

- **Telegram bot** — full control via chat commands
- **Auto-scheduler** — checks for new surveys every 4 hours
- **Smart answers** — generates realistic survey responses
- **Human-like delays** — random timing between actions to avoid detection
- **SQLite storage** — tracks completed surveys, stats, and tokens
- **Daily reports** — automatic status updates at 9 AM

## How It Works

1. You provide your Facebook access token (extracted from the Viewpoints app)
2. Bot uses the token to fetch available surveys from Facebook's API
3. Bot auto-generates realistic answers for each survey question
4. Answers are submitted with human-like delays
5. Points are tracked and reported via Telegram

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your BOT_TOKEN and CHAT_ID
npm run build
npm start
```

## Getting Your Facebook Access Token

The bot needs your Facebook access token from the Viewpoints app. Here's how to get it:

### Method 1: HTTP Toolkit (Recommended)
1. Install [HTTP Toolkit](https://httptoolkit.com/) on your PC
2. Connect your Android phone through HTTP Toolkit
3. Open the Viewpoints app on your phone
4. Look for requests to `graph.facebook.com` in HTTP Toolkit
5. Copy the `access_token` parameter from any request
6. Send it to the bot: `/set_token YOUR_TOKEN_HERE`

### Method 2: mitmproxy
1. Install mitmproxy: `pip install mitmproxy`
2. Run: `mitmweb --listen-port 8080`
3. Configure your phone's WiFi proxy to your PC's IP:8080
4. Install the mitmproxy CA certificate on your phone
5. Open Viewpoints app and capture the access_token

### Method 3: Frida (Rooted devices)
1. Install Frida on your PC and phone
2. Use an SSL pinning bypass script for Meta apps
3. Capture requests with mitmproxy/Burp Suite

> **Note:** Facebook access tokens expire. You'll need to refresh your token periodically. The bot will notify you when the token expires.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Show help |
| `/set_token <token>` | Set Facebook access token |
| `/check_token` | Validate current token |
| `/run` | Run survey auto-complete now |
| `/programs` | List available programs |
| `/status` | Show bot stats |
| `/history` | Recent completions |
| `/points` | Check points balance |
| `/profile` | Show FB profile |

## Deploy to Railway

```bash
railway login
railway init
railway up
# Set env vars in Railway dashboard:
# BOT_TOKEN, CHAT_ID, FB_ACCESS_TOKEN (optional)
```

## Architecture

```
src/
├── index.ts    — Entry point
├── config.ts   — Constants & env
├── api.ts      — Facebook Graph API client for Viewpoints
├── survey.ts   — Survey engine (fetch, answer, submit)
├── bot.ts      — Telegraf bot commands
├── cron.ts     — Scheduled survey checks
└── store.ts    — SQLite storage (tokens, surveys, stats)
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Telegram bot token from BotFather |
| `CHAT_ID` | Yes | Your Telegram chat ID |
| `FB_ACCESS_TOKEN` | No | Facebook token (can also set via /set_token) |
| `ANSWER_MODE` | No | `random` (default) or `smart` |
