export const FB_GRAPH_URL = "https://graph.facebook.com/v19.0";
export const VP_APP_ID = "726764641754562"; // Viewpoints app ID
export const VP_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 [FBAN/Viewpoints;FBAV/323.0.0.1.109;FBBV/100;FBDM/{density=3.0,width=1080,height=2400};FBLC/en_US;FBRV/0;FBCR/;FBMF/Google;FBBD/google;FBPN/com.facebook.viewpoints;FBDV/Pixel 8 Pro;FBSV/14;FBOP/1;FBCA/armeabi-v7a:armeabi;]";

export const SURVEY_CHECK_INTERVAL = "0 */4 * * *"; // every 4 hours
export const DAILY_REPORT_SCHEDULE = "0 9 * * *"; // 9 AM daily

export function getEnvOrThrow(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

export function getEnvOptional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}
