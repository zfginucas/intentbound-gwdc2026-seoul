IntentBound is a policy-enforced wallet for a personal food-ordering agent that lets users approve, monitor, stop, and independently audit delegated TRON testnet spending.

# IntentBound

**Project creator and hackathon submitter: xlen**

This repository is a working hackathon prototype for GWDC 2026 Korea, FuriosaAI x Bricksum Challenge B. The food merchant catalog, quotes and delivery flow are simulated. Kiln model calls, policy checks, and displayed TRON Shasta transactions come from real execution.

## Product

A user delegates one dinner purchase to a personal AI agent with an explicit all-in budget, merchant allowlist, and expiry. Kiln qwen3-32b helps understand preferences and compare meals. Deterministic code and a restricted spending contract enforce payment limits. The app records both blocked attempts and successful transactions, and provides an independent audit view.

The model supplier changed the available competition model to qwen3-32b. The original challenge PDF names gpt-oss-120b; the team will retain the supplier's update and report only the model actually called.

The current demo uses separate server-held Shasta testnet keys for the owner and the agent. Clicking approval in the UI asks the demo server to sign with the owner test key. This is **not** a production noncustodial wallet integration or a claim that Mina's personal TronLink wallet signed.

## Status

| Component | Current verification |
| --- | --- |
| Kiln qwen3-32b planning and recommendation | Real calls succeeded; initial input/output token evidence is in [kiln-live-smoke.json](./docs/evidence/kiln-live-smoke.json) |
| Deterministic policy and independent evidence replay | Local tests pass; one real Shasta session passed all 10 audit checks |
| TRON SessionVault | Compiled with TRON Solidity 0.8.20 and deployed on Shasta |
| TRON Shasta payment | Two distinct on-chain rejections, one 16 test TRX transfer, an owner revoke, and a post-revoke rejection confirmed |
| Frontend | Responsive Dinner Run, permission, activity, receipt/audit and model-usage views; desktop/mobile browser tests pass |

## Local Setup

Requires Node.js 22 or newer.

~~~sh
npm --prefix chain install
npm --prefix server install
npm --prefix web install
npm run dev:api
~~~

Run the web app in a second terminal:

~~~sh
npm run dev:web
~~~

The app runs at http://127.0.0.1:5173 and the API at http://127.0.0.1:8787. Both development servers bind only to the local loopback interface. The server reads local chain/.env.local and server/.env.local when present. For this local workspace only, it can also read the first line of the ignored Kiln_API file if KILN_API_KEY is not set. Do not expose that file or copy its contents into client code.

Run all current checks with:

~~~sh
npm run check
~~~

## Shasta Testnet

The dedicated demo owner is TTMWWb3XEtQ3C7i8vBB2xiZShNgWsuEdZK. The deployed SessionVault is **TG8h1Y9myf8iLgDRHFR3oJzfSmt4WCeugq**. Deployment transaction: **8d4d1b915e451ed114b1156aeeef5a624dd27d2c25d9ca7bb957f2f933f94117**.

One complete real session has ID **0xc16315061b33ed4b4b094a76749ac5631660fb94f1eb6638899d59c6ecc09c63**:

| Step | Confirmed Shasta transaction | Result |
| --- | --- | --- |
| Owner approval and 18 test TRX funding | 2cad437455dc7fd0a530c6a568dc7ce015b2f3055ab591ea0277f43fefecead6 | SessionCreated |
| A: 15 + 2 + 2 = 19 | e0f5b377c663499637f4f8b1ce713ecdc21f1ce8960c2d4e98a7f10e94524208 | OVER_LIMIT; spent remains 0 |
| B: 14 to an unapproved address | 829a43f33bd8f6f0c887633b524c84dcc5af3d040ed42c363870935aabb18a1c | MERCHANT_NOT_ALLOWED; spent remains 0 |
| C: 13 + 2 + 1 = 16 | 4d0115f916def42b2fdbc38f2044ea6dcba7c128e8cab129c16dbf1de70d654a | PaymentExecuted; Han Table receives 16 test TRX |
| Owner stop | 55e2320bd8d2bc0106879cbe0af6660d2afb231b25b4aa56d1f67eee23e9b665 | SessionRevoked |
| D: 1 after stop | 991cf2473e931c7beb7cc611d5cf38c2ad2b32b8523a74a76ec9c421caa461ae | REVOKED; spent remains 16 |

The [raw session evidence](./docs/evidence/shasta-session-evidence.json), [API audit result](./docs/evidence/shasta-audit.json), and [standalone no-key audit result](./docs/evidence/shasta-independent-audit.json) are included. The API auditor passed 10 checks; the standalone auditor passed 12 checks after independently fetching public Shasta receipts. The standalone verifier can be run without either wallet private key:

~~~sh
npm run audit:shasta
~~~

Changing the exported C quote amount caused the standalone verifier to fail, rather than repeating a stored PASS result. These testnet events prove restricted payment behavior, not the authenticity of the simulated food merchants or food delivery.

## Submission Demo

The [2:45 Hailuo-voiced Shasta video](./demo/intentbound-verified-shasta-hailuo.mp4) is the current submission video. Its [audio-only narration](./demo/intentbound-hailuo-voiceover.mp3) and [voice-generation manifest](./demo/hailuo-voiceover-manifest.json) are also included. The [silent verified master](./demo/intentbound-verified-shasta.mp4) and older [Samantha narration](./demo/intentbound-verified-shasta-voiced.mp4) remain available as backups; all three have the same 165-second verified visuals. The matching [session evidence](./docs/evidence/final-video-shasta-session.json), [12-check standalone audit](./docs/evidence/final-video-independent-audit.json), and [two Kiln calls](./docs/evidence/final-video-kiln-usage.json) are included. That run used 358 tokens for the permission draft and 436 for the meal choice, **794 actual Kiln tokens** in total. See [energy-estimate.md](./docs/evidence/energy-estimate.md) for the explicitly illustrative, unmeasured energy scenario.

The [judge-facing project introduction](./submission/PROJECT_INTRODUCTION.md) and [submission checklist](./submission/FORM_COPY_CHECKLIST.md) use this same final-video session rather than the earlier API smoke run.

The editable [six-slide English pitch deck](./presentation/output/IntentBound_GWDC_ChallengeB_v6.pptx) is aligned with that video and its evidence. Earlier deck revisions are not submission versions.

To inspect balances or repeat deployment with a new testnet wallet:

~~~sh
npm run shasta:status
npm --prefix chain run shasta:fund-agent
npm --prefix chain run shasta:deploy
~~~

Restart the API after changing chain/.env.local so it reads the current contract address. The interface does not show a paid state until a Shasta receipt and matching contract event are confirmed. To return unspent test TRX from a revoked or expired session, run the owner-only chain withdrawal script with its session ID.

## Development Plan

See [detailed product design](./方案设计/01_IntentBound_详细设计方案.md) and [implementation and acceptance plan](./方案设计/02_实施与验收计划.md).

## Security

Do not commit the local Kiln_API file or any private key. Use local environment variables for Kiln and TRON testnet credentials. Never use a mainnet key or fund the demo with real assets. Do not expose the local API or Vite proxy publicly: this demo uses server-held testnet signing keys and does not have production authentication. The contract enforces this prototype's payment boundary, but the simulated merchants do not prove food delivery or real-world price accuracy.
