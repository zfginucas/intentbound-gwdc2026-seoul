import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  evaluateSpend,
  policyHash,
  quoteHash,
  verifyEvidence,
  type DecisionCode,
  type ObservedEvent,
  type SpendPolicy,
  type SpendQuote,
} from "../../policy/src/index.js";
import type { Catalog } from "./catalog.js";
import type { InferenceLedger } from "./usage.js";
import {
  ConfirmedChainFailure,
  PendingChainTransaction,
  PreflightChainError,
} from "./tron-gateway.js";

export interface LiveChainSession {
  owner: string;
  agent: string;
  totalCapSun: string;
  perPaymentCapSun: string;
  spentSun: string;
  remainingSun: string;
  expiresAt: number;
  revoked: boolean;
  policyHash: string;
  allowedMerchants: string[];
}

export interface ChainResult {
  txHash: string;
  event: ObservedEvent;
}

export interface ChainGateway {
  configured: boolean;
  network: string;
  asset: string;
  owner: string | null;
  agent: string | null;
  contractAddress: string | null;
  createSession(input: {
    sessionId: string;
    merchantAddresses: string[];
    totalCapSun: string;
    perPaymentCapSun: string;
    expiresAt: number;
    policyHash: string;
  }): Promise<{ txHash: string }>;
  attemptSpend(input: {
    sessionId: string;
    attemptId: string;
    merchantAddress: string;
    amountSun: string;
    quoteHash: string;
  }): Promise<ChainResult>;
  revokeSession(sessionId: string): Promise<{ txHash: string }>;
  getSession(sessionId: string): Promise<LiveChainSession>;
  getApprovalEvent(txHash: string, sessionId: string): Promise<boolean>;
  getTransactionStatus(txHash: string): Promise<"pending" | "confirmed" | "failed">;
  getEvent(txHash: string, sessionId: string, attemptId: string): Promise<ObservedEvent | null>;
}

interface AttemptRecord {
  id: string;
  quoteId: string;
  quote: SpendQuote;
  quoteHash: string;
  policyRevokedAtAttempt: boolean;
  spentBeforeSun: string;
  remainingBeforeSun: string;
  decision: { atSeconds: number; code: DecisionCode; amountSun: string | null } | null;
  chainEvent: ObservedEvent | null;
  status: "allowed" | "rejected" | "pending" | "error";
  code: string;
  reason: string;
  txHash: string | null;
  timestamp: string;
}

interface SessionRecord {
  id: string;
  policy: SpendPolicy;
  policyHash: string;
  allowedMerchantIds: string[];
  approvalTxHash: string | null;
  revokeTxHash: string | null;
  state: "creating" | "active" | "revoking" | "revoked";
  createdAt: string;
  attempts: AttemptRecord[];
}

export class SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private file: string | null;

  constructor(file: string | null = resolve(process.cwd(), ".runtime/sessions.json")) {
    this.file = file;
    if (file && existsSync(file)) {
      const loaded = JSON.parse(readFileSync(file, "utf8")) as SessionRecord[];
      for (const session of loaded) this.sessions.set(session.id, session);
    }
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): void {
    this.sessions.delete(id);
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = this.file + ".tmp";
    writeFileSync(temp, JSON.stringify([...this.sessions.values()], null, 2));
    renameSync(temp, this.file);
  }

  findOpen(owner: string, nowSeconds: number): SessionRecord | undefined {
    return [...this.sessions.values()].find((session) =>
      session.policy.owner === owner
      && session.state !== "revoked"
      && session.policy.expiresAt > nowSeconds,
    );
  }

  put(session: SessionRecord): void {
    this.sessions.set(session.id, session);
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = this.file + ".tmp";
    writeFileSync(temp, JSON.stringify([...this.sessions.values()], null, 2));
    renameSync(temp, this.file);
  }
}

const createSchema = z.object({
  budgetSun: z.number().int().positive().max(1_000_000_000_000),
  perPaymentCapSun: z.number().int().positive().max(1_000_000_000_000),
  allowedMerchantIds: z.array(z.string()).min(1).max(16),
  expiresAt: z.iso.datetime(),
});

const attemptSchema = z.object({ quoteId: z.enum(["A", "B", "C", "D"]) });

function hexId(): string {
  return "0x" + randomBytes(32).toString("hex");
}

function failed(c: Context, code: string, message: string, status: 400 | 404 | 409 | 502 | 503) {
  return c.json({ error: { code, message } }, status);
}

function sessionView(record: SessionRecord, live: LiveChainSession, gateway: ChainGateway) {
  return {
    id: record.id,
    state: live.revoked ? "revoked" : record.state,
    budgetSun: Number(live.totalCapSun),
    perPaymentCapSun: Number(live.perPaymentCapSun),
    spentSun: Number(live.spentSun),
    remainingSun: Number(live.remainingSun),
    allowedMerchantIds: record.allowedMerchantIds,
    expiresAt: new Date(live.expiresAt * 1000).toISOString(),
    approvalTxHash: record.approvalTxHash,
    revokeTxHash: record.revokeTxHash,
    owner: live.owner,
    agent: live.agent,
    network: gateway.network,
    token: gateway.asset,
    contractAddress: gateway.contractAddress,
    attempts: record.attempts.map(attemptView),
  };
}

function creatingSessionView(record: SessionRecord, gateway: ChainGateway) {
  return {
    id: record.id,
    state: "pending",
    budgetSun: Number(record.policy.totalCapSun),
    perPaymentCapSun: Number(record.policy.perPaymentCapSun),
    spentSun: 0,
    remainingSun: 0,
    allowedMerchantIds: record.allowedMerchantIds,
    expiresAt: new Date(record.policy.expiresAt * 1000).toISOString(),
    approvalTxHash: record.approvalTxHash,
    revokeTxHash: null,
    owner: record.policy.owner,
    agent: record.policy.agent,
    network: gateway.network,
    token: gateway.asset,
    contractAddress: gateway.contractAddress,
    attempts: [],
  };
}

function attemptView(attempt: AttemptRecord) {
  return {
    id: attempt.id,
    quoteId: attempt.quoteId,
    code: attempt.code,
    status: attempt.status,
    reason: attempt.reason,
    txHash: attempt.txHash,
    timestamp: attempt.timestamp,
    merchantAddress: attempt.quote.merchantAddress,
    onChain: attempt.txHash !== null,
    amountSun: attempt.decision?.amountSun ?? String(attempt.quote.totalSun),
    quoteHash: attempt.quoteHash,
  };
}

function reasonText(code: string, amountSun: string | null, capSun: string) {
  const messages: Record<string, string> = {
    APPROVED: "Payment passed the confirmed session policy.",
    REVOKED: "The owner stopped this session before the payment attempt.",
    EXPIRED: "The session expired before the payment attempt.",
    MERCHANT_NOT_ALLOWED: "The recipient address is outside the approved merchant list.",
    OVER_LIMIT: "The fee-inclusive payment exceeds the remaining session budget.",
    PER_PAYMENT_LIMIT: "The fee-inclusive payment exceeds the per-payment limit.",
    INSUFFICIENT_ESCROW: "The session vault does not hold enough test TRX.",
    INVALID_QUOTE: "The quote is missing or does not match its fee breakdown.",
    QUOTE_EXPIRED: "The merchant quote expired before this attempt.",
  };
  if (code === "OVER_LIMIT" && amountSun) {
    return messages[code] + " Amount: " + amountSun + " SUN; cap: " + capSun + " SUN.";
  }
  return messages[code] ?? "The contract rejected this payment with reason " + code + ".";
}

function chainPolicyChecks(record: SessionRecord, live: LiveChainSession) {
  const expected = record.policy;
  return [
    {
      label: "Policy hash matches Shasta",
      passed: live.policyHash.toLowerCase() === record.policyHash.toLowerCase(),
      detail: "The recorded policy is bound to the on-chain session.",
    },
    {
      label: "Owner and agent match",
      passed: live.owner === expected.owner && live.agent === expected.agent,
      detail: "Both signing roles match the approved session.",
    },
    {
      label: "Budget and per-payment limit match",
      passed: live.totalCapSun === String(expected.totalCapSun)
        && live.perPaymentCapSun === String(expected.perPaymentCapSun),
      detail: "The on-chain SUN limits match the human-approved limits.",
    },
    {
      label: "Expiry matches",
      passed: live.expiresAt === expected.expiresAt,
      detail: "The on-chain deadline matches the approved deadline.",
    },
    {
      label: "Merchant allowlist matches",
      passed: JSON.stringify([...live.allowedMerchants].sort())
        === JSON.stringify([...expected.allowedMerchantAddresses].sort()),
      detail: "The on-chain payee addresses match the confirmed allowlist.",
    },
  ];
}

function chainPolicyMatches(record: SessionRecord, live: LiveChainSession): boolean {
  return chainPolicyChecks(record, live).every((check) => check.passed);
}

export function registerChainRoutes(
  app: Hono,
  deps: { catalog: Catalog; gateway: ChainGateway; ledger: InferenceLedger; store?: SessionStore },
) {
  const { catalog, gateway, ledger } = deps;
  const store = deps.store ?? new SessionStore();

  async function reconcile(record: SessionRecord, live: LiveChainSession): Promise<void> {
    let changed = false;
    if (record.state === "creating") {
      record.state = "active";
      changed = true;
    }
    if (record.state === "revoking" && live.revoked) {
      record.state = "revoked";
      changed = true;
    } else if (record.state === "revoking" && record.revokeTxHash) {
      const status = await gateway.getTransactionStatus(record.revokeTxHash);
      if (status === "failed") {
        record.state = "active";
        record.revokeTxHash = null;
        changed = true;
      }
    }

    for (const attempt of record.attempts) {
      if (attempt.status !== "pending" || !attempt.txHash) continue;
      const event = await gateway.getEvent(attempt.txHash, record.id, attempt.id);
      if (!event) {
        const status = await gateway.getTransactionStatus(attempt.txHash);
        if (status === "failed") {
          attempt.status = "error";
          attempt.code = "CHAIN_TX_FAILED";
          attempt.reason = "Shasta confirmed this transaction as failed; no payment event was recorded.";
          changed = true;
        }
        continue;
      }
      const code = event.name === "PaymentExecuted" ? "APPROVED" : event.reason;
      const expectedAmount = attempt.decision?.amountSun ?? String(attempt.quote.totalSun);
      const matched =
        code === attempt.decision?.code
        && String(event.amountSun) === expectedAmount
        && event.merchantAddress === attempt.quote.merchantAddress
        && event.quoteHash.toLowerCase() === attempt.quoteHash.toLowerCase();
      attempt.chainEvent = event;
      attempt.decision = {
        atSeconds: attempt.decision?.atSeconds ?? Math.floor(Date.now() / 1000),
        code: code as DecisionCode,
        amountSun: expectedAmount,
      };
      attempt.status = !matched ? "error" : code === "APPROVED" ? "allowed" : "rejected";
      attempt.code = !matched ? "POLICY_CHAIN_MISMATCH" : code === "APPROVED" ? "PAYMENT_EXECUTED" : String(code);
      attempt.reason = !matched
        ? "The stored policy preview and confirmed chain event differ."
        : reasonText(String(code), expectedAmount, String(record.policy.totalCapSun));
      changed = true;
    }
    if (changed) store.put(record);
  }

  app.get("/api/usage", (c) =>
    c.json({
      records: ledger.list().map((entry) => ({
        id: entry.id,
        purpose: entry.flow,
        inference: {
          source: entry.source,
          model: entry.model,
          generationId: entry.generationId,
          usage: entry.usage,
          latencyMs: entry.latencyMs,
        },
        createdAt: entry.recordedAt,
      })),
    }),
  );

  app.post("/api/sessions", async (c) => {
    if (!gateway.configured || !gateway.owner || !gateway.agent) {
      return failed(c, "TRON_NOT_CONFIGURED", "Shasta contract and demo testnet wallets are not ready.", 503);
    }
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return failed(c, "VALIDATION_ERROR", "Invalid budget, merchants, or expiry.", 400);
    const input = parsed.data;
    const expiresAt = Math.floor(Date.parse(input.expiresAt) / 1000);
    const now = Math.floor(Date.now() / 1000);
    if (input.perPaymentCapSun > input.budgetSun || expiresAt <= now + 30 || expiresAt > now + 3600) {
      return failed(c, "VALIDATION_ERROR", "The spending cap or expiry is outside demo limits.", 400);
    }
    const ids = [...new Set(input.allowedMerchantIds)];
    if (ids.length !== input.allowedMerchantIds.length) {
      return failed(c, "VALIDATION_ERROR", "Duplicate merchants are not allowed.", 400);
    }
    const merchants = ids.map((id) => catalog.merchants.find((merchant) => merchant.id === id));
    if (merchants.some((merchant) => !merchant || !merchant.allowed)) {
      return failed(c, "VALIDATION_ERROR", "Only approved catalog merchants can be authorized.", 400);
    }
    const open = store.findOpen(gateway.owner, now);
    if (open) {
      const requestedAddresses = merchants.map((merchant) => merchant!.address).sort();
      const existingAddresses = [...open.policy.allowedMerchantAddresses].sort();
      const sameTerms =
        String(input.budgetSun) === String(open.policy.totalCapSun)
        && String(input.perPaymentCapSun) === String(open.policy.perPaymentCapSun)
        && expiresAt === open.policy.expiresAt
        && JSON.stringify(requestedAddresses) === JSON.stringify(existingAddresses);
      if (!sameTerms) {
        return failed(c, "ACTIVE_SESSION_EXISTS", "Stop or wait for the existing session before approving different limits.", 409);
      }
      try {
        const live = await gateway.getSession(open.id);
        if (!chainPolicyMatches(open, live)) {
          return failed(c, "CHAIN_POLICY_MISMATCH", "An existing Shasta policy differs from its recorded authorization.", 502);
        }
        if (open.state === "creating") {
          open.state = "active";
          store.put(open);
        }
        return c.json({ session: sessionView(open, live, gateway) });
      } catch {
        return c.json({ session: creatingSessionView(open, gateway) }, 202);
      }
    }
    const sessionId = hexId();
    const policy: SpendPolicy = {
      sessionId,
      owner: gateway.owner,
      agent: gateway.agent,
      totalCapSun: String(input.budgetSun),
      perPaymentCapSun: String(input.perPaymentCapSun),
      allowedMerchantAddresses: merchants.map((merchant) => merchant!.address),
      expiresAt,
      revoked: false,
    };
    const hash = policyHash(policy);
    const record: SessionRecord = {
      id: sessionId,
      policy,
      policyHash: hash,
      allowedMerchantIds: ids,
      approvalTxHash: null,
      revokeTxHash: null,
      state: "creating",
      createdAt: new Date().toISOString(),
      attempts: [],
    };
    store.put(record);
    try {
      const created = await gateway.createSession({
        sessionId,
        merchantAddresses: policy.allowedMerchantAddresses,
        totalCapSun: String(input.budgetSun),
        perPaymentCapSun: String(input.perPaymentCapSun),
        expiresAt,
        policyHash: hash,
      });
      record.approvalTxHash = created.txHash;
      store.put(record);
      const live = await gateway.getSession(sessionId);
      if (!chainPolicyMatches(record, live)) {
        return failed(c, "CHAIN_POLICY_MISMATCH", "The on-chain policy hash differs from the confirmed policy.", 502);
      }
      record.state = "active";
      store.put(record);
      return c.json({ session: sessionView(record, live, gateway) }, 201);
    } catch (error) {
      if (error instanceof PendingChainTransaction) {
        record.approvalTxHash = error.txHash;
        store.put(record);
        return c.json({ session: creatingSessionView(record, gateway) }, 202);
      }
      if (error instanceof PreflightChainError || error instanceof ConfirmedChainFailure) {
        store.delete(record.id);
        return failed(c, "CHAIN_PREFLIGHT_FAILED", error.message, 503);
      }
      return failed(c, "CHAIN_REQUEST_FAILED", "Shasta could not confirm the session transaction.", 502);
    }
  });

  app.get("/api/sessions/:id", async (c) => {
    const record = store.get(c.req.param("id"));
    if (!record) return failed(c, "SESSION_NOT_FOUND", "No recorded session has this ID.", 404);
    try {
      const live = await gateway.getSession(record.id);
      if (!chainPolicyMatches(record, live)) {
        return failed(c, "CHAIN_POLICY_MISMATCH", "The Shasta policy fields differ from the confirmed authorization.", 502);
      }
      await reconcile(record, live);
      return c.json({ session: sessionView(record, live, gateway) });
    } catch {
      if (record.state === "creating") {
        return c.json({ session: creatingSessionView(record, gateway) }, 202);
      }
      return failed(c, "CHAIN_READ_FAILED", "Could not read the session from Shasta.", 502);
    }
  });

  app.post("/api/sessions/:id/attempts", async (c) => {
    const record = store.get(c.req.param("id"));
    if (!record) return failed(c, "SESSION_NOT_FOUND", "No recorded session has this ID.", 404);
    if (record.state === "creating") return failed(c, "APPROVAL_PENDING", "The Shasta approval has not confirmed.", 409);
    if (record.state === "revoking") return failed(c, "REVOCATION_PENDING", "Session revocation is pending.", 409);
    const parsed = attemptSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return failed(c, "VALIDATION_ERROR", "Provide a known quote ID.", 400);
    if (record.state === "revoked" && parsed.data.quoteId !== "D") {
      return failed(c, "SESSION_REVOKED", "Only the explicit post-stop regression attempt is available after revocation.", 409);
    }
    const existing = record.attempts.find((attempt) => attempt.quoteId === parsed.data.quoteId);
    if (existing) {
      return c.json({ attempt: attemptView(existing), session: null }, existing.status === "pending" ? 202 : 200);
    }
    const catalogQuote = catalog.quotes.find((quote) => quote.id === parsed.data.quoteId);
    if (!catalogQuote) return failed(c, "QUOTE_NOT_FOUND", "The quote does not exist.", 404);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const quote: SpendQuote = {
      quoteId: catalogQuote.id,
      itemId: catalogQuote.itemId,
      merchantAddress: catalogQuote.merchantAddress,
      itemsSun: catalogQuote.itemsSun,
      deliverySun: catalogQuote.deliverySun,
      serviceSun: catalogQuote.serviceSun,
      taxSun: catalogQuote.taxSun,
      discountSun: catalogQuote.discountSun,
      totalSun: catalogQuote.totalSun,
      expiresAt: nowSeconds + 120,
    };
    const qHash = quoteHash(quote);
    const attemptId = hexId();
    const stateAtStart = record.state;
    const attempt: AttemptRecord = {
      id: attemptId,
      quoteId: catalogQuote.id,
      quote,
      quoteHash: qHash,
      policyRevokedAtAttempt: false,
      spentBeforeSun: "0",
      remainingBeforeSun: "0",
      decision: null,
      chainEvent: null,
      status: "pending",
      code: "PENDING",
      reason: "The payment attempt is preparing a Shasta transaction.",
      txHash: null,
      timestamp: new Date().toISOString(),
    };
    record.attempts.push(attempt);
    store.put(record);
    let broadcastMayHaveStarted = false;
    try {
      const liveBefore = await gateway.getSession(record.id);
      if (!chainPolicyMatches(record, liveBefore)) {
        record.attempts = record.attempts.filter((entry) => entry.id !== attemptId);
        store.put(record);
        return failed(c, "CHAIN_POLICY_MISMATCH", "The Shasta policy fields differ from the confirmed authorization.", 502);
      }
      const stateAfterRead = store.get(record.id)?.state;
      if (stateAfterRead === "revoking" || (stateAfterRead === "revoked" && stateAtStart !== "revoked")) {
        record.attempts = record.attempts.filter((entry) => entry.id !== attemptId);
        store.put(record);
        return failed(c, "REVOCATION_PENDING", "The owner stopped this session before the attempt was broadcast.", 409);
      }
      if (stateAtStart === "revoked" && catalogQuote.id !== "D") {
        record.attempts = record.attempts.filter((entry) => entry.id !== attemptId);
        store.put(record);
        return failed(c, "SESSION_REVOKED", "Regular purchases are disabled after revocation.", 409);
      }
      const snapshotPolicy = { ...record.policy, revoked: liveBefore.revoked };
      const preview = evaluateSpend({
        policy: snapshotPolicy,
        quote,
        spentSun: liveBefore.spentSun,
        remainingSun: liveBefore.remainingSun,
        nowSeconds,
      });
      attempt.policyRevokedAtAttempt = liveBefore.revoked;
      attempt.spentBeforeSun = liveBefore.spentSun;
      attempt.remainingBeforeSun = liveBefore.remainingSun;
      attempt.decision = { atSeconds: nowSeconds, code: preview.code, amountSun: preview.amountSun };
      attempt.reason = "The payment attempt is awaiting a Shasta receipt.";
      store.put(record);
      broadcastMayHaveStarted = true;
      const result = await gateway.attemptSpend({
        sessionId: record.id,
        attemptId,
        merchantAddress: quote.merchantAddress,
        amountSun: String(quote.totalSun),
        quoteHash: qHash,
      });
      const code: DecisionCode =
        result.event.name === "PaymentExecuted"
          ? "APPROVED"
          : (result.event.reason as DecisionCode);
      const matched = code === preview.code
        && String(result.event.amountSun) === preview.amountSun
        && result.event.quoteHash.toLowerCase() === qHash.toLowerCase();
      attempt.decision.code = code;
      attempt.chainEvent = result.event;
      attempt.status = !matched ? "error" : code === "APPROVED" ? "allowed" : "rejected";
      attempt.code = !matched ? "POLICY_CHAIN_MISMATCH" : code === "APPROVED" ? "PAYMENT_EXECUTED" : code;
      attempt.reason = !matched
          ? "The local policy preview and on-chain event do not match."
          : reasonText(code, preview.amountSun, String(record.policy.totalCapSun));
      attempt.txHash = result.txHash;
      store.put(record);
      const liveAfter = await gateway.getSession(record.id);
      return c.json({
        attempt: attemptView(attempt),
        session: sessionView(record, liveAfter, gateway),
      });
    } catch (error) {
      const pending = record.attempts.find((attempt) => attempt.id === attemptId);
      if (pending && error instanceof PendingChainTransaction) {
        pending.txHash = error.txHash;
        store.put(record);
        return c.json({ attempt: attemptView(pending), session: null }, 202);
      }
      if (!broadcastMayHaveStarted) {
        record.attempts = record.attempts.filter((entry) => entry.id !== attemptId);
        store.put(record);
      }
      return failed(c, "CHAIN_REQUEST_FAILED", "Shasta could not confirm the payment attempt.", 502);
    }
  });

  app.post("/api/sessions/:id/revoke", async (c) => {
    const record = store.get(c.req.param("id"));
    if (!record) return failed(c, "SESSION_NOT_FOUND", "No recorded session has this ID.", 404);
    if (record.state === "creating") return failed(c, "APPROVAL_PENDING", "The Shasta approval has not confirmed.", 409);
    if (record.state === "revoked") return failed(c, "ALREADY_REVOKED", "This session was already revoked.", 409);
    if (record.state === "revoking") {
      try {
        const live = await gateway.getSession(record.id);
        await reconcile(record, live);
        if (store.get(record.id)?.state === "revoked") {
          return c.json({ session: sessionView(record, live, gateway) });
        }
        return c.json({ session: sessionView(record, live, gateway) }, 202);
      } catch {
        return failed(c, "CHAIN_READ_FAILED", "Revocation remains pending while Shasta is unavailable.", 502);
      }
    }
    record.state = "revoking";
    store.put(record);
    try {
      const revoked = await gateway.revokeSession(record.id);
      record.revokeTxHash = revoked.txHash;
      record.state = "revoked";
      store.put(record);
      const live = await gateway.getSession(record.id);
      return c.json({ session: sessionView(record, live, gateway) });
    } catch (error) {
      if (error instanceof PendingChainTransaction) {
        record.revokeTxHash = error.txHash;
        store.put(record);
        try {
          const live = await gateway.getSession(record.id);
          return c.json({ session: sessionView(record, live, gateway) }, 202);
        } catch {
          return failed(c, "CHAIN_READ_FAILED", "Revocation was broadcast but Shasta cannot be read yet.", 502);
        }
      }
      record.state = "active";
      store.put(record);
      return failed(c, "CHAIN_REQUEST_FAILED", "Shasta could not confirm revocation.", 502);
    }
  });

  app.get("/api/sessions/:id/evidence", (c) => {
    const record = store.get(c.req.param("id"));
    if (!record) return failed(c, "SESSION_NOT_FOUND", "No recorded session has this ID.", 404);
    return c.json({ evidence: record, disclosure: "Merchant quotes and fulfillment are simulated." });
  });

  app.get("/api/sessions/:id/audit", async (c) => {
    const record = store.get(c.req.param("id"));
    if (!record) return failed(c, "SESSION_NOT_FOUND", "No recorded session has this ID.", 404);
    if (record.state === "creating") {
      return c.json({
        audit: {
          sessionId: record.id,
          verdict: "incomplete",
          summary: "The Shasta approval has not confirmed.",
          checks: [{ label: "Approval transaction", passed: null, detail: "No confirmed contract session is available yet." }],
          source: "local",
        },
      });
    }
    try {
      const live = await gateway.getSession(record.id);
      await reconcile(record, live);
      const checks: Array<{ label: string; passed: boolean; detail: string }> = chainPolicyChecks(record, live);
      checks.push({
        label: "Approval transaction contains SessionCreated",
        passed: !!record.approvalTxHash
          && await gateway.getApprovalEvent(record.approvalTxHash, record.id),
        detail: "The on-chain authorization event is linked to this session.",
      });
      for (const attempt of record.attempts) {
        if (attempt.status === "pending" || !attempt.txHash) {
          checks.push({
            label: "Attempt " + attempt.quoteId + " is awaiting confirmation",
            passed: false,
            detail: "No confirmed Shasta decision event is available yet.",
          });
          continue;
        }
        const event = await gateway.getEvent(attempt.txHash, record.id, attempt.id);
        const result = verifyEvidence(
          {
            policy: { ...record.policy, revoked: attempt.policyRevokedAtAttempt },
            quote: attempt.quote,
            policyHash: record.policyHash,
            quoteHash: attempt.quoteHash,
            spentBeforeSun: attempt.spentBeforeSun,
            remainingBeforeSun: attempt.remainingBeforeSun,
            decision: attempt.decision!,
          },
          event,
        );
        checks.push({
          label: "Attempt " + attempt.quoteId + " replays from policy and chain",
          passed: result.verified,
          detail: result.verified ? "Quote, decision, recipient and event match." : result.problems.join(", "),
        });
      }
      const hasPending = record.attempts.some((attempt) => attempt.status === "pending");
      const anyPaid = record.attempts.some((attempt) => attempt.status === "allowed");
      const allPassed = checks.every((check) => check.passed);
      return c.json({
        audit: {
          sessionId: record.id,
          verdict: hasPending ? "incomplete" : !allPassed ? "fail" : anyPaid ? "pass" : "incomplete",
          summary: hasPending
            ? "A Shasta transaction remains unconfirmed."
            : !allPassed
            ? "At least one evidence check failed."
            : anyPaid
              ? "The recorded payment follows the approved financial boundaries."
              : "The session has no completed payment to audit yet.",
          checks,
          source: "mixed",
          disclosure: "Merchant quotes and fulfillment are simulated; Shasta transactions are queried independently.",
        },
      });
    } catch {
      return failed(c, "AUDIT_CHAIN_READ_FAILED", "Shasta evidence could not be read for an independent audit.", 502);
    }
  });
}
