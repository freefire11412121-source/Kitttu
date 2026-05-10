export const DAC_RPC_URL = "https://rpctest.dachain.tech";
export const DAC_CHAIN_ID = 21894;
export const DAC_EXPLORER = "https://exptest.dachain.tech";
export const INCEPTION_BASE = "https://inception.dachain.io";
export const INCEPTION_API = `${INCEPTION_BASE}/api/inception`;
export const EXCHANGE_CONTRACT = "0x3691A78bE270dB1f3b1a86177A8f23F89A8Cef24" as const;
export const QE_PER_DACC = 1000;
export const CRATE_COST = 150;
export const DAILY_CRATE_LIMIT = 5;
export const DAILY_QE_CAP = 3000;
export const FAUCET_COOLDOWN_HOURS = 8;
export const REF_CODE = "DAC3875657";

export function getEnvOrThrow(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}
