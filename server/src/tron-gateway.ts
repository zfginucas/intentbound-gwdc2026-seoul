import {
  createShastaClient,
  REJECT_REASONS,
  type ChainEvent,
  type ChainReceipt,
  type ShastaClient,
} from "../../chain/src/client.mjs";
import type { ChainGateway, ChainResult, LiveChainSession } from "./chain-routes.js";
import type { ObservedEvent } from "../../policy/src/index.js";

const DEMO_OWNER = "TTMWWb3XEtQ3C7i8vBB2xiZShNgWsuEdZK";
const DEMO_AGENT = "TUNZmDHYGUKuk2yQcEn9YVSm8oZRtNbcRj";

function sameHex(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

function attemptEvent(
  events: ChainEvent[],
  sessionId: string,
  attemptId: string,
): ObservedEvent | null {
  const event = events.find((entry) =>
    (entry.name === "PaymentExecuted" || entry.name === "AttemptRejected")
    && sameHex(entry.args.sessionId, sessionId)
    && sameHex(entry.args.attemptId, attemptId),
  );
  if (!event) return null;
  const reason = event.name === "AttemptRejected"
    ? REJECT_REASONS[Number(event.args.reason)] ?? "UNKNOWN"
    : undefined;
  return {
    name: event.name as ObservedEvent["name"],
    sessionId,
    merchantAddress: String(event.args.merchant),
    amountSun: String(event.args.amountSun),
    quoteHash: String(event.args.quoteHash),
    ...(reason ? { reason: reason as ObservedEvent["reason"] } : {}),
  };
}

function confirmed(receipt: ChainReceipt, expectedEvent: string): void {
  if (receipt.status === "pending") {
    throw new PendingChainTransaction(receipt.txHash);
  }
  if (receipt.status === "failed") {
    throw new ConfirmedChainFailure(receipt.txHash);
  }
  if (receipt.status !== "confirmed") {
    throw new Error("Shasta transaction did not confirm: " + receipt.status);
  }
  if (!receipt.events.some((event) => event.name === expectedEvent)) {
    throw new Error("Confirmed Shasta receipt omitted " + expectedEvent);
  }
}

export class PendingChainTransaction extends Error {
  readonly txHash: string;

  constructor(txHash: string) {
    super("Shasta broadcast has not reached a confirmed receipt");
    this.txHash = txHash;
  }
}

export class PreflightChainError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class ConfirmedChainFailure extends Error {
  readonly txHash: string;

  constructor(txHash: string) {
    super("Shasta confirmed the transaction as failed");
    this.txHash = txHash;
  }
}

export class ShastaGateway implements ChainGateway {
  readonly network = "shasta";
  readonly asset = "test TRX";
  readonly owner: string | null;
  readonly agent: string | null;
  readonly contractAddress: string | null;
  readonly configured: boolean;
  readonly configError: string | null;
  private readonly ownerKey: string | null;
  private readonly agentKey: string | null;
  private readonly client: ShastaClient | null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.owner = env.TRON_OWNER_ADDRESS ?? DEMO_OWNER;
    this.agent = env.TRON_AGENT_ADDRESS ?? DEMO_AGENT;
    this.ownerKey = env.TRON_OWNER_PRIVATE_KEY ?? env.OWNER_PRIVATE_KEY ?? null;
    this.agentKey = env.TRON_AGENT_PRIVATE_KEY ?? env.AGENT_PRIVATE_KEY ?? null;
    this.contractAddress = env.TRON_CONTRACT_ADDRESS ?? env.CONTRACT_ADDRESS ?? null;
    let client: ShastaClient | null = null;
    let configError: string | null = null;
    if (this.contractAddress && this.ownerKey && this.agentKey) {
      try {
        client = createShastaClient({
          rpcUrl: env.SHASTA_RPC,
          contractAddress: this.contractAddress,
          tronGridApiKey: env.TRONGRID_API_KEY,
        });
      } catch (error) {
        configError = error instanceof Error ? error.message : "Invalid Shasta configuration";
      }
    }
    this.client = client;
    this.configured = client !== null;
    this.configError = configError;
  }

  private requireClient(): ShastaClient {
    if (!this.client) throw new Error("Shasta contract or demo signing wallets are not configured");
    return this.client;
  }

  async createSession(input: {
    sessionId: string;
    merchantAddresses: string[];
    totalCapSun: string;
    perPaymentCapSun: string;
    expiresAt: number;
    policyHash: string;
  }): Promise<{ txHash: string }> {
    const client = this.requireClient();
    const balanceSun = BigInt(await client.getBalance(this.owner!));
    const requiredSun = BigInt(input.totalCapSun) + 150_000_000n;
    if (balanceSun < requiredSun) {
      throw new PreflightChainError("Demo owner needs test TRX for escrow and Shasta transaction fees");
    }
    const receipt = await client.createSession(
      {
        sessionId: input.sessionId,
        agentAddress: this.agent!,
        allowedMerchants: input.merchantAddresses,
        totalCapSun: input.totalCapSun,
        perPaymentCapSun: input.perPaymentCapSun,
        expiresAt: input.expiresAt,
        policyHash: input.policyHash,
        initialFundingSun: input.totalCapSun,
      },
      this.ownerKey!,
    );
    confirmed(receipt, "SessionCreated");
    return { txHash: receipt.txHash };
  }

  async attemptSpend(input: {
    sessionId: string;
    attemptId: string;
    merchantAddress: string;
    amountSun: string;
    quoteHash: string;
  }): Promise<ChainResult> {
    const receipt = await this.requireClient().attemptSpend(
      {
        sessionId: input.sessionId,
        attemptId: input.attemptId,
        merchant: input.merchantAddress,
        amountSun: input.amountSun,
        quoteHash: input.quoteHash,
      },
      this.agentKey!,
    );
    if (receipt.status === "pending") {
      throw new PendingChainTransaction(receipt.txHash);
    }
    if (receipt.status !== "confirmed") {
      throw new Error("Shasta payment attempt did not confirm: " + receipt.status);
    }
    const event = attemptEvent(receipt.events, input.sessionId, input.attemptId);
    if (!event) throw new Error("Confirmed Shasta attempt has no matching decision event");
    return { txHash: receipt.txHash, event };
  }

  async revokeSession(sessionId: string): Promise<{ txHash: string }> {
    const receipt = await this.requireClient().revokeSession(sessionId, this.ownerKey!);
    confirmed(receipt, "SessionRevoked");
    return { txHash: receipt.txHash };
  }

  async getSession(sessionId: string): Promise<LiveChainSession> {
    const session = await this.requireClient().getSession(sessionId);
    if (!session) throw new Error("Shasta session does not exist");
    return {
      owner: session.owner,
      agent: session.agent,
      totalCapSun: session.totalCapSun,
      perPaymentCapSun: session.perPaymentCapSun,
      spentSun: session.spentSun,
      remainingSun: session.remainingSun,
      expiresAt: session.expiresAt,
      revoked: session.revoked,
      policyHash: session.policyHash,
      allowedMerchants: session.allowedMerchants,
    };
  }

  async getApprovalEvent(txHash: string, sessionId: string): Promise<boolean> {
    const receipt = await this.requireClient().getTransactionInfo(txHash);
    return receipt.status === "confirmed"
      && receipt.events.some((event) =>
        event.name === "SessionCreated" && sameHex(event.args.sessionId, sessionId));
  }

  async getTransactionStatus(txHash: string): Promise<"pending" | "confirmed" | "failed"> {
    const receipt = await this.requireClient().getTransactionInfo(txHash);
    return receipt.status;
  }

  async getEvent(txHash: string, sessionId: string, attemptId: string): Promise<ObservedEvent | null> {
    const receipt = await this.requireClient().getTransactionInfo(txHash);
    if (receipt.status !== "confirmed") return null;
    return attemptEvent(receipt.events, sessionId, attemptId);
  }
}
