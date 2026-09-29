# IntentBound

**Creator and submitter:** xlen

**Challenge:** FuriosaAI x Bricksum, Challenge B: Controls and Records for an AI Agent That Spends

**Declared function:** IntentBound is a policy-enforced wallet for a personal food-ordering agent that lets a user approve, monitor, stop, and independently audit delegated TRON testnet spending.

## Project Introduction

Picture a builder who wants dinner delivered while finishing a hackathon project. Their personal agent can compare meals, but it should not decide for itself how much money it may spend or where it may send it. IntentBound turns the user's request into a reviewable spending permission: an all-in budget, approved recipient addresses, and an expiry. The user confirms that permission before the demo owner wallet funds a restricted session. The demo then submits purchase attempts with a separate agent testnet key, while the TRON Shasta `SessionVault` contract enforces the payment cap, merchant allowlist, deadline, and owner revocation. Every attempted payment produces a success or rejection record that a third party can replay against the approved policy and public transaction receipts.

Kiln's `qwen3-32b` handles the language tasks: drafting permission from the dinner request and recommending a meal. Deterministic code calculates the fee-inclusive quote and checks the payment request; the contract, not the model, controls whether test TRX leaves the session. In the verified run, a 19 test TRX all-in quote exceeded the 18 test TRX cap, a 14 test TRX attempt to an unapproved address was rejected, a compliant 16 test TRX payment succeeded, and a further 1 test TRX attempt was rejected after the owner pressed Stop. The four payment decisions required no additional Kiln inference.

This is a **testnet prototype**, not a live delivery integration. Restaurants, menus, quotes, and fulfillment are simulated. The Kiln calls, policy checks, Shasta transactions, and independent audit are real. The demo server holds separate owner and agent **testnet** signing keys; approval in the UI is not a signature from the user's personal wallet, and the current architecture is not a production noncustodial wallet.

## Evidence From The Final Video Session

- **Video:** [2:45 Hailuo-voiced verified Shasta demo](../demo/intentbound-verified-shasta-hailuo.mp4), 1920 x 1080. It is an edited capture of the product and one verified session, not an uncut live recording. The [silent verified master](../demo/intentbound-verified-shasta.mp4) remains a backup.
- **Deployment:** `SessionVault` at `TG8h1Y9myf8iLgDRHFR3oJzfSmt4WCeugq` on TRON Shasta; [deployment record](../chain/deployments/shasta.json). Session ID: `0xc6ff6c2d326a69a868023cf768edef7a171b6a0756f90161e928bcceab788b1d`.
- **On-chain payment:** 16 test TRX to the approved recipient, transaction `fe89db2251a2d9bcda0e41f5e7bd0f447cb22de7fbd625c96fa42119d67ce2ed`, matching the `PaymentExecuted` event in the [session evidence](../docs/evidence/final-video-shasta-session.json). The same file records the two earlier `AttemptRejected` events, owner revoke, and post-revoke rejection with transaction hashes.
- **Independent check:** The [no-key verifier result](../docs/evidence/final-video-independent-audit.json) passes 12 checks against the exported policy and public Shasta receipts, including the 16 test TRX contract spend. Run `npm run audit:shasta -- docs/evidence/final-video-shasta-session.json` to repeat verification.
- **Kiln usage by flow:** Permission draft: 261 input + 97 output = **358 tokens**. Meal recommendation: 358 input + 78 output = **436 tokens**. Total for these two real calls: **794 tokens**; see [response metadata](../docs/evidence/final-video-kiln-usage.json). `qwen3-32b` is the model supplied for this event in place of the model named in the original challenge brief.
- **Energy disclosure:** The [0.694 Wh scenario](../docs/evidence/energy-estimate.md) assumes four 150 W cards draw nameplate TDP throughout 4.162 seconds of observed API latency. It is **illustrative, not measured request energy**; it does not establish a GPU savings percentage.
