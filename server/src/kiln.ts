import { z } from "zod";

export const KILN_MODEL = "qwen3-32b" as const;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface KilnCompletion {
  text: string;
  generationId: string | null;
  usage: TokenUsage;
  latencyMs: number;
}

export interface KilnGateway {
  readonly configured: boolean;
  readonly connected: boolean | null;
  complete(system: string, user: string): Promise<KilnCompletion>;
}

export class KilnError extends Error {
  constructor(
    public readonly code: "KILN_NOT_CONFIGURED" | "KILN_REQUEST_FAILED" | "KILN_RESPONSE_INVALID",
    public readonly providerStatus?: number,
  ) {
    super(code);
  }
}

const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable() }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }),
});

export class KilnHttpClient implements KilnGateway {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private connection: boolean | null = null;

  constructor(options: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch } = {}) {
    const env = options.env ?? process.env;
    this.apiKey = env.KILN_API_KEY?.trim() || undefined;
    this.baseUrl = (env.KILN_BASE_URL?.trim() || "https://api.bricksum.com/v1").replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  get connected(): boolean | null {
    return this.configured ? this.connection : false;
  }

  async complete(system: string, user: string): Promise<KilnCompletion> {
    if (!this.apiKey) {
      throw new KilnError("KILN_NOT_CONFIGURED");
    }

    const started = performance.now();
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: KILN_MODEL,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0,
          max_tokens: 1024,
          stream: false,
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      this.connection = false;
      throw new KilnError("KILN_REQUEST_FAILED");
    }

    if (!response.ok) {
      this.connection = false;
      throw new KilnError("KILN_REQUEST_FAILED", response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      this.connection = false;
      throw new KilnError("KILN_RESPONSE_INVALID");
    }

    const parsed = completionSchema.safeParse(body);
    const content = parsed.success ? parsed.data.choices[0].message.content?.trim() : null;
    if (!parsed.success || !content) {
      this.connection = false;
      throw new KilnError("KILN_RESPONSE_INVALID");
    }

    this.connection = true;
    return {
      text: content,
      generationId: response.headers.get("X-Neocloud-Generation-Id"),
      usage: {
        inputTokens: parsed.data.usage.prompt_tokens,
        outputTokens: parsed.data.usage.completion_tokens,
        totalTokens: parsed.data.usage.total_tokens,
      },
      latencyMs: Math.round(performance.now() - started),
    };
  }
}
