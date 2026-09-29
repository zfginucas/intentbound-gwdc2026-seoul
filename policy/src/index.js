import { createHash } from "node:crypto";

export const SUN_PER_TRX = 1_000_000n;

export function trxToSun(value) {
  const input = String(value);
  if (!/^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(input)) {
    throw new TypeError("TRX amount must be a non-negative decimal with at most six places");
  }
  const [whole, fraction = ""] = input.split(".");
  return BigInt(whole) * SUN_PER_TRX + BigInt(fraction.padEnd(6, "0") || "0");
}

export function sunToTrx(value) {
  const sun = toSun(value);
  const whole = sun / SUN_PER_TRX;
  const fraction = (sun % SUN_PER_TRX).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? String(whole) + "." + fraction : String(whole);
}

function toSun(value) {
  if (typeof value !== "bigint" && (typeof value !== "string" || !/^\d+$/.test(value))) {
    throw new TypeError("SUN amount must be a non-negative integer string or bigint");
  }
  const result = BigInt(value);
  if (result < 0n) {
    throw new TypeError("SUN amount must be non-negative");
  }
  return result;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stableStringify(value[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function digest(value) {
  return "0x" + createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function policyHash(policy) {
  return digest({
    sessionId: policy.sessionId,
    owner: policy.owner,
    agent: policy.agent,
    totalCapSun: String(policy.totalCapSun),
    perPaymentCapSun: String(policy.perPaymentCapSun),
    allowedMerchantAddresses: [...policy.allowedMerchantAddresses].sort(),
    expiresAt: Number(policy.expiresAt),
  });
}

export function quoteHash(quote) {
  return digest({
    quoteId: quote.quoteId,
    itemId: quote.itemId,
    merchantAddress: quote.merchantAddress,
    itemsSun: String(quote.itemsSun),
    deliverySun: String(quote.deliverySun),
    serviceSun: String(quote.serviceSun),
    taxSun: String(quote.taxSun),
    discountSun: String(quote.discountSun),
    expiresAt: Number(quote.expiresAt),
  });
}

export function quoteTotalSun(quote) {
  const items = toSun(quote.itemsSun);
  const delivery = toSun(quote.deliverySun);
  const service = toSun(quote.serviceSun);
  const tax = toSun(quote.taxSun);
  const discount = toSun(quote.discountSun);
  const beforeDiscount = items + delivery + service + tax;
  if (discount > beforeDiscount) {
    throw new TypeError("Discount cannot exceed the charge");
  }
  const total = beforeDiscount - discount;
  if (total === 0n) {
    throw new TypeError("Quote total must be positive");
  }
  if (quote.totalSun !== undefined && toSun(quote.totalSun) !== total) {
    throw new TypeError("Quoted total does not match fee breakdown");
  }
  return total;
}

export function evaluateSpend({
  policy,
  quote,
  spentSun = "0",
  remainingSun,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  let amountSun;
  try {
    amountSun = quoteTotalSun(quote);
  } catch (error) {
    return {
      approved: false,
      code: "INVALID_QUOTE",
      amountSun: null,
      checks: [{ code: "INVALID_QUOTE", passed: false, detail: error.message }],
    };
  }

  const totalCapSun = toSun(policy.totalCapSun);
  const perPaymentCapSun = toSun(policy.perPaymentCapSun);
  const priorSpentSun = toSun(spentSun);
  const escrowSun = remainingSun === undefined ? totalCapSun - priorSpentSun : toSun(remainingSun);
  const now = Number(nowSeconds);
  const checks = [
    { code: "REVOKED", passed: !policy.revoked },
    { code: "EXPIRED", passed: now < Number(policy.expiresAt) },
    { code: "QUOTE_EXPIRED", passed: now < Number(quote.expiresAt) },
    {
      code: "MERCHANT_NOT_ALLOWED",
      passed: policy.allowedMerchantAddresses.includes(quote.merchantAddress),
    },
    { code: "OVER_LIMIT", passed: priorSpentSun + amountSun <= totalCapSun },
    { code: "PER_PAYMENT_LIMIT", passed: amountSun <= perPaymentCapSun },
    { code: "INSUFFICIENT_ESCROW", passed: amountSun <= escrowSun },
  ];
  const failure = checks.find((check) => !check.passed);
  return {
    approved: !failure,
    code: failure?.code ?? "APPROVED",
    amountSun: String(amountSun),
    checks,
  };
}

export function verifyEvidence(bundle, observedEvent) {
  const problems = [];
  const expectedPolicyHash = policyHash(bundle.policy);
  const expectedQuoteHash = quoteHash(bundle.quote);
  if (bundle.policyHash !== expectedPolicyHash) problems.push("POLICY_HASH_MISMATCH");
  if (bundle.quoteHash !== expectedQuoteHash) problems.push("QUOTE_HASH_MISMATCH");

  const replay = evaluateSpend({
    policy: bundle.policy,
    quote: bundle.quote,
    spentSun: bundle.spentBeforeSun,
    remainingSun: bundle.remainingBeforeSun,
    nowSeconds: bundle.decision.atSeconds,
  });
  if (bundle.decision.code !== replay.code) problems.push("DECISION_CODE_MISMATCH");
  if (bundle.decision.amountSun !== replay.amountSun) problems.push("DECISION_AMOUNT_MISMATCH");

  if (!observedEvent) {
    problems.push("CHAIN_EVENT_MISSING");
  } else {
    const expectedEvent = replay.approved ? "PaymentExecuted" : "AttemptRejected";
    if (observedEvent.name !== expectedEvent) problems.push("CHAIN_EVENT_TYPE_MISMATCH");
    if (observedEvent.sessionId !== bundle.policy.sessionId) problems.push("SESSION_ID_MISMATCH");
    if (observedEvent.merchantAddress !== bundle.quote.merchantAddress) {
      problems.push("MERCHANT_ADDRESS_MISMATCH");
    }
    if (String(observedEvent.amountSun) !== replay.amountSun) {
      problems.push("CHAIN_AMOUNT_MISMATCH");
    }
    if (observedEvent.quoteHash !== expectedQuoteHash) problems.push("CHAIN_QUOTE_HASH_MISMATCH");
    if (!replay.approved && observedEvent.reason !== replay.code) {
      problems.push("CHAIN_REJECTION_REASON_MISMATCH");
    }
  }

  return {
    verified: problems.length === 0,
    problems,
    replay,
    expectedPolicyHash,
    expectedQuoteHash,
  };
}
