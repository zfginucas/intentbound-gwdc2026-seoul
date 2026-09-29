export type Sun = string | number | bigint;
export type TransactionStatus = 'pending' | 'confirmed' | 'failed';

export interface ChainEvent {
  name: string;
  args: Record<string, string>;
}

export interface ChainReceipt {
  txHash: string;
  status: TransactionStatus;
  blockNumber?: number;
  energyUsage?: number;
  feeSun?: number;
  events: ChainEvent[];
  error?: string;
  decision?: {
    paid: boolean;
    reasonCode: number;
    reason: string;
  };
}

export interface SessionSnapshot {
  sessionId: string;
  owner: string;
  agent: string;
  totalCapSun: string;
  perPaymentCapSun: string;
  fundedSun: string;
  spentSun: string;
  remainingSun: string;
  expiresAt: number;
  revoked: boolean;
  policyHash: string;
  allowedMerchants: string[];
}

export interface CreateSessionInput {
  sessionId: string;
  agentAddress: string;
  allowedMerchants: string[];
  totalCapSun: Sun;
  perPaymentCapSun: Sun;
  expiresAt: Sun;
  policyHash: string;
  initialFundingSun?: Sun;
}

export interface SpendInput {
  sessionId: string;
  attemptId: string;
  merchant: string;
  amountSun: Sun;
  quoteHash: string;
}

export interface ShastaClient {
  readonly contractAddress: string;
  readonly abi: readonly unknown[];
  getTransactionInfo(txHash: string): Promise<ChainReceipt>;
  waitForTransaction(
    txHash: string,
    options?: { attempts?: number; intervalMs?: number },
  ): Promise<ChainReceipt>;
  getBalance(accountAddress: string): Promise<string>;
  getSession(sessionId: string): Promise<SessionSnapshot | null>;
  getAttemptStatus(sessionId: string, attemptId: string): Promise<number>;
  createSession(policy: CreateSessionInput, ownerPrivateKey: string): Promise<ChainReceipt>;
  fundSession(sessionId: string, amountSun: Sun, ownerPrivateKey: string): Promise<ChainReceipt>;
  attemptSpend(attempt: SpendInput, agentPrivateKey: string): Promise<ChainReceipt>;
  revokeSession(sessionId: string, ownerPrivateKey: string): Promise<ChainReceipt>;
  withdrawSession(sessionId: string, ownerPrivateKey: string): Promise<ChainReceipt>;
}

export const SHASTA_RPC: string;
export const REJECT_REASONS: readonly string[];
export function receiptAfterBroadcast(
  txHash: string,
  poller: (txHash: string) => Promise<ChainReceipt>,
): Promise<ChainReceipt>;
export function decodeReceiptEvents(
  info: { log?: Array<{ address: string; topics: string[]; data?: string }> },
  contractAddress: string,
): ChainEvent[];
export function createShastaClient(options: {
  rpcUrl?: string;
  contractAddress: string;
  tronGridApiKey?: string;
  feeLimitSun?: Sun;
}): ShastaClient;
