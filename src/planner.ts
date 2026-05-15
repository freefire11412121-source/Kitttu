/**
 * Daily Planner — generates a randomized action plan for each wallet.
 *
 * Each wallet gets a unique start time (spread across the configured window)
 * and a shuffled set of actions with random inter-action delays to appear
 * more human-like.
 */

import { WalletVault, type Wallet } from "./vault.js";

export interface PlannedAction {
  name: string;
  kind: "setup" | "xp" | "onchain";
  delayS: number;
}

export interface DailyPlan {
  date: string;
  address: string;
  startMinute: number;
  startTimeLabel: string;
  actions: PlannedAction[];
}

// ─── Action Templates ──────────────────────────────────────────────────

const SETUP_ACTIONS: PlannedAction[] = [
  { name: "login", kind: "setup", delayS: 0 },
];

const XP_ACTIONS: PlannedAction[] = [
  { name: "faucet_claim", kind: "xp", delayS: 2 },
  { name: "visit_explorer", kind: "xp", delayS: 3 },
  { name: "sync_transactions", kind: "xp", delayS: 2 },
  { name: "open_crates", kind: "xp", delayS: 3 },
  { name: "claim_badges", kind: "xp", delayS: 2 },
  { name: "burn_dacc", kind: "xp", delayS: 5 },
];

const ONCHAIN_ACTIONS: PlannedAction[] = [
  { name: "self_transfer_batch", kind: "onchain", delayS: 3 },
  { name: "sync_after_tx", kind: "onchain", delayS: 5 },
];

// ─── Helpers ───────────────────────────────────────────────────────────

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function minuteToLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")} UTC`;
}

// ─── Plan Generation ───────────────────────────────────────────────────

const WINDOW_START = parseInt(process.env.PLAN_WINDOW_START_MINUTE || "15", 10);   // 00:15 UTC
const WINDOW_END = parseInt(process.env.PLAN_WINDOW_END_MINUTE || "1380", 10);     // 23:00 UTC

function generatePlanForWallet(wallet: Wallet, date: string, index: number, total: number): DailyPlan {
  // Spread start times evenly across the window with some jitter
  const windowSize = WINDOW_END - WINDOW_START;
  const slotSize = Math.max(1, Math.floor(windowSize / total));
  const baseMinute = WINDOW_START + (index * slotSize);
  const jitter = randomInt(0, Math.min(slotSize - 1, 30));
  const startMinute = Math.min(baseMinute + jitter, WINDOW_END - 10);

  // Build action list: setup first, then shuffled XP, then onchain
  const xpShuffled = shuffle(XP_ACTIONS).map((a) => ({
    ...a,
    delayS: a.delayS + randomInt(1, 8),
  }));

  const onchainWithDelay = ONCHAIN_ACTIONS.map((a) => ({
    ...a,
    delayS: a.delayS + randomInt(2, 10),
  }));

  const actions: PlannedAction[] = [
    ...SETUP_ACTIONS,
    ...xpShuffled,
    ...onchainWithDelay,
  ];

  return {
    date,
    address: wallet.address,
    startMinute,
    startTimeLabel: minuteToLabel(startMinute),
    actions,
  };
}

/**
 * Generate or load today's plans for all wallets.
 * Plans are persisted in the vault so container restarts don't regenerate them.
 */
export function planForAllWallets(vault: WalletVault): DailyPlan[] {
  const wallets = vault.listWallets();
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const plans: DailyPlan[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const existing = vault.getDailyPlan(wallet.id, date);

    if (existing) {
      try {
        const parsed = JSON.parse(existing.planJson) as DailyPlan;
        plans.push(parsed);
        continue;
      } catch {
        // Corrupted plan, regenerate
      }
    }

    const plan = generatePlanForWallet(wallet, date, i, wallets.length);
    vault.saveDailyPlan(wallet.id, date, JSON.stringify(plan));
    plans.push(plan);
  }

  return plans;
}
