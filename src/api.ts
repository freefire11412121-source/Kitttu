import { INCEPTION_BASE, INCEPTION_API } from "./config.js";

interface Session {
  csrfToken: string;
  sessionId: string;
  walletAddress: string;
}

export interface Profile {
  qe_balance: number;
  waitlist_qe: number;
  streak_days: number;
  dacc_balance: string;
  tx_count: number;
  badges: Array<{
    badge__key: string;
    badge__name: string;
    badge__qe_reward: number;
    earned_at: string;
    nft_tx_hash: string;
  }>;
  faucet_available: boolean;
  faucet_seconds_left: number;
  wallet_address: string;
  username: string;
  referral_count: number;
  referral_code: string;
  qe_multiplier: number;
  qe_multiplier_expires_at: string | null;
  discord_joined: boolean;
  telegram_joined: boolean;
  x_followed: boolean;
  x_linked: boolean;
  discord_linked: boolean;
  email_verified: boolean;
  user_rank: number;
}

export interface CrateResult {
  success: boolean;
  reward: {
    label: string;
    type: string;
    amount: number;
    multiplier: number | null;
    hours: number | null;
    dacc: number;
    tx_hash: string;
  };
  cost: number;
  new_total_qe: number;
  opens_today: number;
  qe_today: number;
  daily_open_limit: number;
  daily_qe_cap: number;
}

export interface SyncResult {
  success: boolean;
  dacc_balance: string;
  tx_count: number;
}

function parseCookies(setCookieHeaders: string[]): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const header of setCookieHeaders) {
    const [pair] = header.split(";");
    const [key, val] = pair.split("=");
    if (key && val) cookies[key.trim()] = val.trim();
  }
  return cookies;
}

export class InceptionClient {
  private csrfToken = "";
  private sessionId = "";
  private walletAddress: string;

  constructor(walletAddress: string) {
    this.walletAddress = walletAddress.toLowerCase();
  }

  private cookieHeader(): string {
    const parts: string[] = [];
    if (this.csrfToken) parts.push(`csrftoken=${this.csrfToken}`);
    if (this.sessionId) parts.push(`sessionid=${this.sessionId}`);
    return parts.join("; ");
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST" = "GET",
    body?: unknown
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${INCEPTION_API}${path}`;
    const headers: Record<string, string> = {
      Cookie: this.cookieHeader(),
      Origin: INCEPTION_BASE,
      Referer: `${INCEPTION_BASE}/`,
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["X-CSRFToken"] = this.csrfToken;
    }
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const cookies = parseCookies(setCookie);
    if (cookies["csrftoken"]) this.csrfToken = cookies["csrftoken"];
    if (cookies["sessionid"]) this.sessionId = cookies["sessionid"];

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }
  }

  async login(): Promise<void> {
    // Step 1: Get CSRF cookie
    const csrfRes = await fetch(`${INCEPTION_BASE}/csrf/`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
    const setCookies = csrfRes.headers.getSetCookie?.() ?? [];
    const cookies = parseCookies(setCookies);
    if (cookies["csrftoken"]) this.csrfToken = cookies["csrftoken"];

    // Step 2: Auth with wallet address
    await this.request<unknown>(
      `${INCEPTION_BASE}/api/auth/wallet/`,
      "POST",
      { wallet_address: this.walletAddress }
    );
  }

  async getProfile(): Promise<Profile> {
    return this.request<Profile>("/profile/");
  }

  async claimFaucet(): Promise<{ success?: boolean; error?: string; tx_hash?: string }> {
    return this.request("/faucet/", "POST", {});
  }

  async syncTransactions(): Promise<SyncResult> {
    return this.request<SyncResult>("/sync/", "POST", {});
  }

  async openCrate(): Promise<CrateResult> {
    return this.request<CrateResult>("/crate/open/", "POST", {});
  }

  async claimBadge(badgeKey: string): Promise<{ success?: boolean; error?: string; qe_awarded?: number; new_total?: number }> {
    return this.request("/claim-badge/", "POST", { badge_key: badgeKey });
  }

  async confirmBurn(txHash: string, amount: string): Promise<{ success?: boolean; error?: string; qe_awarded?: number }> {
    return this.request("/exchange/confirm-burn/", "POST", { tx_hash: txHash, amount });
  }

  async confirmStake(txHash: string, amount: string): Promise<{ success?: boolean; error?: string }> {
    return this.request("/exchange/confirm-stake/", "POST", { tx_hash: txHash, amount });
  }

  async visitExplorer(): Promise<{ success?: boolean; awarded?: boolean }> {
    return this.request("/visit/explorer/", "POST", {});
  }

  async completeTask(task: string, extra?: Record<string, unknown>): Promise<{ success?: boolean; error?: string }> {
    return this.request("/task/", "POST", { task, ...extra });
  }

  async getNftSignature(): Promise<{ signature?: string; error?: string; token_id?: number }> {
    return this.request("/nft/claim-signature/", "POST", {});
  }

  async confirmMint(txHash: string): Promise<{ success?: boolean; error?: string }> {
    return this.request("/nft/confirm-mint/", "POST", { tx_hash: txHash });
  }

  async getCrateHistory(): Promise<{ history: unknown[]; opens_today: number; daily_open_limit: number }> {
    return this.request("/crate/history/");
  }

  async getExchangeHistory(): Promise<{ history: unknown[]; qe_per_dacc: number; exchange_contract: string }> {
    return this.request("/exchange/history/");
  }

  async getNetwork(): Promise<{ block_number: number; tps: number; block_time: number; tx_count: number }> {
    return this.request("/network/");
  }
}
