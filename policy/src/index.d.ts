export type Sun = string | bigint;

export interface SpendPolicy {
  sessionId: string;
  owner: string;
  agent: string;
  totalCapSun: Sun;
  perPaymentCapSun: Sun;
  allowedMerchantAddresses: string[];
  expiresAt: number;
  revoked: boolean;
}

export interface SpendQuote {
  quoteId: string;
  itemId: string;
  merchantAddress: string;
  itemsSun: Sun;
  deliverySun: Sun;
  serviceSun: Sun;
  taxSun: Sun;
  discountSun: Sun;
  totalSun?: Sun;
  expiresAt: number;
}

export type DecisionCode =
  | "APPROVED"
  | "INVALID_QUOTE"
  | "REVOKED"
  | "EXPIRED"
  | "QUOTE_EXPIRED"
  | "MERCHANT_NOT_ALLOWED"
  | "OVER_LIMIT"
  | "PER_PAYMENT_LIMIT"
  | "INSUFFICIENT_ESCROW";

export interface SpendDecision {
  approved: boolean;
  code: DecisionCode;
  amountSun: string | null;
  checks: Array<{ code: DecisionCode; passed: boolean; detail?: string }>;
}

export interface EvidenceBundle {
  policy: SpendPolicy;
  quote: SpendQuote;
  policyHash: string;
  quoteHash: string;
  spentBeforeSun: Sun;
  remainingBeforeSun: Sun;
  decision: { atSeconds: number; code: DecisionCode; amountSun: string | null };
}

export interface ObservedEvent {
  name: "PaymentExecuted" | "AttemptRejected";
  sessionId: string;
  merchantAddress: string;
  amountSun: Sun | null;
  quoteHash: string;
  reason?: DecisionCode;
}

export const SUN_PER_TRX: bigint;
export function trxToSun(value: string | number): bigint;
export function sunToTrx(value: Sun): string;
export function policyHash(policy: SpendPolicy): string;
export function quoteHash(quote: SpendQuote): string;
export function quoteTotalSun(quote: SpendQuote): bigint;
export function evaluateSpend(input: {
  policy: SpendPolicy;
  quote: SpendQuote;
  spentSun?: Sun;
  remainingSun?: Sun;
  nowSeconds?: number;
}): SpendDecision;
export function verifyEvidence(
  bundle: EvidenceBundle,
  observedEvent?: ObservedEvent | null,
): {
  verified: boolean;
  problems: string[];
  replay: SpendDecision;
  expectedPolicyHash: string;
  expectedQuoteHash: string;
};
