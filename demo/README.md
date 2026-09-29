# IntentBound demo video

The submitted video target is **2:45 (165 seconds)**, leaving 15 seconds under the three-minute limit. `capture.mjs` records the actual React product at 1920x960. `render.mjs` composes those real UI frames with an editorial caption band at 1920x1080, checks the duration, and optionally adds a recorded voiceover. The restaurant/menu/quote data are simulated; no frame claims real food delivery.

## Verified Shasta run

- [Silent verified MP4](intentbound-verified-shasta.mp4): **165.00 seconds, 1920x1080**. This is the evidence-checked 2:45 animatic; it uses real product frames, not fabricated chain graphics.
- [Optional narrated MP4](intentbound-verified-shasta-voiced.mp4): the same verified frames and timing with local macOS Samantha narration. The silent master remains untouched and is preferable if a human voiceover is available.
- [Evidence snapshot](evidence/capture.json): one new Shasta session, on-chain A/B rejections, C payment, revoke, D post-stop rejection, and a **10-check passing public audit**. The [raw session evidence](evidence/shasta-session-evidence.json), [audit response](evidence/shasta-audit.json), and [this run's Kiln usage](evidence/kiln-usage-this-run.json) are included beside the [captured frames](evidence/shots/).

This run's two real Kiln `qwen3-32b` calls used **619 input + 175 output = 794 reported tokens**. The recipient directory, quotes, and fulfillment remain simulated. The current video was captured in two browser segments on the **same session** after a UI label changed mid-recording; `capture.json` discloses the resume. No smoke-session transaction was substituted.

## Draft preview

 - A local-only draft preview is kept on the presentation machine but ignored by Git. It is 52 seconds, silent, and explicitly marked **DRAFT PREVIEW / NO PAYMENT**. It contains actual product screens and two live Kiln calls. It is **not** the Challenge B submission video.
- [Voiceover and shotlist](shotlist.md): the English 2:45 production script and exact edit beats.
- [Live captions](captions-live-only.srt) and [preview captions](captions-preview.srt): optional caption tracks for an editor. The animatic already has short burned-in scene captions.

Each capture directory contains `capture.json` and raw browser footage. Its `kiln-usage-this-run.json` isolates the two calls made by that run, while `kiln-usage-server-snapshot.json` preserves the cumulative `/api/usage` response, including earlier rehearsals. `11-usage.png` shows the cumulative overview; `12-usage-current.png` shows the two current rows. The animatic labels the distinction. The older preview's chain was **not configured**; no transaction or audit result is presented there.

## Reproduce

Prerequisites: Node, Chrome, FFmpeg/FFprobe, `npm ci --prefix web`, the web app on `http://127.0.0.1:5173`, and the API on `http://127.0.0.1:8787`. The API needs a real Kiln key for both modes. Other URL/Chrome configurations can be set with `INTENTBOUND_WEB_URL`, `INTENTBOUND_API_URL`, and `PW_CHANNEL`.

```bash
node demo/capture.mjs preview
node demo/render.mjs demo/output/preview-<timestamp> --output demo/intentbound-preview-no-payment.mp4
```

The preview script calls Kiln twice with **Scripted fallback unchecked** and never clicks the funding button. If Kiln fails, capture stops incomplete instead of silently switching to fake usage.

After the Shasta owner and agent wallets have enough test TRX and the vault is deployed/configured:

```bash
node demo/capture.mjs live
node demo/render.mjs demo/output/live-<timestamp> --output demo/intentbound-verified-shasta.mp4
```

The live recorder requires a configured Shasta contract; real Kiln plan and recommendation metadata; a confirmed funded session; confirmed on-chain A/B rejections, C payment, and D post-revoke rejection; unchanged spend on rejected attempts; a confirmed revoke; and a passing read-only audit. It exports the raw `/api/sessions/:id/evidence` response as `shasta-session-evidence.json` and the audit response as `shasta-audit.json`. The renderer checks the resulting evidence manifest again. An incomplete run cannot be labeled or rendered as verified.

If a UI-only interruption happens after revoke, resume that **same session** instead of funding a second one:

```bash
node demo/resume-live.mjs demo/output/live-<timestamp>
node demo/render.mjs demo/output/live-<timestamp> --output demo/intentbound-verified-shasta.mp4
```

The resumed capture is disclosed in `capture.json`; `raw-ui-initial.webm` and `raw-ui-resume.webm` preserve both real browser segments. This was used for the current verified run after the frontend renamed the Case D button during capture.

To generate the optional local narration and mux it into a separate file:

```bash
node demo/voiceover.mjs demo/output/live-<timestamp>
node demo/render.mjs demo/output/live-<timestamp> --voiceover demo/output/live-<timestamp>/voiceover-Samantha.wav --output demo/intentbound-verified-shasta-voiced.mp4
```

Without `--voiceover`, the MP4 has a silent audio track ready for editing. Use `raw-ui-initial.webm` and `raw-ui-resume.webm` from this capture directory for animated click/scroll cutaways; the animatic uses still product frames to hold exact beats. In the finished edit, keep the simulated-marketplace disclosure visible and indicate when Shasta confirmation waits have been shortened.

## Network fallback

Keep the last **fully verified** `intentbound-verified-shasta.mp4` and its `capture.json` on the presentation machine. If live Kiln or Shasta stalls on stage, say that the live network is unavailable and play that prerecorded, dated verified run. Do not toggle the scripted fallback and call it live. If no verified recording exists, play only the clearly labeled no-payment preview and state that the on-chain requirement remains incomplete. The recorder preserves partial screenshots and a failure message in `capture.json` for debugging, but never renders them as proof.

Check every frame for keys, wallet seed phrases, personal addresses, and unsupported chain claims before upload. Public transaction IDs and contract addresses may appear; secrets may not.
