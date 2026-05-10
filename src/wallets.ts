import fs from "node:fs";
import path from "node:path";
import { generatePrivateKey } from "viem/accounts";

const WALLETS_FILE = path.resolve(process.cwd(), "wallets.json");

export function getWallets(): string[] {
  // Priority: PRIVATE_KEYS env (comma-separated) > wallets.json file
  const envKeys = process.env.PRIVATE_KEYS;
  if (envKeys) {
    return envKeys.split(",").map((k) => k.trim()).filter(Boolean);
  }
  if (fs.existsSync(WALLETS_FILE)) {
    const data = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
    return data.keys ?? [];
  }
  return [];
}

export function addWallet(privateKey: string): void {
  const wallets = getWallets();
  if (wallets.includes(privateKey)) return;
  wallets.push(privateKey);
  fs.writeFileSync(WALLETS_FILE, JSON.stringify({ keys: wallets }, null, 2));
}

export function generateWallets(count: number): string[] {
  const newKeys: string[] = [];
  for (let i = 0; i < count; i++) {
    newKeys.push(generatePrivateKey());
  }
  return newKeys;
}
