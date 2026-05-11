# Viewpoints Auto Bot

Telegram bot that automates Meta Viewpoints survey completion using Facebook's cookie-based auth and internal GraphQL API.

## Architecture

```
src/
├── index.ts    — Entry point
├── config.ts   — FB API URLs, User-Agent strings, cron schedules
├── api.ts      — ViewpointsClient (cookie auth + DTSG + GraphQL)
├── survey.ts   — Survey engine (fetch → answer → submit)
├── bot.ts      — Telegram commands
├── cron.ts     — Auto-scheduler (4h checks + 9AM daily report)
└── store.ts    — SQLite (cookies, surveys, stats, endpoints)
```

## Setup

### 1. Environment Variables

```bash
cp .env.example .env
# Fill in:
# BOT_TOKEN — from @BotFather on Telegram
# CHAT_ID — your Telegram user ID
# FB_COOKIES — your Facebook cookies (optional, can set via /set_cookies)
```

### 2. Get Facebook Cookies

1. Open **facebook.com** in Chrome (logged in)
2. Press **F12** → **Application** tab → **Cookies** → `https://www.facebook.com`
3. Copy these cookies: `c_user`, `xs`, `datr`, `fr`
4. Format: `c_user=XXXXX;xs=XXXXX;datr=XXXXX;fr=XXXXX`
5. Send to bot via `/set_cookies <cookies>`

### 3. Install & Run

```bash
npm install
npm run build
npm start
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Show help |
| `/set_cookies <cookies>` | Set Facebook cookies |
| `/check` | Validate session |
| `/profile` | Show FB profile |
| `/programs` | List available surveys |
| `/run` | Auto-complete available surveys |
| `/status` | Show bot stats |
| `/history` | Recent completions |
| `/points` | Check points balance |
| `/add_endpoint <name> <doc_id>` | Add Viewpoints API endpoint |
| `/endpoints` | List configured endpoints |

## Finding Viewpoints API Endpoints

The Viewpoints app uses Facebook's internal GraphQL API with stored query IDs (`doc_id`). To find them:

1. Install **HTTP Toolkit** on your PC (free: httptoolkit.com)
2. Connect your phone to HTTP Toolkit
3. Open the **Viewpoints** app on your phone
4. In HTTP Toolkit, look for **POST** requests to `graph.facebook.com/graphql`
5. The request body contains `doc_id=XXXXXXXXXXXXX` — that's what you need
6. Send to bot: `/add_endpoint programs <doc_id>`

### Endpoint Names

- `programs` — Fetches available surveys/tasks
- `survey_detail` — Gets survey questions for a specific program
- `submit` — Submits survey answers
- `join` — Joins a program
- `points` — Gets points balance

## How Answer Generation Works

- **Multiple choice**: Random option selection
- **Rating (1-5)**: Biased toward positive (3-5 range)
- **Yes/No**: Random 50/50
- **Free text**: Pre-written realistic responses (positive bias)
- **Slider**: Middle-to-high range with variance
- **Human delays**: 2-8s between questions, 10-30s between surveys

## Deploy to Railway

```bash
railway login
railway init
railway up
```

Set environment variables in Railway dashboard: `BOT_TOKEN`, `CHAT_ID`, `FB_COOKIES`.

## Docker

```bash
docker build -t viewpoints-bot .
docker run -d --env-file .env viewpoints-bot
```
