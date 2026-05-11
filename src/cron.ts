import cron from "node-cron";
import { SURVEY_CHECK_INTERVAL, DAILY_REPORT_SCHEDULE } from "./config.js";
import { ViewpointsClient } from "./api.js";
import { runSurveyCycle } from "./survey.js";
import { getToken, getStats } from "./store.js";

export function startCronJobs(notify: (msg: string) => void): void {
  // Every 4 hours: check for new surveys and auto-complete
  cron.schedule(SURVEY_CHECK_INTERVAL, async () => {
    const token = getToken();
    if (!token) {
      notify("Skipping scheduled check — no token set. Use /set_token");
      return;
    }

    notify("Checking for new surveys...");
    const client = new ViewpointsClient(token);

    try {
      const results = await runSurveyCycle(client);
      if (results.length === 0) {
        notify("No new surveys available.");
        return;
      }

      const succeeded = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);
      const totalPts = succeeded.reduce((sum, r) => sum + r.pointsEarned, 0);

      let msg = `Survey cycle complete:\n`;
      msg += `Completed: ${succeeded.length} | Failed: ${failed.length}\n`;
      msg += `Points earned: ${totalPts}`;

      if (failed.length > 0) {
        msg += `\n\nErrors:\n`;
        msg += failed
          .map((r) => `- ${r.title}: ${r.error?.slice(0, 80) ?? "unknown"}`)
          .join("\n");
      }

      notify(msg);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (errMsg.includes("invalid") || errMsg.includes("expired")) {
        notify("Token expired! Get a new token and use /set_token");
      } else {
        notify(`Survey check error: ${errMsg.slice(0, 200)}`);
      }
    }
  });

  // Daily report at 9 AM
  cron.schedule(DAILY_REPORT_SCHEDULE, () => {
    const stats = getStats();
    notify(
      `Daily Report:\n` +
      `Total surveys: ${stats.total_surveys}\n` +
      `Total points: ${stats.total_points}\n` +
      `Last check: ${stats.last_check ?? "never"}\n` +
      `Last completion: ${stats.last_complete ?? "never"}`
    );
  });

  console.log("Cron jobs started: survey check @4h, daily report @9AM");
}
