/**
 * AutoScheduler — Background scheduler that auto-kicks the daily multi-wallet
 * loop at a *random* time each UTC day.
 *
 * How it works:
 * 1. On startup, reads a persisted JSON state file to know if a kickoff time
 *    was already chosen for today. Survives container restarts.
 * 2. If no upcoming kickoff scheduled, picks a random minute inside the
 *    configured window (default 00:15–06:00 UTC) and sleeps until then.
 * 3. When timer fires, calls multiRunner.runAllToday(), then picks a fresh
 *    random time for next UTC day and loops.
 *
 * Why random? To avoid hitting APIs at the exact same time every day (looks bot-like).
 */

import fs from "node:fs";
import path from "node:path";
import { MultiRunner } from "./multi-runner.js";
import { planForAllWallets } from "./planner.js";

// ─── Configuration ─────────────────────────────────────────────────────

const STATE_PATH = process.env.AUTO_SCHEDULE_PATH || path.resolve(process.cwd(), "data", "auto_schedule.json");
const AUTO_RUN_DISABLED = ["1", "true", "yes"].includes((process.env.AUTO_RUN_DISABLED || "0").toLowerCase());

function parseHHMM(raw: string, fallback: [number, number]): [number, number] {
  try {
    const [h, m] = raw.split(":").map(Number);
    if (h >= 0 && h < 24 && m >= 0 && m < 60) return [h, m];
    return fallback;
  } catch {
    return fallback;
  }
}

function getWindowBounds(): { start: [number, number]; end: [number, number] } {
  const start = parseHHMM(process.env.AUTO_RUN_WINDOW_START || "00:15", [0, 15]);
  const end = parseHHMM(process.env.AUTO_RUN_WINDOW_END || "06:00", [6, 0]);
  return { start, end };
}

// ─── State Persistence ─────────────────────────────────────────────────

interface ScheduleState {
  nextRunIso?: string;
  scheduledForDate?: string;
  decidedAtIso?: string;
  lastRunDate?: string;
}

function loadState(): ScheduleState {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state: ScheduleState): void {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn("[auto_scheduler] cannot persist state:", e);
  }
}

// ─── Random Kickoff Picker ─────────────────────────────────────────────

function pickRandomKickoff(targetDate: string): Date {
  const { start, end } = getWindowBounds();
  const startMin = start[0] * 60 + start[1];
  let endMin = end[0] * 60 + end[1];
  if (endMin <= startMin) endMin = startMin + 1;

  const minute = startMin + Math.floor(Math.random() * (endMin - startMin));
  const h = Math.floor(minute / 60);
  const m = minute % 60;

  return new Date(`${targetDate}T${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:00.000Z`);
}

// ─── AutoScheduler Class ───────────────────────────────────────────────

export class AutoScheduler {
  private runner: MultiRunner;
  private running = false;
  private abortController: AbortController | null = null;

  constructor(runner: MultiRunner) {
    this.runner = runner;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.loop().catch((e) => {
      if (e?.name !== "AbortError") {
        console.error("[auto_scheduler] loop crashed:", e);
      }
    });
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
  }

  private async loop(): Promise<void> {
    if (AUTO_RUN_DISABLED) {
      console.log("[auto_scheduler] DISABLED (AUTO_RUN_DISABLED=1). Manual /run still works.");
      return;
    }

    const { start, end } = getWindowBounds();
    console.log(
      `[auto_scheduler] started — window ${start[0].toString().padStart(2, "0")}:${start[1].toString().padStart(2, "0")}-` +
      `${end[0].toString().padStart(2, "0")}:${end[1].toString().padStart(2, "0")} UTC`
    );

    while (this.running) {
      try {
        const now = new Date();
        const kickoff = this.nextKickoff(now);
        const waitMs = Math.max(0, kickoff.getTime() - now.getTime());

        console.log(
          `[auto_scheduler] next kickoff = ${kickoff.toISOString()} (in ${(waitMs / 3600000).toFixed(1)}h)`
        );

        // Sleep in 60s chunks for responsiveness
        await this.interruptibleSleep(waitMs);

        if (!this.running) return;

        // Check if a manual run is already in progress
        if (this.runner.state.running) {
          console.log("[auto_scheduler] manual run in progress, skipping today's auto kickoff");
          this.markCompleted(kickoff.toISOString().slice(0, 10));
          continue;
        }

        console.log(`[auto_scheduler] kicking daily run for ${kickoff.toISOString().slice(0, 10)}`);

        // Generate plans and run
        planForAllWallets(this.runner.vault);
        try {
          await this.runner.runAllToday();
        } catch (e) {
          console.error("[auto_scheduler] auto-run failed:", e);
        }

        this.markCompleted(kickoff.toISOString().slice(0, 10));
      } catch (e: any) {
        if (e?.name === "AbortError" || !this.running) return;
        console.warn("[auto_scheduler] tick failed:", e);
        await this.interruptibleSleep(60000);
      }
    }
  }

  private nextKickoff(now: Date): Date {
    const state = loadState();

    // Check if we have a saved future kickoff
    if (state.nextRunIso) {
      try {
        const saved = new Date(state.nextRunIso);
        if (saved.getTime() > now.getTime()) {
          return saved;
        }
      } catch { /* fall through */ }
    }

    // Decide target date
    const { end } = getWindowBounds();
    const todayStr = now.toISOString().slice(0, 10);
    const todayEnd = new Date(`${todayStr}T${end[0].toString().padStart(2, "0")}:${end[1].toString().padStart(2, "0")}:00.000Z`);

    let targetDate: string;
    if (now < todayEnd) {
      targetDate = todayStr;
    } else {
      const tomorrow = new Date(now.getTime() + 86400000);
      targetDate = tomorrow.toISOString().slice(0, 10);
    }

    // Pick random time, ensure it's in the future
    let kickoff: Date;
    for (let attempt = 0; attempt < 20; attempt++) {
      kickoff = pickRandomKickoff(targetDate);
      if (kickoff.getTime() > now.getTime()) break;
    }
    kickoff = kickoff!;

    // Fallback: 1 minute from now
    if (kickoff.getTime() <= now.getTime()) {
      kickoff = new Date(now.getTime() + 60000);
    }

    saveState({
      nextRunIso: kickoff.toISOString(),
      scheduledForDate: targetDate,
      decidedAtIso: now.toISOString(),
    });

    return kickoff;
  }

  private markCompleted(dateStr: string): void {
    const state = loadState();
    state.lastRunDate = dateStr;
    delete state.nextRunIso;
    delete state.scheduledForDate;
    saveState(state);
  }

  private async interruptibleSleep(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end && this.running) {
      const chunk = Math.min(60000, end - Date.now());
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, chunk);
        this.abortController?.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }
}
