/**
 * MultiRunner — orchestrates daily farming across all wallets in phases.
 *
 * PHASE 1 (XP): login, faucet, explorer, crates, badges, burn
 * PHASE 2 (Onchain): self-transfers, sync
 * PHASE 3 (Sweep): retry any failed actions from phases 1 & 2
 *
 * Features:
 * - Configurable parallelism (PARALLEL_WALLETS env, default 1 = sequential)
 * - Per-wallet proxy support
 * - Idempotent: checks daily_progress before re-running actions
 * - Graceful stop via stop()
 * - Telegram notifications for progress
 * - Resume-aware (survives restarts via persisted plans)
 */

import { InceptionClient } from "./api.js";
import { createDacWallet, getBalance, sendSelfTransfer, burnDacc } from "./chain.js";
import { WalletVault, type Wallet } from "./vault.js";
import { planForAllWallets, type DailyPlan, type PlannedAction } from "./planner.js";
import { ALL_BADGE_KEYS } from "./badge-keys.js";
import { DAILY_CRATE_LIMIT, CRATE_COST } from "./config.js";

// ─── Configuration ─────────────────────────────────────────────────────

const PARALLEL_WALLETS = Math.max(1, parseInt(process.env.PARALLEL_WALLETS || "1", 10));
const BATCH_REPORT_EVERY = parseInt(process.env.BATCH_REPORT_EVERY || "25", 10);
const REVERSE_ORDER = ["1", "true", "yes"].includes((process.env.REVERSE_ORDER || "0").toLowerCase());
const PHASE3_SWEEP = !["0", "false", "no"].includes((process.env.PHASE3_SWEEP || "1").toLowerCase());

function getIdBound(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

// ─── Types ─────────────────────────────────────────────────────────────

export interface RunState {
  startedAt: number;
  running: boolean;
  stopFlag: boolean;
  currentWallet: string;
  currentAction: string;
  completed: number;
  failed: number;
}

type NotifyFn = (msg: string) => Promise<void> | void;

// ─── Action Handlers ───────────────────────────────────────────────────

type ActionHandler = (client: InceptionClient, wallet: Wallet, vault: WalletVault) => Promise<{ ok: boolean; detail: string }>;

async function actLogin(client: InceptionClient): Promise<{ ok: boolean; detail: string }> {
  try {
    await client.login();
    return { ok: true, detail: "authenticated" };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  }
}

async function actFaucetClaim(client: InceptionClient): Promise<{ ok: boolean; detail: string }> {
  try {
    const profile = await client.getProfile();
    if (!profile.faucet_available || profile.faucet_seconds_left > 0) {
      return { ok: true, detail: "faucet not available/cooldown" };
    }
    const r = await client.claimFaucet();
    return { ok: !!r.success, detail: JSON.stringify(r).slice(0, 200) };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  }
}

async function actVisitExplorer(client: InceptionClient): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await client.visitExplorer();
    return { ok: !!r.success || !!r.awarded, detail: JSON.stringify(r).slice(0, 200) };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  }
}

async function actSyncTransactions(client: InceptionClient): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await client.syncTransactions();
    return { ok: r.success, detail: `tx=${r.tx_count} dacc=${r.dacc_balance}` };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  }
}

async function actOpenCrates(client: InceptionClient): Promise<{ ok: boolean; detail: string }> {
  try {
    const history = await client.getCrateHistory().catch(() => null);
    const opensToday = history?.opens_today ?? 0;
    const remaining = DAILY_CRATE_LIMIT - opensToday;
    if (remaining <= 0) return { ok: true, detail: "crate limit reached" };

    const profile = await client.getProfile();
    let currentQe = profile.qe_balance;
    let opened = 0;

    for (let i = 0; i < remaining && currentQe >= CRATE_COST; i++) {
      const r = await client.openCrate();
      currentQe = r.new_total_qe;
      opened++;
      await sleep(1500);
    }
    return { ok: true, detail: `opened=${opened} qe_now=${currentQe}` };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  }
}

async function actClaimBadges(client: InceptionClient): Promise<{ ok: boolean; detail: string }> {
  try {
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
        await sleep(500);
      } catch { /* skip */ }
    }
    return { ok: true, detail: `claimed=${claimed} +${qeGained}QE` };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  }
}

async function actBurnDacc(client: InceptionClient, wallet: Wallet): Promise<{ ok: boolean; detail: string }> {
  try {
    const profile = await client.getProfile();
    const daccBal = parseFloat(profile.dacc_balance);
    if (daccBal < 1) return { ok: true, detail: "dacc balance too low to burn" };

    const pk = wallet.privateKey as `0x${string}`;
    const { wallet: walletClient, account } = createDacWallet(pk);
    const burnAmount = Math.floor(daccBal).toString();
    const txHash = await burnDacc(walletClient, account, burnAmount);
    await sleep(5000);
    const confirm = await client.confirmBurn(txHash, burnAmount);
    return { ok: !!confirm.success, detail: `burned=${burnAmount} tx=${txHash.slice(0, 20)}` };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  }
}

async function actSelfTransferBatch(client: InceptionClient, wallet: Wallet): Promise<{ ok: boolean; detail: string }> {
  try {
    const pk = wallet.privateKey as `0x${string}`;
    const { wallet: walletClient, account, publicClient } = createDacWallet(pk);
    const balance = await getBalance(publicClient, account.address as `0x${string}`);
    const balNum = parseFloat(balance);
    if (balNum < 0.01) return { ok: true, detail: "balance too low for tx" };

    const txCount = Math.min(5, Math.floor(balNum / 0.0002));
    let sent = 0;
    for (let i = 0; i < txCount; i++) {
      await sendSelfTransfer(walletClient, account);
      sent++;
      await sleep(2000);
    }
    return { ok: true, detail: `sent=${sent} self-transfers` };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  }
}

// Handler registry
function getHandler(actionName: string): (client: InceptionClient, wallet: Wallet, vault: WalletVault) => Promise<{ ok: boolean; detail: string }> {
  switch (actionName) {
    case "login":
      return (c) => actLogin(c);
    case "faucet_claim":
      return (c) => actFaucetClaim(c);
    case "visit_explorer":
      return (c) => actVisitExplorer(c);
    case "sync_transactions":
    case "sync_after_tx":
      return (c) => actSyncTransactions(c);
    case "open_crates":
      return (c) => actOpenCrates(c);
    case "claim_badges":
      return (c) => actClaimBadges(c);
    case "burn_dacc":
      return (c, w) => actBurnDacc(c, w);
    case "self_transfer_batch":
      return (c, w) => actSelfTransferBatch(c, w);
    default:
      return async () => ({ ok: false, detail: `unknown action: ${actionName}` });
  }
}

// ─── MultiRunner Class ─────────────────────────────────────────────────

export class MultiRunner {
  vault: WalletVault;
  state: RunState;
  private notify: NotifyFn | null = null;

  constructor(vault: WalletVault) {
    this.vault = vault;
    this.state = {
      startedAt: 0,
      running: false,
      stopFlag: false,
      currentWallet: "",
      currentAction: "",
      completed: 0,
      failed: 0,
    };
  }

  attachNotifier(fn: NotifyFn): void {
    this.notify = fn;
  }

  private async say(msg: string): Promise<void> {
    console.log(msg);
    if (this.notify) {
      try { await this.notify(msg); } catch { /* silent */ }
    }
  }

  stop(): void {
    this.state.stopFlag = true;
  }

  private dateUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  // ─── Run for Single Wallet ────────────────────────────────────────

  async runForWallet(
    wallet: Wallet,
    plan: DailyPlan,
    options: {
      kinds?: Set<string>;
      walletIndex?: number;
      totalWallets?: number;
    } = {}
  ): Promise<void> {
    const { kinds, walletIndex = 0, totalWallets = 0 } = options;
    const date = plan.date;
    const progress = this.vault.progressFor(wallet.id, date);
    const doneActions = new Set(progress.filter((p) => p.status === "ok").map((p) => p.action));

    // Filter actions by kind if specified
    const actions = kinds
      ? plan.actions.filter((a) => kinds.has(a.kind))
      : plan.actions;

    if (actions.length === 0) return;

    // Fast-skip if all done
    const pending = actions.filter((a) => !doneActions.has(a.name));
    if (pending.length === 0) {
      console.log(`  ⏭ wallet ${walletIndex}/${totalWallets} ${wallet.address.slice(0, 10)}… — all done`);
      return;
    }

    if (this.state.stopFlag) return;

    const client = new InceptionClient(wallet.address);

    console.log(
      `▶ ${wallet.address.slice(0, 8)}… ${pending.length}/${actions.length} pending` +
      (kinds ? ` [${[...kinds].join(",")}]` : "")
    );

    this.vault.setPlanStatus(wallet.id, date, "running");

    for (let i = 0; i < actions.length; i++) {
      if (this.state.stopFlag) {
        this.vault.setPlanStatus(wallet.id, date, "stopped");
        return;
      }

      const action = actions[i];
      this.state.currentWallet = wallet.address;
      this.state.currentAction = action.name;

      if (doneActions.has(action.name)) {
        continue; // Already done today
      }

      // Pre-action delay
      if (action.delayS > 0) {
        await this.interruptibleSleep(action.delayS * 1000);
        if (this.state.stopFlag) return;
      }

      // Execute
      const handler = getHandler(action.name);
      const t0 = Date.now();
      const { ok, detail } = await handler(client, wallet, this.vault);
      const elapsed = Date.now() - t0;

      // Log
      this.vault.logAction(wallet.id, date, action.name, ok ? "ok" : "fail", detail.slice(0, 500));
      this.vault.addHistory(wallet.id, action.name, ok, detail.slice(0, 200));

      if (ok) this.state.completed++;
      else this.state.failed++;

      const mark = ok ? "✅" : "❌";
      console.log(`  ${mark} ${action.name} (${elapsed}ms) ${detail.slice(0, 120)}`);
    }

    // Mark done if final pass
    const isFinalPass = !kinds || kinds.has("onchain");
    if (isFinalPass) {
      this.vault.setPlanStatus(wallet.id, date, "done");
    }
  }

  // ─── Run All Wallets ──────────────────────────────────────────────

  async runAllToday(options: {
    parallelism?: number;
    idMin?: number | null;
    idMax?: number | null;
  } = {}): Promise<void> {
    if (this.state.running) {
      await this.say("ℹ️ run already in progress");
      return;
    }

    const cap = Math.max(1, options.parallelism ?? PARALLEL_WALLETS);
    this.state = {
      running: true,
      stopFlag: false,
      startedAt: Date.now(),
      completed: 0,
      failed: 0,
      currentWallet: "",
      currentAction: "",
    };

    try {
      let wallets = this.vault.listWallets();
      if (wallets.length === 0) {
        await this.say("No wallets in vault — add some first");
        return;
      }

      const plans = planForAllWallets(this.vault);

      // Apply id-range filter
      const idMin = options.idMin ?? getIdBound("WALLET_ID_MIN");
      const idMax = options.idMax ?? getIdBound("WALLET_ID_MAX");
      let walletPlans = wallets.map((w, i) => ({ wallet: w, plan: plans[i] }));

      if (idMin !== null || idMax !== null) {
        walletPlans = walletPlans.filter(({ wallet: w }) => {
          if (idMin !== null && w.id < idMin) return false;
          if (idMax !== null && w.id > idMax) return false;
          return true;
        });
        await this.say(`🔍 id-filter: ${walletPlans.length}/${wallets.length} wallets (min=${idMin ?? "-"} max=${idMax ?? "-"})`);
      }

      if (REVERSE_ORDER) {
        walletPlans = walletPlans.reverse();
      }

      const totalW = walletPlans.length;
      const date = this.dateUtc();

      // ─── Pre-scan ────────────────────────────────────────────────
      let xpPendingW = 0, onchainPendingW = 0, doneW = 0;
      for (const { wallet: w, plan: p } of walletPlans) {
        const prog = this.vault.progressFor(w.id, date);
        const done = new Set(prog.filter((r) => r.status === "ok").map((r) => r.action));
        const xpLeft = p.actions.filter((a) => ["setup", "xp"].includes(a.kind) && !done.has(a.name)).length;
        const ocLeft = p.actions.filter((a) => a.kind === "onchain" && !done.has(a.name)).length;
        if (xpLeft) xpPendingW++;
        if (ocLeft) onchainPendingW++;
        if (!xpLeft && !ocLeft) doneW++;
      }

      await this.say(
        `📋 daily plan: ${totalW} wallets, parallelism=${cap}\n` +
        `  PHASE 1 (XP): ${xpPendingW} wallets pending\n` +
        `  PHASE 2 (onchain): ${onchainPendingW} wallets pending\n` +
        `  fully-done: ${doneW} wallets`
      );

      // ─── PHASE 1: XP ────────────────────────────────────────────
      await this.say(`🔵 PHASE 1/2 — XP tasks for ${totalW} wallets`);
      await this.runPhase(walletPlans, new Set(["setup", "xp"]), cap, totalW);

      if (this.state.stopFlag) return;

      // ─── PHASE 2: Onchain ────────────────────────────────────────
      await this.say(`🟠 PHASE 2/2 — on-chain tasks for ${totalW} wallets`);
      await this.runPhase(walletPlans, new Set(["onchain"]), cap, totalW);

      if (this.state.stopFlag) return;

      // ─── PHASE 3: Sweep ──────────────────────────────────────────
      if (PHASE3_SWEEP) {
        const stragglers = walletPlans.filter(({ wallet: w, plan: p }) => {
          const prog = this.vault.progressFor(w.id, date);
          const doneOk = new Set(prog.filter((r) => r.status === "ok").map((r) => r.action));
          return p.actions.some((a) => !doneOk.has(a.name));
        });

        if (stragglers.length > 0) {
          await this.say(`🧹 PHASE 3 — sweep: ${stragglers.length} wallets with pending steps`);
          await this.runPhase(stragglers, undefined, cap, totalW);
        } else {
          await this.say("🧹 PHASE 3 — sweep: all wallets clean ✨");
        }
      }

      await this.say(
        `🏁 daily run finished. wallets=${totalW} ok=${this.state.completed} fail=${this.state.failed}`
      );
    } finally {
      this.state.running = false;
      this.state.stopFlag = false;
      this.state.currentWallet = "";
      this.state.currentAction = "";
    }
  }

  // ─── Phase Runner (with semaphore-like parallelism) ───────────────

  private async runPhase(
    walletPlans: Array<{ wallet: Wallet; plan: DailyPlan }>,
    kinds: Set<string> | undefined,
    cap: number,
    totalWallets: number
  ): Promise<void> {
    let running = 0;
    let idx = 0;
    const total = walletPlans.length;

    const runOne = async (wp: { wallet: Wallet; plan: DailyPlan }, i: number): Promise<void> => {
      try {
        await this.runForWallet(wp.wallet, wp.plan, {
          kinds,
          walletIndex: i + 1,
          totalWallets,
        });
      } catch (e) {
        console.error(`wallet ${wp.wallet.address} crashed: ${e}`);
      }

      // Periodic progress beacon
      if ((i + 1) % BATCH_REPORT_EVERY === 0 || i + 1 === total) {
        const elapsed = Math.max(1, (Date.now() - this.state.startedAt) / 1000);
        const rate = ((i + 1) / elapsed * 60).toFixed(1);
        await this.say(
          `📊 ${i + 1}/${total} wallet-passes done · ok=${this.state.completed} fail=${this.state.failed} · rate=${rate}/min`
        );
      }
    };

    if (cap === 1) {
      // Sequential
      for (let i = 0; i < total; i++) {
        if (this.state.stopFlag) break;
        await runOne(walletPlans[i], i);
      }
    } else {
      // Parallel with semaphore
      const queue = walletPlans.map((wp, i) => ({ wp, i }));
      const workers: Promise<void>[] = [];

      for (let w = 0; w < cap; w++) {
        workers.push((async () => {
          while (true) {
            if (this.state.stopFlag) return;
            const item = queue.shift();
            if (!item) return;
            await runOne(item.wp, item.i);
          }
        })());
      }
      await Promise.all(workers);
    }
  }

  // ─── Utilities ────────────────────────────────────────────────────

  private async interruptibleSleep(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end && !this.state.stopFlag) {
      await sleep(Math.min(1000, end - Date.now()));
    }
  }

  resetTodayForAll(idMin?: number | null, idMax?: number | null): void {
    const date = this.dateUtc();
    for (const w of this.vault.listWallets()) {
      if (idMin != null && w.id < idMin) continue;
      if (idMax != null && w.id > idMax) continue;
      this.vault.resetToday(w.id, date);
    }
  }
}

// ─── Helper ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
