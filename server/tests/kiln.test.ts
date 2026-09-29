import { describe, expect, it, vi } from "vitest";
import { KilnHttpClient } from "../src/kiln.js";

describe("Kiln HTTP client", () => {
  it("calls qwen3-32b server-side and records real response metadata", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "{\"ok\":true}" } }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    }), {
      status: 200,
      headers: { "X-Neocloud-Generation-Id": "generation-abc" },
    })) as unknown as typeof fetch;
    const client = new KilnHttpClient({ env: { KILN_API_KEY: "local-test-key" }, fetcher });

    const result = await client.complete("system prompt", "user prompt");
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    const payload = JSON.parse(String(init?.body));

    expect(url).toBe("https://api.bricksum.com/v1/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer local-test-key" });
    expect(payload.model).toBe("qwen3-32b");
    expect(payload.stream).toBe(false);
    expect(result).toMatchObject({
      text: "{\"ok\":true}",
      generationId: "generation-abc",
      usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(client.connected).toBe(true);
  });

  it("does not return provider error bodies or API keys", async () => {
    const fetcher = vi.fn(async () => new Response("upstream secret", { status: 401 })) as unknown as typeof fetch;
    const client = new KilnHttpClient({ env: { KILN_API_KEY: "local-test-key" }, fetcher });
    await expect(client.complete("system", "user")).rejects.toMatchObject({
      code: "KILN_REQUEST_FAILED",
      providerStatus: 401,
    });
    expect(client.connected).toBe(false);
  });
});
