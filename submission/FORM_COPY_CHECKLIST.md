# Submission Form Checklist

- **Creator / submitter name:** xlen. Do not use a personal legal name in the submission fields unless the organizer separately requires it for prize administration.
- **Challenge:** FuriosaAI x Bricksum, Challenge B.
- **Project / one-line function:** IntentBound. Paste the declared-function sentence from [Project Introduction](./PROJECT_INTRODUCTION.md).
- **Introduction:** Paste the three paragraphs under "Project Introduction"; retain the simulated-marketplace and testnet-wallet disclosure if the form has a short description field.
- **Model:** Kiln `qwen3-32b` (supplier replacement for the original brief's `gpt-oss-120b`). Report the two flows separately: 358 permission-draft tokens and 436 recommendation tokens; do not substitute cumulative server totals.
- **Demo video:** Upload or link [intentbound-verified-shasta.mp4](../demo/intentbound-verified-shasta.mp4) (2:45, under the three-minute limit). Do not submit the older no-payment preview as the verified run.
 - **Pitch deck:** Attach [IntentBound_GWDC_ChallengeB_v6.pptx](../presentation/output/IntentBound_GWDC_ChallengeB_v6.pptx). It uses the final-video session, 794 tokens, 16 test TRX payment, three rejections, and the simulation disclosure. Do not attach earlier revisions.
 - **Code repository URL:** [zfginucas/intentbound-gwdc2026-seoul](https://github.com/zfginucas/intentbound-gwdc2026-seoul). It is currently **private**; grant judges access or explicitly approve a visibility change before submitting the URL. Include [README](../README.md), [deployment record](../chain/deployments/shasta.json), [final session evidence](../docs/evidence/final-video-shasta-session.json), and [independent audit](../docs/evidence/final-video-independent-audit.json).
- **On-chain proof:** Use payment transaction `fe89db2251a2d9bcda0e41f5e7bd0f447cb22de7fbd625c96fa42119d67ce2ed` and contract `TG8h1Y9myf8iLgDRHFR3oJzfSmt4WCeugq`; point to the matching `PaymentExecuted` record. Mention the two on-chain rejection records and the post-stop rejection if space permits.
- **Before submit:** Verify all uploaded links open, video plays with the intended audio, deck claims match the evidence, and no API key, private key, or seed phrase appears in the repository or media. Submit before **September 30, 2026, 12:00 KST**.
