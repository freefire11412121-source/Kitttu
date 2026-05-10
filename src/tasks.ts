import { InceptionClient, type Profile, type CrateResult } from "./api.js";
import { createDacWallet, getBalance, sendSelfTransfer, burnDacc } from "./chain.js";
import { DAILY_CRATE_LIMIT, CRATE_COST } from "./config.js";

export interface TaskReport {
  wallet: string;
  action: string;
  success: boolean;
  detail: string;
}

export async function runFullCycle(privateKey: `0x${string}`): Promise<TaskReport[]> {
  const reports: TaskReport[] = [];
  const { wallet, account, publicClient } = createDacWallet(privateKey);
  const address = account.address;
  const client = new InceptionClient(address);

  // 1. Login
  try {
    await client.login();
    reports.push({ wallet: address, action: "login", success: true, detail: "Authenticated" });
  } catch (e) {
    reports.push({ wallet: address, action: "login", success: false, detail: String(e) });
    return reports;
  }

  // 2. Get Profile
  let profile: Profile;
  try {
    profile = await client.getProfile();
    reports.push({
      wallet: address,
      action: "profile",
      success: true,
      detail: `QE: ${profile.qe_balance} | DACC: ${profile.dacc_balance} | TX: ${profile.tx_count} | Streak: ${profile.streak_days} | Badges: ${profile.badges.length}`,
    });
  } catch (e) {
    reports.push({ wallet: address, action: "profile", success: false, detail: String(e) });
    return reports;
  }

  // 3. Visit explorer task
  try {
    const r = await client.visitExplorer();
    reports.push({ wallet: address, action: "visit_explorer", success: !!r.success, detail: JSON.stringify(r) });
  } catch (e) {
    reports.push({ wallet: address, action: "visit_explorer", success: false, detail: String(e) });
  }

  // 4. Faucet claim (if available)
  if (profile.faucet_available && profile.faucet_seconds_left === 0) {
    try {
      const r = await client.claimFaucet();
      reports.push({ wallet: address, action: "faucet", success: !!r.success, detail: JSON.stringify(r) });
    } catch (e) {
      reports.push({ wallet: address, action: "faucet", success: false, detail: String(e) });
    }
  }

  // 5. Send self-transactions for farming (batch of 5)
  const balance = await getBalance(publicClient, address as `0x${string}`);
  const balanceNum = parseFloat(balance);
  if (balanceNum > 0.01) {
    const txCount = Math.min(5, Math.floor(balanceNum / 0.0002));
    for (let i = 0; i < txCount; i++) {
      try {
        const hash = await sendSelfTransfer(wallet, account);
        reports.push({ wallet: address, action: `tx_${i + 1}`, success: true, detail: hash });
        await sleep(2000);
      } catch (e) {
        reports.push({ wallet: address, action: `tx_${i + 1}`, success: false, detail: String(e) });
        break;
      }
    }
  }

  // 6. Sync transactions
  try {
    const r = await client.syncTransactions();
    reports.push({ wallet: address, action: "sync", success: r.success, detail: `TX count: ${r.tx_count} | DACC: ${r.dacc_balance}` });
  } catch (e) {
    reports.push({ wallet: address, action: "sync", success: false, detail: String(e) });
  }

  // 7. Open crates (up to daily limit, if QE allows)
  const crateHistory = await client.getCrateHistory().catch(() => null);
  const opensToday = crateHistory?.opens_today ?? 0;
  const remainingOpens = DAILY_CRATE_LIMIT - opensToday;

  // Refresh profile to get current QE
  profile = await client.getProfile().catch(() => profile);
  let currentQe = profile.qe_balance;

  for (let i = 0; i < remainingOpens && currentQe >= CRATE_COST; i++) {
    try {
      const r: CrateResult = await client.openCrate();
      currentQe = r.new_total_qe;
      reports.push({
        wallet: address,
        action: `crate_${i + 1}`,
        success: r.success,
        detail: `Got: ${r.reward.label} | Multiplier: ${r.reward.multiplier ?? "none"} | QE now: ${r.new_total_qe}`,
      });
      await sleep(1500);
    } catch (e) {
      reports.push({ wallet: address, action: `crate_${i + 1}`, success: false, detail: String(e) });
      break;
    }
  }

  // 8. Burn DACC for QE (if balance > 1)
  const updatedProfile = await client.getProfile().catch(() => profile);
  const daccBal = parseFloat(updatedProfile.dacc_balance);
  if (daccBal >= 1) {
    const burnAmount = Math.floor(daccBal).toString();
    try {
      const txHash = await burnDacc(wallet, account, burnAmount);
      reports.push({ wallet: address, action: "burn_tx", success: true, detail: `Burned ${burnAmount} DACC | tx: ${txHash}` });
      await sleep(5000);
      const confirm = await client.confirmBurn(txHash, burnAmount);
      reports.push({ wallet: address, action: "burn_confirm", success: !!confirm.success, detail: JSON.stringify(confirm) });
    } catch (e) {
      reports.push({ wallet: address, action: "burn", success: false, detail: String(e) });
    }
  }

  // 9. Claim all available badges
  const allBadgeKeys = ALL_BADGE_KEYS;
  const earnedKeys = new Set(profile.badges.map((b) => b.badge__key));
  for (const key of allBadgeKeys) {
    if (earnedKeys.has(key)) continue;
    try {
      const r = await client.claimBadge(key);
      if (r.success) {
        reports.push({ wallet: address, action: `badge_${key}`, success: true, detail: `+${r.qe_awarded} QE` });
      }
      await sleep(500);
    } catch {
      // Silently skip failed badges
    }
  }

  return reports;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ALL_BADGE_KEYS = [
  "rank_cadet", "rank_commando", "rank_seal", "rank_shadow", "rank_vanguard",
  "rank_sentinel", "rank_sovereign", "rank_warrior", "rank_architect",
  "rank_interceptor", "rank_phantom", "rank_cipher", "rank_crown",
  "sys_signin", "onb_claim_2x_day", "onb_claim_3x_consec",
  "hold_5", "hold_10", "hold_25", "hold_50", "hold_75", "hold_100",
  "sys_faucet", "fct_10", "fct_20", "fct_30", "fct_40", "fct_3day_row",
  "sys_tx_first", "tx_3", "tx_5", "sys_tx_10", "tx_25", "sys_tx_50",
  "tx_3_wallets", "tx_receive",
  "oc_first_swap", "oc_bridge_tokens", "oc_liquidity", "oc_nft_minter", "oc_multi_sig",
  "str_3day", "str_7day", "str_14day", "str_21day", "str_30day",
  "sys_email", "sys_discord", "sys_telegram", "sys_follow_x", "sys_x_follow",
  "soc_share_weekly", "soc_quote_weekly", "soc_screenshot", "soc_reply",
  "soc_tag_friend", "soc_retweet_launch",
  "soc_invite_1", "soc_squad", "soc_ambassador", "ref_25", "ref_50",
  "exp_faucet", "exp_leaderboard", "exp_badges", "exp_explorer",
  "sys_early_badge",
  "lb_top_500", "lb_top_100", "lb_top_50", "lb_top_10", "lb_climb_50", "lb_overtake_24h",
  "meta_first_badge", "meta_5_badges", "meta_10_badges", "meta_15_badges",
  "meta_all_categories", "meta_20_badges",
  "qe_500",
  "crate_1", "crate_5", "crate_10", "crate_25", "crate_50", "crate_100", "crate_150",
  "crate_5_in_day", "crate_streak_2", "crate_streak_7", "crate_streak_30", "crate_swap",
  "stake_qe_pool", "stake_daily_5", "stake_daily_14",
  "login_3_consec", "login_7_distinct", "login_14_distinct", "login_21_distinct", "login_30_distinct",
  "wk_claim_7", "wk_5_tx", "wk_share_x", "wk_refer_1", "wk_login_5",
];
