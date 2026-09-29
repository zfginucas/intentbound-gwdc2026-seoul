# IntentBound chain layer

This package enforces a delegated food-ordering budget on **TRON Shasta** using native **test TRX**, not USDC. On-chain amounts are integer **SUN** (`1 TRX = 1,000,000 SUN`). It must never be pointed at TRON mainnet.

## Contract behavior

`SessionVault` locks a user's test TRX inside a session. The owner chooses an agent relayer, merchant payment addresses, a total spending cap, a per-payment cap, and an expiry. Only the agent can call `attemptSpend`. A valid attempt transfers native TRX to the approved merchant. A policy violation emits `AttemptRejected` in a successful transaction without transferring funds. The owner can revoke immediately, then withdraw unspent escrow. Revocation and withdrawal are separate so a refund failure cannot prevent stopping the agent.

The contract checks addresses, amounts, expiry, escrow, replayed attempt IDs, and revocation. It **does not** verify menu contents, delivery, quote signatures, or quote expiry. The backend should hash its canonical quote JSON with SHA-256, pass the resulting `0x`-prefixed 32-byte hash, and independently check quote expiry and fee arithmetic. Agent gas and owner deployment gas are paid by their respective test wallets, outside the 18 TRX escrow.

| Code | On-chain rejection reason |
| ---: | --- |
| 1 | `REVOKED` |
| 2 | `EXPIRED` |
| 3 | `INVALID_AMOUNT` |
| 4 | `MERCHANT_NOT_ALLOWED` |
| 5 | `OVER_LIMIT` |
| 6 | `PER_PAYMENT_LIMIT` |
| 7 | `INSUFFICIENT_ESCROW` |
| 8 | `INVALID_QUOTE` |
| 9 | `DUPLICATE_ATTEMPT` |
| 10 | `TRANSFER_FAILED` |

Unknown sessions, non-agent callers, and zero attempt IDs revert instead of emitting a rejection. A duplicate attempt ID can never be paid twice. `PaymentExecuted` and `AttemptRejected` each include `sessionId`, `attemptId`, merchant, amount in SUN, and quote hash; the payment event also includes cumulative spend and escrow remaining. The contract ABI is [artifacts/SessionVault.json](artifacts/SessionVault.json).

## Build and test

```bash
cd chain
npm install
npm run compile    # TronBox, pinned TRON Solidity 0.8.20
npm test           # Ganache tests using a separate upstream EVM artifact
```

`artifacts/SessionVault.json` is produced by the **TRON** compiler and is the only artifact the Shasta deployer or client loads. `artifacts/SessionVault.evm.json` is an ignored, upstream-solc build used solely for local behavior tests. Local EVM tests do not substitute for a real Shasta transaction.

## Wallets and Shasta deployment

```bash
npm run wallets             # once; creates ignored .env.local, mode 0600
npm run shasta:status       # displays public addresses and balances
npm run shasta:fund-agent   # optional: owner tops agent up to 150 test TRX
npm run shasta:deploy       # only after owner receives test TRX
npm run shasta:withdraw -- 0x<session-id>  # after revoke/expiry, return unspent escrow
```

The official [Shasta faucet](https://shasta.tronex.io/join/getJoinPage) requires human Turnstile verification. Fund the **owner** wallet for deployment, the 18 TRX escrow, creation, revocation, and withdrawal; fund the **agent** wallet for each attempted payment, including rejected attempts. A conservative initial target is **300-500 test TRX for owner** and **100-200 test TRX for agent**, subject to Shasta's current energy price. Alternatively, fund only the owner with **at least 500 test TRX**, then run `npm run shasta:fund-agent` to transfer only the difference needed to bring the agent to 150 test TRX. Merchants do not need prefunding to receive test TRX. These are resource allowances, not product prices.

Dedicated public demo wallets (private keys exist only in ignored `.env.local`):

| Role | Shasta address |
| --- | --- |
| Owner | `TTMWWb3XEtQ3C7i8vBB2xiZShNgWsuEdZK` |
| Agent | `TUNZmDHYGUKuk2yQcEn9YVSm8oZRtNbcRj` |
| Seoul Bowl | `TDLxYZ1KbF6kvcDeJeyKB6pFv157h8xitt` |
| Han Table | `TB2sCSX5RDK8GMFT1ZTSsR8FsP1nWPFM5b` |
| Unauthorized Han Table Express | `TDiTQkRBsW6Z7v15s5gYMi1SHKz1VGQkFe` |

`shasta:deploy` writes the confirmed contract address and deployment transaction hash to `deployments/shasta.json`. Put that address in `CONTRACT_ADDRESS` in `.env.local` for integration. Never commit or display the private keys. This is a demo custody setup: the scripted owner key stands in for a user wallet. Do not claim the user signs in their own wallet unless a real wallet-confirmation flow is added.

## Backend client

`src/client.mjs` provides `createShastaClient({ contractAddress, rpcUrl, tronGridApiKey })`. It exposes `createSession(policy, ownerPrivateKey)`, `fundSession`, `attemptSpend(attempt, agentPrivateKey)`, `revokeSession`, `withdrawSession`, `getSession`, `getAttemptStatus`, `getTransactionInfo`, and `waitForTransaction`.

```js
import { createShastaClient } from './src/client.mjs';

const chain = createShastaClient({ contractAddress: process.env.CONTRACT_ADDRESS });
const receipt = await chain.attemptSpend({
  sessionId, // 0x-prefixed bytes32
  attemptId, // new 0x-prefixed bytes32 on each attempt
  merchant: 'TB2sCSX5RDK8GMFT1ZTSsR8FsP1nWPFM5b',
  amountSun: '16000000',
  quoteHash, // SHA-256 canonical quote JSON, 0x-prefixed bytes32
}, process.env.AGENT_PRIVATE_KEY);
```

The client waits for a transaction receipt and locally decodes `PaymentExecuted` or `AttemptRejected`. It returns `status: "confirmed" | "failed" | "pending"`, `txHash`, block number, energy and fee when available, `events`, and a `decision` for attempted spending. A broadcast hash alone is **not** proof of payment. Explorer URL: `https://shasta.tronscan.org/#/transaction/{txHash}`.

Until `deployments/shasta.json` exists with a confirmed transaction, the chain is **compiled and locally tested, not deployed**. Do not use example hashes or claim a live payment.
