import { Hono } from "hono";
import { registerChainRoutes, type ChainGateway, type SessionStore } from "./chain-routes.js";
import { getCatalog } from "./catalog.js";
import {
  buildPlan,
  buildRecommendation,
  demoPlan,
  demoRecommendation,
  ModelOutputError,
  planPrompt,
  planRequestSchema,
  recommendPrompt,
  recommendRequestSchema,
} from "./agent.js";
import { KilnError, KilnHttpClient, KILN_MODEL, type KilnGateway } from "./kiln.js";
import {
  defaultInferenceLedger,
  fallbackMetadata,
  inferenceMetadata,
  InferenceLedger,
  type InferenceMetadata,
} from "./usage.js";
import { ShastaGateway } from "./tron-gateway.js";

export interface AppOptions {
  env?: NodeJS.ProcessEnv;
  kilnClient?: KilnGateway;
  usageLedger?: InferenceLedger;
  chainGateway?: ChainGateway;
  sessionStore?: SessionStore;
}

function errorCode(error: unknown): string {
  if (error instanceof KilnError || error instanceof ModelOutputError) return error.message;
  return "INTERNAL_ERROR";
}

function errorStatus(error: unknown): 502 | 503 | 500 {
  if (error instanceof KilnError && error.code === "KILN_NOT_CONFIGURED") return 503;
  if (error instanceof KilnError || error instanceof ModelOutputError) return 502;
  return 500;
}

function apiError(error: unknown) {
  const code = errorCode(error);
  const messages: Record<string, string> = {
    KILN_NOT_CONFIGURED: "Kiln is not configured on this server.",
    KILN_REQUEST_FAILED: "The Kiln request did not complete.",
    KILN_RESPONSE_INVALID: "Kiln returned an invalid completion envelope.",
    MODEL_OUTPUT_INVALID: "The model output did not match the required schema or catalog.",
    INTERNAL_ERROR: "The server could not complete this request.",
  };
  return {
    error: {
      code,
      message: messages[code],
      ...(error instanceof KilnError && error.providerStatus ? { providerStatus: error.providerStatus } : {}),
    },
  };
}

export function createApp(options: AppOptions = {}) {
  const env = options.env ?? process.env;
  const catalog = getCatalog(env);
  const kiln = options.kilnClient ?? new KilnHttpClient({ env });
  const usageLedger = options.usageLedger ?? defaultInferenceLedger;
  const chainGateway = options.chainGateway ?? new ShastaGateway(env);
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const allowedOrigins = new Set([
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:8787",
      "http://127.0.0.1:8787",
      ...(env.INTENTBOUND_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    ]);
    const origin = c.req.header("origin");
    if (origin && !allowedOrigins.has(origin)) {
      return c.json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "This demo accepts write requests only from its local UI." } }, 403);
    }
    if (c.req.header("sec-fetch-site") === "cross-site") {
      return c.json({ error: { code: "CROSS_SITE_WRITE_BLOCKED", message: "Cross-site writes are blocked." } }, 403);
    }
    if (!c.req.header("content-type")?.startsWith("application/json")) {
      return c.json({ error: { code: "JSON_REQUIRED", message: "Write requests require application/json." } }, 415);
    }
    return next();
  });

  app.get("/api/status", (c) => c.json({
    kiln: { configured: kiln.configured, connected: kiln.connected, model: KILN_MODEL },
    chain: {
      network: chainGateway.network,
      connected: chainGateway.configured ? null : false,
      configured: chainGateway.configured,
      asset: chainGateway.asset,
      contractAddress: chainGateway.contractAddress,
    },
    merchantMode: "fixture",
  }));

  app.get("/api/catalog", (c) => c.json(catalog));

  app.post("/api/agent/plan", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Expected a JSON request body." } }, 400);
    }
    const parsed = planRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Provide a nonempty message under 2000 characters." } }, 400);
    }

    const request = parsed.data;
    let attemptedInference: InferenceMetadata | undefined;
    try {
      const prompt = planPrompt(request, catalog);
      const completion = await kiln.complete(prompt.system, prompt.user);
      usageLedger.record("plan", completion);
      attemptedInference = inferenceMetadata(completion);
      return c.json({ ...buildPlan(request, completion.text), inference: attemptedInference });
    } catch (error) {
      if (request.demoFallback && (error instanceof KilnError || error instanceof ModelOutputError)) {
        return c.json({
          ...demoPlan(request),
          inference: fallbackMetadata(errorCode(error)),
          ...(attemptedInference ? { attemptedInference } : {}),
        });
      }
      return c.json(apiError(error), errorStatus(error));
    }
  });

  app.post("/api/agent/recommend", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Expected a JSON request body." } }, 400);
    }
    const parsed = recommendRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Invalid recommendation request." } }, 400);
    }

    const request = parsed.data;
    let attemptedInference: InferenceMetadata | undefined;
    try {
      const prompt = recommendPrompt(request, catalog);
      const completion = await kiln.complete(prompt.system, prompt.user);
      usageLedger.record("recommend", completion);
      attemptedInference = inferenceMetadata(completion);
      return c.json({ ...buildRecommendation(completion.text, catalog), inference: attemptedInference });
    } catch (error) {
      if (request.demoFallback && (error instanceof KilnError || error instanceof ModelOutputError)) {
        return c.json({
          ...demoRecommendation(catalog),
          inference: fallbackMetadata(errorCode(error)),
          ...(attemptedInference ? { attemptedInference } : {}),
        });
      }
      return c.json(apiError(error), errorStatus(error));
    }
  });

  registerChainRoutes(app, {
    catalog,
    gateway: chainGateway,
    ledger: usageLedger,
    store: options.sessionStore,
  });

  app.onError((error, c) => c.json(apiError(error), 500));
  return app;
}

export const app = createApp();
