import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { SessionStore, type ChainGateway, type ChainResult, type LiveChainSession } from "../src/chain-routes.js";
import { InferenceLedger } from "../src/usage.js";
import { PendingChainTransaction } from "../src/tron-gateway.js";
import type { DecisionCode, ObservedEvent } from "../../policy/src/index.js";

const OWNER = "TTMWWb3XEtQ3C7i8vBB2xiZShNgWsuEdZK";
const AGENT = "TUNZmDHYGUKuk2yQcEn9YVSm8oZRtNbcRj";

interface FakeSession {
  live: LiveChainSession;
  allowedAddresses: string[];
}

class FakeChainGateway implements ChainGateway {
  readonly configured = true;
  readonly network = "shasta";
  readonly asset = "test TRX";
  readonly owner = OWNER;
  readonly agent = AGENT;
  readonly contractAddress = "TFakeContractAddressOnlyForTests";
  readonly sessions = new Map<string, FakeSession>();
  private readonly events = new Map<string, { sessionId: string; attemptId: string; event: ObservedEvent }>();
  private sequence = 0;
  omitEvents = false;
  pendingCreateNext = false;
  pendingNext = false;
  pendingRevokeNext = false;
  createCalls = 0;
  attemptCalls = 0;
  revokeCalls = 0;
  readDelayMs = 0;

  private txHash(): string {
    this.sequence += 1;
    return `0x${this.sequence.toString(16).padStart(64, "0")}`;
  }

  async createSession(input: {
    sessionId: string;
    merchantAddresses: string[];
    totalCapSun: string;
    perPaymentCapSun: string;
    expiresAt: number;
    policyHash: string;
  }): Promise<{ txHash: string }> {
    this.createCalls += 1;
    if (this.pendingCreateNext) {
      this.pendingCreateNext = false;
      throw new PendingChainTransaction(this.txHash());
    }
    this.sessions.set(input.sessionId, {
      live: {
        owner: OWNER,
        agent: AGENT,
        totalCapSun: input.totalCapSun,
        perPaymentCapSun: input.perPaymentCapSun,
        spentSun: "0",
        remainingSun: input.totalCapSun,
        expiresAt: input.expiresAt,
        revoked: false,
        policyHash: input.policyHash,
        allowedMerchants: [...input.merchantAddresses],
      },
      allowedAddresses: [...input.merchantAddresses],
    });
    return { txHash: this.txHash() };
  }

  async attemptSpend(input: {
    sessionId: string;
    attemptId: string;
    merchantAddress: string;
    amountSun: string;
    quoteHash: string;
  }): Promise<ChainResult> {
    this.attemptCalls += 1;
    if (this.pendingNext) {
      this.pendingNext = false;
      throw new PendingChainTransaction(this.txHash());
    }
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new Error("Unknown fake session");
    const live = session.live;
    const amount = BigInt(input.amountSun);
    const spent = BigInt(live.spentSun);
    let code: DecisionCode = "APPROVED";
    if (live.revoked) code = "REVOKED";
    else if (Math.floor(Date.now() / 1000) >= live.expiresAt) code = "EXPIRED";
    else if (!session.allowedAddresses.includes(input.merchantAddress)) code = "MERCHANT_NOT_ALLOWED";
    else if (spent + amount > BigInt(live.totalCapSun)) code = "OVER_LIMIT";
    else if (amount > BigInt(live.perPaymentCapSun)) code = "PER_PAYMENT_LIMIT";
    else if (amount > BigInt(live.remainingSun)) code = "INSUFFICIENT_ESCROW";

    if (code === "APPROVED") {
      live.spentSun = String(spent + amount);
      live.remainingSun = String(BigInt(live.remainingSun) - amount);
    }

    const event: ObservedEvent = {
      name: code === "APPROVED" ? "PaymentExecuted" : "AttemptRejected",
      sessionId: input.sessionId,
      merchantAddress: input.merchantAddress,
      amountSun: input.amountSun,
      quoteHash: input.quoteHash,
      ...(code === "APPROVED" ? {} : { reason: code }),
    };
    const txHash = this.txHash();
    this.events.set(txHash, { sessionId: input.sessionId, attemptId: input.attemptId, event });
    return { txHash, event };
  }

  async revokeSession(sessionId: string): Promise<{ txHash: string }> {
    this.revokeCalls += 1;
    if (this.pendingRevokeNext) {
      this.pendingRevokeNext = false;
      throw new PendingChainTransaction(this.txHash());
    }
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Unknown fake session");
    session.live.revoked = true;
    return { txHash: this.txHash() };
  }

  async getSession(sessionId: string): Promise<LiveChainSession> {
    if (this.readDelayMs) await new Promise((resolve) => setTimeout(resolve, this.readDelayMs));
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Unknown fake session");
    return { ...session.live };
  }

  async getEvent(txHash: string, sessionId: string, attemptId: string): Promise<ObservedEvent | null> {
    if (this.omitEvents) return null;
    const record = this.events.get(txHash);
    return record?.sessionId === sessionId && record.attemptId === attemptId ? { ...record.event } : null;
  }

  async getApprovalEvent(_txHash: string, sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId) && !this.omitEvents;
  }

  async getTransactionStatus(txHash: string): Promise<"pending" | "confirmed" | "failed"> {
    return this.events.has(txHash) ? "confirmed" : "pending";
  }

  confirmAttempt(
    txHash: string,
    sessionId: string,
    attemptId: string,
    event: ObservedEvent,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Unknown fake session");
    if (event.name === "PaymentExecuted") {
      session.live.spentSun = String(BigInt(session.live.spentSun) + BigInt(event.amountSun!));
      session.live.remainingSun = String(BigInt(session.live.remainingSun) - BigInt(event.amountSun!));
    }
    this.events.set(txHash, { sessionId, attemptId, event });
  }
}

async function post(app: ReturnType<typeof createApp>, path: string, body: unknown = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function setup() {
  const gateway = new FakeChainGateway();
  const ledger = new InferenceLedger();
  const store = new SessionStore(null);
  const app = createApp({ env: {}, chainGateway: gateway, usageLedger: ledger, sessionStore: store });
  return { app, gateway, ledger, store };
}

function sessionRequest(allowedMerchantIds = ["seoul-bowl", "han-table"]) {
  return {
    budgetSun: 18_000_000,
    perPaymentCapSun: 18_000_000,
    allowedMerchantIds,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

describe("chain lifecycle routes with an in-memory gateway", () => {
  it("replays two boundary failures, one payment, and a post-revocation failure", async () => {
    const { app, gateway, ledger } = setup();
    const status = await (await app.request("/api/status")).json();
    expect(status.chain).toMatchObject({ configured: true, connected: null, network: "shasta", asset: "test TRX" });

    ledger.record("plan", {
      text: "draft response never retained",
      generationId: "generation-route-test",
      usage: { inputTokens: 40, outputTokens: 15, totalTokens: 55 },
      latencyMs: 210,
    });
    const usage = await (await app.request("/api/usage")).json();
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({
      purpose: "plan",
      inference: { source: "kiln", generationId: "generation-route-test", usage: { totalTokens: 55 } },
    });
    expect(JSON.stringify(usage)).not.toContain("draft response never retained");

    const created = await post(app, "/api/sessions", sessionRequest());
    expect(created.status).toBe(201);
    const { session } = await created.json();
    const id = session.id as string;
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(session).toMatchObject({ state: "active", budgetSun: 18_000_000, spentSun: 0, remainingSun: 18_000_000 });
    expect(gateway.sessions.get(id)?.allowedAddresses).toHaveLength(2);

    const expected = [
      { quoteId: "A", code: "OVER_LIMIT", status: "rejected", spentSun: 0 },
      { quoteId: "B", code: "MERCHANT_NOT_ALLOWED", status: "rejected", spentSun: 0 },
      { quoteId: "C", code: "PAYMENT_EXECUTED", status: "allowed", spentSun: 16_000_000 },
    ] as const;
    for (const item of expected) {
      const response = await post(app, `/api/sessions/${id}/attempts`, { quoteId: item.quoteId });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.attempt).toMatchObject({ quoteId: item.quoteId, code: item.code, status: item.status, onChain: true });
      expect(body.attempt.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(body.session.spentSun).toBe(item.spentSun);
    }

    const stopped = await post(app, `/api/sessions/${id}/revoke`);
    expect(stopped.status).toBe(200);
    const stoppedBody = await stopped.json();
    expect(stoppedBody.session.state).toBe("revoked");
    expect(stoppedBody.session.revokeTxHash).toMatch(/^0x[0-9a-f]{64}$/);

    const afterStop = await post(app, `/api/sessions/${id}/attempts`, { quoteId: "D" });
    expect(afterStop.status).toBe(200);
    const rejected = await afterStop.json();
    expect(rejected.attempt).toMatchObject({ quoteId: "D", code: "REVOKED", status: "rejected", amountSun: "1000000" });
    expect(rejected.session.spentSun).toBe(16_000_000);
    expect(rejected.session.remainingSun).toBe(2_000_000);

    const fetched = await (await app.request(`/api/sessions/${id}`)).json();
    expect(fetched.session.attempts.map((attempt: { quoteId: string }) => attempt.quoteId)).toEqual(["A", "B", "C", "D"]);
    const evidence = await (await app.request(`/api/sessions/${id}/evidence`)).json();
    expect(evidence.evidence.attempts).toHaveLength(4);
    expect(evidence.disclosure).toContain("simulated");

    const audit = await (await app.request(`/api/sessions/${id}/audit`)).json();
    expect(audit.audit.verdict).toBe("pass");
    expect(audit.audit.checks).toHaveLength(10);
    expect(audit.audit.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);

    gateway.omitEvents = true;
    const missingEvents = await (await app.request(`/api/sessions/${id}/audit`)).json();
    expect(missingEvents.audit.verdict).toBe("fail");
    expect(JSON.stringify(missingEvents.audit.checks)).toContain("CHAIN_EVENT_MISSING");
  });

  it("does not let the user authorize the similar-name outsider", async () => {
    const { app, gateway } = setup();
    const response = await post(app, "/api/sessions", sessionRequest(["han-table-express"]));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    expect(gateway.sessions.size).toBe(0);
  });

  it("keeps a pending broadcast and never broadcasts the same quote twice", async () => {
    const { app, gateway } = setup();
    const created = await post(app, "/api/sessions", sessionRequest());
    const { session } = await created.json();
    gateway.pendingNext = true;

    const first = await post(app, "/api/sessions/" + session.id + "/attempts", { quoteId: "C" });
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    expect(firstBody.attempt).toMatchObject({ quoteId: "C", code: "PENDING", status: "pending", onChain: true });

    const retry = await post(app, "/api/sessions/" + session.id + "/attempts", { quoteId: "C" });
    expect(retry.status).toBe(202);
    expect(gateway.attemptCalls).toBe(1);
    expect((await retry.json()).attempt.id).toBe(firstBody.attempt.id);

    const audit = await (await app.request("/api/sessions/" + session.id + "/audit")).json();
    expect(audit.audit.verdict).toBe("incomplete");
  });

  it("reconciles a pending payment from its confirmed event after refresh", async () => {
    const { app, gateway } = setup();
    const created = await post(app, "/api/sessions", sessionRequest());
    const { session } = await created.json();
    gateway.pendingNext = true;
    const pendingResponse = await post(app, "/api/sessions/" + session.id + "/attempts", { quoteId: "C" });
    const pending = (await pendingResponse.json()).attempt;
    expect(pending.status).toBe("pending");

    gateway.confirmAttempt(pending.txHash, session.id, pending.id, {
      name: "PaymentExecuted",
      sessionId: session.id,
      merchantAddress: pending.merchantAddress,
      amountSun: "16000000",
      quoteHash: pending.quoteHash,
    });

    const refreshed = await (await app.request("/api/sessions/" + session.id)).json();
    expect(refreshed.session.attempts[0]).toMatchObject({ status: "allowed", code: "PAYMENT_EXECUTED" });
    expect(refreshed.session.spentSun).toBe(16_000_000);
    const audit = await (await app.request("/api/sessions/" + session.id + "/audit")).json();
    expect(audit.audit.verdict).toBe("pass");
  });

  it("reconciles a pending revoke and refuses to broadcast it twice", async () => {
    const { app, gateway } = setup();
    const created = await post(app, "/api/sessions", sessionRequest());
    const { session } = await created.json();
    gateway.pendingRevokeNext = true;
    const pending = await post(app, "/api/sessions/" + session.id + "/revoke");
    expect(pending.status).toBe(202);
    gateway.sessions.get(session.id)!.live.revoked = true;

    const refreshed = await (await app.request("/api/sessions/" + session.id)).json();
    expect(refreshed.session.state).toBe("revoked");
    expect((await post(app, "/api/sessions/" + session.id + "/revoke")).status).toBe(409);
    expect(gateway.revokeCalls).toBe(1);
  });

  it("keeps a pending approval and never funds another session on retry", async () => {
    const { app, gateway } = setup();
    gateway.pendingCreateNext = true;
    const first = await post(app, "/api/sessions", sessionRequest());
    expect(first.status).toBe(202);
    const pending = await first.json();
    expect(pending.session).toMatchObject({ state: "pending", budgetSun: 18_000_000, spentSun: 0 });
    expect(pending.session.approvalTxHash).toMatch(/^0x[0-9a-f]{64}$/);

    const second = await post(app, "/api/sessions", sessionRequest());
    expect(second.status).toBe(202);
    const retried = await second.json();
    expect(retried.session.id).toBe(pending.session.id);
    expect(gateway.createCalls).toBe(1);

    const audit = await (await app.request("/api/sessions/" + pending.session.id + "/audit")).json();
    expect(audit.audit.verdict).toBe("incomplete");
  });

  it("does not silently reuse an active session for different limits", async () => {
    const { app, gateway } = setup();
    const original = sessionRequest();
    expect((await post(app, "/api/sessions", original)).status).toBe(201);
    const changed = await post(app, "/api/sessions", {
      ...original,
      budgetSun: 20_000_000,
      perPaymentCapSun: 20_000_000,
    });
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe("ACTIVE_SESSION_EXISTS");
    expect(gateway.createCalls).toBe(1);
  });

  it("rejects a chain session whose live merchant addresses differ from the approved record", async () => {
    const { app, gateway } = setup();
    const created = await post(app, "/api/sessions", sessionRequest());
    const { session } = await created.json();
    gateway.sessions.get(session.id)!.live.allowedMerchants = [
      "TDiTQkRBsW6Z7v15s5gYMi1SHKz1VGQkFe",
    ];

    const fetched = await app.request("/api/sessions/" + session.id);
    expect(fetched.status).toBe(502);
    expect((await fetched.json()).error.code).toBe("CHAIN_POLICY_MISMATCH");

    const audit = await (await app.request("/api/sessions/" + session.id + "/audit")).json();
    expect(audit.audit.verdict).toBe("fail");
    expect(audit.audit.checks.some((check: { label: string; passed: boolean }) =>
      check.label === "Merchant allowlist matches" && !check.passed)).toBe(true);
  });

  it("reserves a quote before RPC so concurrent clicks cannot pay twice", async () => {
    const { app, gateway } = setup();
    const created = await post(app, "/api/sessions", {
      ...sessionRequest(),
      budgetSun: 36_000_000,
      perPaymentCapSun: 18_000_000,
    });
    const { session } = await created.json();
    gateway.readDelayMs = 20;
    const path = "/api/sessions/" + session.id + "/attempts";

    const responses = await Promise.all([
      post(app, path, { quoteId: "C" }),
      post(app, path, { quoteId: "C" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
    expect(gateway.attemptCalls).toBe(1);
    const ids = await Promise.all(responses.map(async (response) => (await response.json()).attempt.id));
    expect(ids[0]).toBe(ids[1]);
    expect((await gateway.getSession(session.id)).spentSun).toBe("16000000");
  });
});
