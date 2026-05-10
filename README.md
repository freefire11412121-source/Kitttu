# DAC Airdrop Bot

Automated farming bot for DAC Chain Inception Testnet — earns maximum QE points for future $DAC airdrop.

## Features

- **Multi-wallet** — unlimited wallets, parallel farming
- **Telegram bot** — full control via chat commands
- **Auto-scheduler** — 8h farming cycles + 30min sync
- **All tasks automated:**
  - ✅ Faucet claim (when social linked)
  - ✅ Crate opens (5x daily, 150 QE each)
  - ✅ Self-transfer transactions + sync
  - ✅ Burn DACC → QE (1 DACC = 1000 QE)
  - ✅ QE Pool staking
  - ✅ Badge claiming (105 badges)
  - ✅ Explorer visit task
  - ✅ NFT minting

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your BOT_TOKEN, CHAT_ID, PRIVATE_KEYS
npm run build
npm start
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Show help |
| `/run` | Run full farming cycle |
| `/status` | Wallet stats (QE, DACC, badges) |
| `/balance` | DACC on-chain balance |
| `/sync` | Sync transactions for QE |
| `/crate` | Open daily crates |
| `/burn <amt>` | Burn DACC for QE |
| `/badges` | Claim all available badges |
| `/wallets` | List configured wallets |
| `/add_wallet <key>` | Add new wallet |

## Deploy to Railway

```bash
railway login
railway init
railway up
# Set env vars in Railway dashboard
```

## Chain Info

- **RPC:** `https://rpctest.dachain.tech`
- **Chain ID:** `21894`
- **Explorer:** `https://exptest.dachain.tech`
- **Exchange Contract:** `0x3691A78bE270dB1f3b1a86177A8f23F89A8Cef24`

## Architecture

```
src/
├── index.ts       — Entry point
├── config.ts      — Constants & env
├── api.ts         — Inception portal API client
├── chain.ts       — On-chain (viem) operations
├── tasks.ts       — Full farming cycle logic
├── bot.ts         — Telegraf bot commands
├── cron.ts        — Scheduled jobs
├── wallets.ts     — Wallet management
└── badge-keys.ts  — All 105 badge keys
```
