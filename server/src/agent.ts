import { z } from "zod";
import { merchantIds, type Catalog, type MerchantId } from "./catalog.js";

const merchantIdSchema = z.enum(merchantIds);
const preferencesSchema = z.object({
  warm: z.boolean().default(false),
  avoidIngredients: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  notes: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
});

export const planRequestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  demoFallback: z.boolean().optional(),
});

export const recommendRequestSchema = z.object({
  message: z.string().trim().max(2000).optional(),
  preferences: preferencesSchema.partial().optional(),
  policy: z.object({
    budget: z.number().positive().optional(),
    allowedMerchantIds: z.array(merchantIdSchema).optional(),
  }).optional(),
  demoFallback: z.boolean().optional(),
});

const modelPlanSchema = z.object({
  budget: z.number().finite().positive().nullable(),
  allowedMerchantIds: z.array(merchantIdSchema),
  expiresAt: z.string().nullable(),
  preferences: preferencesSchema,
});

const mealItemIds = ["bibimbap-bowl", "doenjang-stew", "express-bibimbap"] as const;
const modelRecommendationSchema = z.object({
  rankedItemIds: z.array(z.enum(mealItemIds)).min(1).max(mealItemIds.length),
  reason: z.string().trim().min(1).max(500),
});

export type PlanRequest = z.infer<typeof planRequestSchema>;
export type RecommendRequest = z.infer<typeof recommendRequestSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;

export class ModelOutputError extends Error {
  constructor() {
    super("MODEL_OUTPUT_INVALID");
  }
}

function parseModelJson(text: string): unknown {
  // Kiln does not enforce JSON for this model, so accept only a full JSON document or one fenced document.
  const withoutThinking = text.trim().replace(/^<think>[\s\S]*?<\/think>\s*/, "");
  const fenced = withoutThinking.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return JSON.parse(fenced ? fenced[1] : withoutThinking);
  } catch {
    throw new ModelOutputError();
  }
}

function explicitBudgetAmounts(message: string): number[] {
  const found = new Set<number>();
  const patterns = [
    /(?:预算|上限|最多|不超过|低于|总价|总额|合计|budget|limit|cap|maximum|up to|under|at most|no more than)[^\d]{0,12}(\d+(?:\.\d{1,6})?)/giu,
    /(\d+(?:\.\d{1,6})?)\s*(?:测试\s*)?(?:TRX|USDC|USD|元|块)?\s*(?:max|maximum|limit|budget|上限|以内|以下)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of message.matchAll(pattern)) {
      const amount = Number(match[1]);
      if (Number.isFinite(amount) && amount > 0) found.add(amount);
    }
  }
  return [...found];
}

function explicitlyMentionedMerchants(message: string): Set<MerchantId> {
  const lower = message.toLowerCase();
  const withoutExpress = lower.replaceAll("han table express", "");
  const result = new Set<MerchantId>();
  if (lower.includes("seoul bowl")) result.add("seoul-bowl");
  if (withoutExpress.includes("han table")) result.add("han-table");
  if (lower.includes("han table express")) result.add("han-table-express");
  return result;
}

function hasExplicitExpiry(message: string): boolean {
  return /\b\d{1,2}[:：]\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b|\d+\s*(?:分钟|小时|minutes?|hours?)/iu.test(message);
}

function validDraftExpiry(value: string | null, message: string, now: Date): string | null {
  if (!value || !hasExplicitExpiry(message)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > now.getTime() ? new Date(time).toISOString() : null;
}

function nextKstClock(message: string, now: Date): string | null {
  const match = message.match(/\b(\d{1,2}):([0-5]\d)\b/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour > 23) return null;
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kstNow.getUTCFullYear();
  const m = String(kstNow.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kstNow.getUTCDate()).padStart(2, "0");
  const candidate = new Date(`${y}-${m}-${d}T${String(hour).padStart(2, "0")}:${match[2]}:00+09:00`);
  return candidate.getTime() > now.getTime() ? candidate.toISOString() : null;
}

export function planPrompt(request: PlanRequest, catalog: Catalog, now = new Date()): { system: string; user: string } {
  const merchants = catalog.merchants.map(({ id, name }) => ({ id, name }));
  return {
    system: `You are a food-ordering personal agent drafting permissions, never granting them. Current UTC time: ${now.toISOString()}. User timezone: Asia/Seoul (UTC+09:00). Return ONLY one JSON object with exactly these keys: budget (positive number or null), allowedMerchantIds (array of merchant IDs), expiresAt (ISO-8601 timestamp with timezone or null), preferences (object with warm boolean, avoidIngredients string array, notes string array). Do not infer a numeric budget from phrases like "not expensive". Do not invent a deadline, merchant, or budget. Only include merchants explicitly approved by name. Authorization remains inactive until the human edits and confirms the draft. Merchant directory: ${JSON.stringify(merchants)}. /no_think`,
    user: request.message,
  };
}

export function buildPlan(request: PlanRequest, modelText: string, now = new Date()) {
  const parsed = modelPlanSchema.safeParse(parseModelJson(modelText));
  if (!parsed.success) throw new ModelOutputError();

  const mentionedAmounts = explicitBudgetAmounts(request.message);
  const budget = parsed.data.budget !== null && mentionedAmounts.some((value) => Math.abs(value - parsed.data.budget!) < 0.000001)
    ? parsed.data.budget
    : null;
  const explicitMerchants = explicitlyMentionedMerchants(request.message);
  const allowedMerchantIds = [...new Set(parsed.data.allowedMerchantIds)].filter((id) => explicitMerchants.has(id));
  const expiresAt = validDraftExpiry(parsed.data.expiresAt, request.message, now);
  const missingFields = [
    ...(budget === null ? ["budget"] : []),
    ...(allowedMerchantIds.length === 0 ? ["allowedMerchantIds"] : []),
    ...(expiresAt === null ? ["expiresAt"] : []),
  ];

  return {
    draftPolicy: {
      budget,
      perPaymentCap: budget,
      expiresAt,
      allowedMerchantIds,
      preferences: parsed.data.preferences,
    },
    missingFields,
    readyForConfirmation: missingFields.length === 0,
    requiresConfirmation: true as const,
    assistantMessage: missingFields.length > 0
      ? `Complete ${missingFields.join(", ")} before reviewing the permission. No spending authority is active.`
      : "Review and confirm this draft. No spending authority is active yet.",
  };
}

export function demoPlan(request: PlanRequest, now = new Date()) {
  const budget = explicitBudgetAmounts(request.message)[0] ?? null;
  const allowedMerchantIds = [...explicitlyMentionedMerchants(request.message)];
  const expiresAt = nextKstClock(request.message, now);
  const lower = request.message.toLowerCase();
  const preferences: Preferences = {
    warm: /warm|hot|温|热/iu.test(lower),
    avoidIngredients: /香菜|cilantro|coriander/iu.test(lower) ? ["cilantro"] : [],
    notes: [],
  };
  return buildPlan(request, JSON.stringify({ budget, allowedMerchantIds, expiresAt, preferences }), now);
}

export function recommendPrompt(request: RecommendRequest, catalog: Catalog): { system: string; user: string } {
  const candidates = catalog.quotes.filter((quote) => quote.id !== "D").map((quote) => {
    const merchant = catalog.merchants.find((entry) => entry.id === quote.merchantId)!;
    const item = merchant.items.find((entry) => entry.id === quote.itemId)!;
    return {
      itemId: item.id,
      name: item.name,
      description: item.description,
      merchantId: merchant.id,
      merchantName: merchant.name,
      totalTrxIncludingFees: quote.total,
      tags: item.tags,
    };
  });
  return {
    system: `You are a food-ordering personal agent recommending a main meal. Return ONLY one JSON object with exactly these keys: rankedItemIds (array of one to three item IDs, best first, no duplicates) and reason (one short sentence). Every ID must exist in the candidates. Prices and merchants come only from this simulated catalog; do not invent prices or claim real delivery. You may rank meals, but you cannot grant payment permission. Candidates: ${JSON.stringify(candidates)}. /no_think`,
    user: JSON.stringify({ message: request.message ?? "Find a warm dinner without cilantro", preferences: request.preferences ?? {}, policy: request.policy ?? null }),
  };
}

export function buildRecommendation(modelText: string, catalog: Catalog) {
  const parsed = modelRecommendationSchema.safeParse(parseModelJson(modelText));
  if (!parsed.success || new Set(parsed.data.rankedItemIds).size !== parsed.data.rankedItemIds.length) {
    throw new ModelOutputError();
  }
  const itemId = parsed.data.rankedItemIds[0];
  const merchant = catalog.merchants.find((entry) => entry.items.some((item) => item.id === itemId));
  if (!merchant) throw new ModelOutputError();
  return {
    rankedItemIds: parsed.data.rankedItemIds,
    itemId,
    merchantId: merchant.id,
    reason: parsed.data.reason,
  };
}

export function demoRecommendation(catalog: Catalog) {
  return buildRecommendation(JSON.stringify({
    rankedItemIds: ["doenjang-stew", "bibimbap-bowl", "express-bibimbap"],
    reason: "The warm stew matches the stated preference and its simulated all-in quote is 16 TRX.",
  }), catalog);
}
