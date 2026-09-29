import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateSpend,
  policyHash,
  quoteHash,
  quoteTotalSun,
  sunToTrx,
  trxToSun,
  verifyEvidence,
} from "../src/index.js";

const NOW = 1_700_000_000;
const BOWL = "TDLxYZ1KbF6kvcDeJeyKB6pFv157h8xitt";
const TABLE = "TB2sCSX5RDK8GMFT1ZTSsR8FsP1nWPFM5b";
const EXPRESS = "TUnauthorizedMerchantAddress";

const policy = {
  sessionId: "0x" + "a".repeat(64),
  owner: "TOwner",
  agent: "TAgent",
  totalCapSun: String(trxToSun("18")),
  perPaymentCapSun: String(trxToSun("18")),
  allowedMerchantAddresses: [BOWL, TABLE],
  expiresAt: NOW + 600,
  revoked: false,
};

function quote(overrides = {}) {
  return {
    quoteId: "quote-c",
    itemId: "doenjang-stew",
    merchantAddress: TABLE,
    itemsSun: String(trxToSun("13")),
    deliverySun: String(trxToSun("2")),
    serviceSun: String(trxToSun("1")),
    taxSun: "0",
    discountSun: "0",
    expiresAt: NOW + 120,
    ...overrides,
  };
}

test("TRX conversion uses integer SUN without floating point", () => {
  assert.equal(trxToSun("0.000001"), 1n);
  assert.equal(sunToTrx("16000000"), "16");
  assert.equal(sunToTrx("1000001"), "1.000001");
  assert.throws(() => trxToSun("1.0000001"));
});

test("fee-inclusive over-limit quote is rejected", () => {
  const result = evaluateSpend({
    policy,
    quote: quote({
      merchantAddress: BOWL,
      itemsSun: String(trxToSun("15")),
      serviceSun: String(trxToSun("2")),
    }),
    nowSeconds: NOW,
  });
  assert.equal(result.code, "OVER_LIMIT");
  assert.equal(result.amountSun, String(trxToSun("19")));
});

test("unapproved merchant is rejected even with a cheaper quote", () => {
  const result = evaluateSpend({
    policy,
    quote: quote({
      merchantAddress: EXPRESS,
      itemsSun: String(trxToSun("12")),
      deliverySun: String(trxToSun("1")),
    }),
    nowSeconds: NOW,
  });
  assert.equal(result.code, "MERCHANT_NOT_ALLOWED");
  assert.equal(result.amountSun, String(trxToSun("14")));
});

test("approved quote passes and a later affordable add-on is blocked by revocation", () => {
  const paid = evaluateSpend({ policy, quote: quote(), nowSeconds: NOW });
  assert.equal(paid.approved, true);
  assert.equal(quoteTotalSun(quote()), trxToSun("16"));

  const addOn = quote({
    quoteId: "quote-d",
    itemId: "plum-tea",
    itemsSun: String(trxToSun("1")),
    deliverySun: "0",
    serviceSun: "0",
  });
  const stopped = evaluateSpend({
    policy: { ...policy, revoked: true },
    quote: addOn,
    spentSun: String(trxToSun("16")),
    remainingSun: String(trxToSun("2")),
    nowSeconds: NOW,
  });
  assert.equal(stopped.code, "REVOKED");
});

test("audit recomputes evidence and fails when a quote is tampered", () => {
  const purchase = quote();
  const bundle = {
    policy,
    quote: purchase,
    policyHash: policyHash(policy),
    quoteHash: quoteHash(purchase),
    spentBeforeSun: "0",
    remainingBeforeSun: String(trxToSun("18")),
    decision: {
      atSeconds: NOW,
      code: "APPROVED",
      amountSun: String(trxToSun("16")),
    },
  };
  const event = {
    name: "PaymentExecuted",
    sessionId: policy.sessionId,
    merchantAddress: TABLE,
    amountSun: String(trxToSun("16")),
    quoteHash: bundle.quoteHash,
  };
  assert.equal(verifyEvidence(bundle, event).verified, true);
  const tampered = { ...bundle, quote: { ...purchase, deliverySun: "3000000" } };
  assert.equal(verifyEvidence(tampered, event).verified, false);
});
