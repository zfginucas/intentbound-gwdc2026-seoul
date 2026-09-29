import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { InferenceLedger } from "../src/usage.js";
import type { KilnCompletion, KilnGateway } from "../src/kiln.js";

function completion(text: string): KilnCompletion {
  return {
    text,
    generationId: "generation-test-1",
    usage: { inputTokens: 81, outputTokens: 37, totalTokens: 118 },
    latencyMs: 420,
  };
}

function gateway(text: string): KilnGateway {
  return {
    configured: true,
    connected: true,
    complete: vi.fn().mockResolvedValue(completion(text)),
  };
}

async function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("catalog and status", () => {
  it("discloses fixture mode and returns the four exact all-in quotes", async () => {
    const app = createApp({ env: {} });
    const status = await (await app.request("/api/status")).json();
    const catalog = await (await app.request("/api/catalog")).json();

    expect(status).toEqual({
      kiln: { configured: false, connected: false, model: "qwen3-32b" },
      chain: {
        network: "shasta",
        connected: false,
        configured: false,
        asset: "test TRX",
        contractAddress: null,
      },
      merchantMode: "fixture",
    });
    expect(catalog.mode).toBe("simulated");
    expect(catalog.currency).toBe("TRX");
    expect(catalog.quotes.map((quote: { id: string; total: number }) => [quote.id, quote.total])).toEqual([
      ["A", 19], ["B", 14], ["C", 16], ["D", 1],
    ]);
    expect(catalog.quotes.map((quote: { totalSun: string }) => quote.totalSun)).toEqual([
      "19000000", "14000000", "16000000", "1000000",
    ]);
    expect(catalog.merchants.find((merchant: { id: string }) => merchant.id === "han-table-express").allowed).toBe(false);
  });

  it("never exposes the server API key in status or catalog", async () => {
    const app = createApp({ env: { KILN_API_KEY: "server-only-test-secret" } });
    const status = await (await app.request("/api/status")).text();
    const catalog = await (await app.request("/api/catalog")).text();
    expect(status + catalog).not.toContain("server-only-test-secret");
  });

  it("rejects cross-site and form-style writes to the local demo API", async () => {
    const app = createApp({ env: {} });
    const crossSite = await app.request("/api/agent/plan", {
      method: "POST",
      headers: { origin: "https://outside.example", "content-type": "application/json" },
      body: JSON.stringify({ message: "Order dinner" }),
    });
    expect(crossSite.status).toBe(403);

    const formStyle = await app.request("/api/agent/plan", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ message: "Order dinner" }),
    });
    expect(formStyle.status).toBe(415);
  });
});

describe("planning", () => {
  it("keeps a vague authorization incomplete even if the model invents a budget", async () => {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const kiln = gateway(JSON.stringify({
      budget: 18,
      allowedMerchantIds: ["han-table"],
      expiresAt,
      preferences: { warm: true, avoidIngredients: [], notes: [] },
    }));
    const ledger = new InferenceLedger();
    const app = createApp({ kilnClient: kiln, usageLedger: ledger });
    const response = await post(app, "/api/agent/plan", { message: "Warm dinner, not too expensive." });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.draftPolicy.budget).toBeNull();
    expect(body.draftPolicy.allowedMerchantIds).toEqual([]);
    expect(body.draftPolicy.expiresAt).toBeNull();
    expect(body.requiresConfirmation).toBe(true);
    expect(body.readyForConfirmation).toBe(false);
    expect(body.missingFields).toEqual(["budget", "allowedMerchantIds", "expiresAt"]);
    expect(body.inference).toMatchObject({ source: "kiln", generationId: "generation-test-1", usage: { inputTokens: 81, outputTokens: 37 } });
    expect(ledger.list()).toHaveLength(1);
  });

  it("does not turn a stated menu price into the user's budget", async () => {
    const kiln = gateway(JSON.stringify({
      budget: 18,
      allowedMerchantIds: ["han-table"],
      expiresAt: null,
      preferences: { warm: true, avoidIngredients: [], notes: [] },
    }));
    const app = createApp({ kilnClient: kiln });
    const response = await post(app, "/api/agent/plan", {
      message: "Han Table has a meal priced at 18 TRX. Please keep it affordable.",
    });
    const body = await response.json();

    expect(body.draftPolicy.budget).toBeNull();
    expect(body.missingFields).toContain("budget");
  });

  it("extracts an explicit draft but still requires human confirmation", async () => {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const kiln = gateway(JSON.stringify({
      budget: 18,
      allowedMerchantIds: ["seoul-bowl", "han-table"],
      expiresAt,
      preferences: { warm: true, avoidIngredients: ["cilantro"], notes: [] },
    }));
    const app = createApp({ kilnClient: kiln });
    const response = await post(app, "/api/agent/plan", {
      message: "Warm dinner without cilantro, maximum 18 TRX, only Seoul Bowl or Han Table, within 10 minutes.",
    });
    const body = await response.json();

    expect(body.draftPolicy).toMatchObject({
      budget: 18,
      perPaymentCap: 18,
      allowedMerchantIds: ["seoul-bowl", "han-table"],
    });
    expect(body.readyForConfirmation).toBe(true);
    expect(body.requiresConfirmation).toBe(true);
    expect(body.inference.source).toBe("kiln");
  });

  it("recognizes at most as an explicit user limit", async () => {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const kiln = gateway(JSON.stringify({
      budget: 18,
      allowedMerchantIds: ["seoul-bowl", "han-table"],
      expiresAt,
      preferences: { warm: true, avoidIngredients: ["cilantro"], notes: [] },
    }));
    const app = createApp({ kilnClient: kiln });
    const response = await post(app, "/api/agent/plan", {
      message: "Warm dinner without cilantro, spend at most 18 TRX, only Seoul Bowl or Han Table, within 10 minutes.",
    });
    const body = await response.json();

    expect(body.draftPolicy.budget).toBe(18);
    expect(body.readyForConfirmation).toBe(true);
  });

  it("uses deterministic fallback only on explicit request and labels it as non-evidence", async () => {
    const app = createApp({ env: {} });
    const withoutFallback = await post(app, "/api/agent/plan", { message: "not too expensive" });
    expect(withoutFallback.status).toBe(503);

    const withFallback = await post(app, "/api/agent/plan", {
      message: "Warm dinner, maximum 18 TRX, only Han Table, by 20:00.",
      demoFallback: true,
    });
    const body = await withFallback.json();
    expect(body.inference).toMatchObject({
      source: "demo_fallback",
      model: null,
      generationId: null,
      usage: null,
      fallbackReason: "KILN_NOT_CONFIGURED",
    });
    expect(body.draftPolicy.budget).toBe(18);
    expect(body.requiresConfirmation).toBe(true);
  });
});

describe("recommendations", () => {
  it("lets real Kiln output determine the recommendation", async () => {
    const kiln = gateway(JSON.stringify({
      rankedItemIds: ["doenjang-stew", "bibimbap-bowl"],
      reason: "The warm stew fits the preference.",
    }));
    const app = createApp({ kilnClient: kiln });
    const response = await post(app, "/api/agent/recommend", { preferences: { warm: true } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.itemId).toBe("doenjang-stew");
    expect(body.merchantId).toBe("han-table");
    expect(body.inference.source).toBe("kiln");
    expect(body.inference.usage.totalTokens).toBe(118);
  });

  it("rejects an unknown model item instead of silently choosing a fixture", async () => {
    const kiln = gateway(JSON.stringify({ rankedItemIds: ["invented-meal"], reason: "I invented this." }));
    const app = createApp({ kilnClient: kiln });
    const response = await post(app, "/api/agent/recommend", {});
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("MODEL_OUTPUT_INVALID");
  });

  it("returns a marked fixture recommendation if the caller explicitly opts in", async () => {
    const app = createApp({ env: {} });
    const response = await post(app, "/api/agent/recommend", { demoFallback: true });
    const body = await response.json();

    expect(body.itemId).toBe("doenjang-stew");
    expect(body.inference.source).toBe("demo_fallback");
    expect(body.inference.usage).toBeNull();
  });
});
