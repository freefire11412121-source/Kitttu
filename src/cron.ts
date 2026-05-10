import cron from "node-cron";
import { runFullCycle } from "./tasks.js";
import { getWallets } from "./wallets.js";

export function startCronJobs(notify: (msg: string) => void): void {
  // Every 8 hours: full farming cycle (crates, sync, badges, faucet)
  cron.schedule("0 */8 * * *", async () => {
    notify("⏰ Starting scheduled farming cycle...");
    const wallets = getWallets();
    let totalQe = 0;
    let errors = 0;
    for (const pk of wallets) {
      try {
        const reports = await runFullCycle(pk as `0x${string}`);
        const success = reports.filter((r) => r.success).length;
        const failed = reports.filter((r) => !r.success).length;
        errors += failed;
        notify(`Wallet ${pk.slice(0, 10)}: ${success} ok / ${failed} fail`);
      } catch (e) {
        errors++;
        notify(`Error on wallet: ${String(e).slice(0, 100)}`);
      }
    }
    notify(`✅ Cycle done. ${wallets.length} wallets processed. Errors: ${errors}`);
  });

  // Every 30 minutes: quick sync only
  cron.schedule("*/30 * * * *", async () => {
    const { InceptionClient } = await import("./api.js");
    const { createDacWallet } = await import("./chain.js");
    const wallets = getWallets();
    for (const pk of wallets) {
      try {
        const { account } = createDacWallet(pk as `0x${string}`);
        const client = new InceptionClient(account.address);
        await client.login();
        await client.syncTransactions();
      } catch { /* silent */ }
    }
  });

  console.log("📅 Cron jobs started: full cycle @8h, sync @30m");
}
