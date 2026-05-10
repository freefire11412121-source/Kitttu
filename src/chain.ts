import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  formatEther,
  type Chain,
  type Account,
  type PublicClient,
  type WalletClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DAC_RPC_URL, DAC_CHAIN_ID, EXCHANGE_CONTRACT } from "./config.js";

export const dacChain: Chain = {
  id: DAC_CHAIN_ID,
  name: "DAC Inception Testnet",
  nativeCurrency: { name: "DACC", symbol: "DACC", decimals: 18 },
  rpcUrls: { default: { http: [DAC_RPC_URL] } },
  blockExplorers: { default: { name: "DAC Explorer", url: "https://exptest.dachain.tech" } },
  testnet: true,
};

export function createDacPublicClient(): PublicClient {
  return createPublicClient({ chain: dacChain, transport: http(DAC_RPC_URL) }) as PublicClient;
}

export function createDacWallet(privateKey: `0x${string}`): {
  wallet: WalletClient<Transport, Chain, Account>;
  account: Account;
  publicClient: PublicClient;
} {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({
    account,
    chain: dacChain,
    transport: http(DAC_RPC_URL),
  });
  const publicClient = createDacPublicClient();
  return { wallet, account, publicClient };
}

export async function getBalance(publicClient: PublicClient, address: `0x${string}`): Promise<string> {
  const balance = await publicClient.getBalance({ address });
  return formatEther(balance);
}

export async function sendSelfTransfer(
  wallet: WalletClient<Transport, Chain, Account>,
  account: Account,
  amount = "0.0001"
): Promise<string> {
  const hash = await wallet.sendTransaction({
    to: account.address,
    value: parseEther(amount),
    chain: dacChain,
    account,
  });
  return hash;
}

export async function sendTransferTo(
  wallet: WalletClient<Transport, Chain, Account>,
  account: Account,
  to: `0x${string}`,
  amount = "0.0001"
): Promise<string> {
  const hash = await wallet.sendTransaction({
    to,
    value: parseEther(amount),
    chain: dacChain,
    account,
  });
  return hash;
}

export async function burnDacc(
  wallet: WalletClient<Transport, Chain, Account>,
  account: Account,
  amount: string
): Promise<string> {
  const hash = await wallet.sendTransaction({
    to: EXCHANGE_CONTRACT as `0x${string}`,
    value: parseEther(amount),
    chain: dacChain,
    account,
  });
  return hash;
}
