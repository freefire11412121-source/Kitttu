/**
 * WalletVault — SQLite-backed wallet store with daily progress tracking,
 * plan management, proxy assignment, and run history.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = process.env.VAULT_DB_PATH || path.resolve(process.cwd(), "data", "vault.db");

export interface Wallet {
  id: number;
  address: string;
  privateKey: string;
  proxyUrl: string | null;
  createdAt: string;
}

export interface ProgressRow {
  action: string;
  status: string;
  detail: string;
  ts: string;
}

export interface HistoryRow {
  walletId: number;
  action: string;
  ok: boolean;
  detail: string;
  ts: string;
}

export class WalletVault {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || DB_PATH;
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL UNIQUE,
        private_key TEXT NOT NULL,
        proxy_url TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS daily_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        detail TEXT DEFAULT '',
        ts TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (wallet_id) REFERENCES wallets(id)
      );

      CREATE TABLE IF NOT EXISTS daily_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(wallet_id, date),
        FOREIGN KEY (wallet_id) REFERENCES wallets(id)
      );

      CREATE TABLE IF NOT EXISTS run_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 0,
        detail TEXT DEFAULT '',
        ts TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (wallet_id) REFERENCES wallets(id)
      );

      CREATE TABLE IF NOT EXISTS proxy_health (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proxy_url TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 1,
        ts TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_progress_wallet_date ON daily_progress(wallet_id, date);
      CREATE INDEX IF NOT EXISTS idx_plans_wallet_date ON daily_plans(wallet_id, date);
    `);
  }

  // ─── Wallet CRUD ─────────────────────────────────────────────────────

  listWallets(): Wallet[] {
    const rows = this.db.prepare(
      "SELECT id, address, private_key, proxy_url, created_at FROM wallets ORDER BY id"
    ).all() as any[];
    return rows.map((r) => ({
      id: r.id,
      address: r.address,
      privateKey: r.private_key,
      proxyUrl: r.proxy_url,
      createdAt: r.created_at,
    }));
  }

  addWallet(address: string, privateKey: string, proxyUrl?: string): number {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO wallets (address, private_key, proxy_url) VALUES (?, ?, ?)"
    );
    const result = stmt.run(address.toLowerCase(), privateKey, proxyUrl || null);
    return result.lastInsertRowid as number;
  }

  getPrivateKey(walletId: number): string {
    const row = this.db.prepare("SELECT private_key FROM wallets WHERE id = ?").get(walletId) as any;
    if (!row) throw new Error(`Wallet ${walletId} not found`);
    return row.private_key;
  }

  getWalletProxyUrl(walletId: number): string | null {
    const row = this.db.prepare("SELECT proxy_url FROM wallets WHERE id = ?").get(walletId) as any;
    return row?.proxy_url || null;
  }

  // ─── Daily Progress ──────────────────────────────────────────────────

  progressFor(walletId: number, date: string): ProgressRow[] {
    return this.db.prepare(
      "SELECT action, status, detail, ts FROM daily_progress WHERE wallet_id = ? AND date = ?"
    ).all(walletId, date) as ProgressRow[];
  }

  logAction(walletId: number, date: string, action: string, status: string, detail: string): void {
    this.db.prepare(
      "INSERT INTO daily_progress (wallet_id, date, action, status, detail) VALUES (?, ?, ?, ?, ?)"
    ).run(walletId, date, action, status, detail);
  }

  resetToday(walletId: number, date: string): void {
    this.db.prepare("DELETE FROM daily_progress WHERE wallet_id = ? AND date = ?").run(walletId, date);
    this.db.prepare("DELETE FROM daily_plans WHERE wallet_id = ? AND date = ?").run(walletId, date);
  }

  // ─── Daily Plans ─────────────────────────────────────────────────────

  getDailyPlan(walletId: number, date: string): { planJson: string; status: string } | null {
    const row = this.db.prepare(
      "SELECT plan_json, status FROM daily_plans WHERE wallet_id = ? AND date = ?"
    ).get(walletId, date) as any;
    if (!row) return null;
    return { planJson: row.plan_json, status: row.status };
  }

  saveDailyPlan(walletId: number, date: string, planJson: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO daily_plans (wallet_id, date, plan_json, status) VALUES (?, ?, ?, 'pending')"
    ).run(walletId, date, planJson);
  }

  setPlanStatus(walletId: number, date: string, status: string): void {
    this.db.prepare(
      "UPDATE daily_plans SET status = ? WHERE wallet_id = ? AND date = ?"
    ).run(status, walletId, date);
  }

  // ─── Run History ─────────────────────────────────────────────────────

  addHistory(walletId: number, action: string, ok: boolean, detail: string): void {
    this.db.prepare(
      "INSERT INTO run_history (wallet_id, action, ok, detail) VALUES (?, ?, ?, ?)"
    ).run(walletId, action, ok ? 1 : 0, detail);
  }

  // ─── Proxy Health ────────────────────────────────────────────────────

  proxyHealthRecord(proxyUrl: string, ok: boolean): void {
    this.db.prepare(
      "INSERT INTO proxy_health (proxy_url, ok) VALUES (?, ?)"
    ).run(proxyUrl, ok ? 1 : 0);
  }
}
