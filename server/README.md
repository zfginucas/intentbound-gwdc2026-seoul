# IntentBound API

Node/TypeScript backend for the Personal Agent dinner demo. Kiln `qwen3-32b` calls happen only here; the browser never receives `KILN_API_KEY`. Merchant/menu/quote data is simulated. This service does not claim a real payment until the separate chain lifecycle confirms one.

## Run

Requires Node 22 or newer. From `server/`:

```sh
npm install
KILN_API_KEY=your_key npm run dev
```

Default port is `8787` (`PORT` can override it). Copy `.env.example` values into your local environment as needed; `tsx` does not automatically load an `.env` file. Never commit a real key or put it into the frontend. `KILN_BASE_URL` defaults to `https://api.bricksum.com/v1`. The configured model is `qwen3-32b`.

`npm run typecheck` and `npm test` run the focused checks.

## API Contract

### `GET /api/status`

```json
{
  "kiln": { "configured": true, "connected": null, "model": "qwen3-32b" },
  "chain": { "network": "shasta", "connected": null },
  "merchantMode": "fixture"
}
```

`kiln.connected` is `null` before a request has been attempted, then `true` or `false`. This initial route does not test the chain, so `chain.connected` is `null` until the chain integration replaces it.

### `GET /api/catalog`

Returns `{mode:"simulated", currency:"TRX", network, disclosure, merchants, quotes}`. The fixtures are:

| Quote | Merchant | Item ID | Items + delivery + service | Total |
| --- | --- | --- | --- | --- |
| A | `seoul-bowl` | `bibimbap-bowl` | 15 + 2 + 2 | 19 TRX |
| B | `han-table-express` | `express-bibimbap` | 11 + 2 + 1 | 14 TRX |
| C | `han-table` | `doenjang-stew` | 13 + 2 + 1 | 16 TRX |
| D | `han-table` | `plum-tea` | 1 + 0 + 0 | 1 TRX |

Quote B's similarly named merchant has a distinct public address and `allowed:false` in the **demo scenario**. This field is not an active wallet authorization. Each quote includes decimal TRX fields, SUN integer-string fields, the merchant public address, and `fixture:true`. These are templates, not signed or time-bound merchant offers; the chain route must create an attempt-specific quote snapshot and expiry.

Addresses can be overridden with `MERCHANT_SEOUL_BOWL_ADDRESS`, `MERCHANT_HAN_TABLE_ADDRESS`, and `MERCHANT_HAN_TABLE_EXPRESS_ADDRESS`. Values must look like public Tron Base58 addresses. The defaults are public Shasta fixture addresses, never private keys.

### `POST /api/agent/plan`

Request:

```json
{ "message": "Warm dinner without cilantro, maximum 18 TRX, only Seoul Bowl or Han Table, within 10 minutes" }
```

Response:

```json
{
  "draftPolicy": {
    "budget": 18,
    "perPaymentCap": 18,
    "expiresAt": "2026-09-29T11:00:00.000Z",
    "allowedMerchantIds": ["seoul-bowl", "han-table"],
    "preferences": { "warm": true, "avoidIngredients": ["cilantro"], "notes": [] }
  },
  "missingFields": [],
  "readyForConfirmation": true,
  "requiresConfirmation": true,
  "assistantMessage": "Review and confirm this draft. No spending authority is active yet.",
  "inference": {
    "source": "kiln",
    "model": "qwen3-32b",
    "generationId": "provider-generation-id",
    "usage": { "inputTokens": 100, "outputTokens": 40, "totalTokens": 140 },
    "latencyMs": 600
  }
}
```

The timestamp and usage above are **shape examples**, not a recorded request. The planner accepts only catalog merchant IDs, and code checks that budget numbers and merchants were explicitly present in the user's message. An exact deadline is also required. Missing values remain `null`/empty. The result is always a draft; this endpoint cannot grant spending authority.

### `POST /api/agent/recommend`

Request:

```json
{
  "message": "Find a warm dinner without cilantro",
  "preferences": { "warm": true, "avoidIngredients": ["cilantro"] },
  "policy": { "budget": 18, "allowedMerchantIds": ["seoul-bowl", "han-table"] }
}
```

Response has `rankedItemIds`, `itemId`, `merchantId`, `reason`, and the same `inference` object. This is a meal ranking, not a permission decision. Only existing main-meal item IDs are accepted from the model; `plum-tea` is an add-on for the revocation test.

### Errors and Demo Fallback

Invalid request bodies return `400 VALIDATION_ERROR`. Missing Kiln configuration returns `503 KILN_NOT_CONFIGURED`; provider or model-output failures return `502` with a sanitized error code. The upstream error body and API key are never returned.

Either POST route may set `"demoFallback":true`. Only then, after a Kiln failure, the service returns deterministic UI fixture output marked:

```json
{
  "inference": {
    "source": "demo_fallback",
    "model": null,
    "generationId": null,
    "usage": null,
    "latencyMs": null,
    "fallbackReason": "KILN_NOT_CONFIGURED"
  }
}
```

Fallback output is **not Kiln evidence** and must never be represented as a live model result in the demo, slides, audit, or energy calculation. If the Kiln call itself succeeded but failed output validation, the optional `attemptedInference` field preserves its actual measured usage separately. `defaultInferenceLedger.list()` contains real completed Kiln calls only, with no raw user text or prompts, for the later `/api/usage` route.
