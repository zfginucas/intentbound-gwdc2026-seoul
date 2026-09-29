# Kiln Inference Energy: Explicit Assumption Scenario

This file contains clearly labeled illustrative estimates for real Kiln API calls. It is **not** measured power consumption for those requests, and it is not a comparison with a GPU.

## Final Verified Video Run

The complete frontend-to-Shasta recording has its two real Kiln responses in [final-video-kiln-usage.json](./final-video-kiln-usage.json). The independently verified chain session is in [final-video-shasta-session.json](./final-video-shasta-session.json).

| Flow | Input tokens | Output tokens | Total tokens | End-to-end latency |
| --- | ---: | ---: | ---: | ---: |
| Permission draft | 261 | 97 | 358 | 2.791 s |
| Meal recommendation | 358 | 78 | 436 | 1.371 s |
| Total | 619 | 175 | 794 | 4.162 s |

Using the hardware scenario defined below, the arithmetic is 600 W x 4.162 s / 3,600 s/h = **0.694 Wh illustrative**. This number is not Kiln's measured request energy. The four payment decisions themselves made no additional Kiln call in this recorded run.

## Earlier Live Smoke Run

| Flow | Input tokens | Output tokens | Total tokens | End-to-end latency |
| --- | ---: | ---: | ---: | ---: |
| Permission draft | 260 | 97 | 357 | 1.970 s |
| Meal recommendation | 358 | 75 | 433 | 1.757 s |
| Total | 618 | 172 | 790 | 3.727 s |

The earlier run is preserved in [kiln-live-smoke.json](./kiln-live-smoke.json). Its response-generation IDs and timestamps are in that file. Token counts and latencies in both run tables are actual Kiln API response metadata, not synthetic merchant data.

## Assumed Hardware Scenario

FuriosaAI's public Qwen3 dense model guide lists **four RNGD cards** for its Qwen3-32B-FP8 deployment. Its RNGD hardware guide lists **150 W TDP per card**. These specifications do not establish which physical machines handled our Kiln requests, their measured power draw, or how a shared service should allocate energy to one user.

For an intentionally simple scenario, assume the four-card deployment and assign all four cards' nameplate TDP to the two requests for their entire observed end-to-end latency. For the earlier smoke run:

~~~text
assumed power = 4 cards x 150 W TDP/card = 600 W
observed elapsed time = 1.970 s + 1.757 s = 3.727 s
scenario energy = 600 W x 3.727 s / 3,600 s/h = 0.621 Wh
~~~

This 0.621 Wh number is **illustrative only**. TDP is not measured active power. API latency includes network and queue time and is not measured inference time. The calculation excludes host, storage and network energy. It therefore is neither a measured Kiln per-request figure nor a defensible GPU savings percentage.

## Design Efficiency Claim We Can Test

The model handles ambiguous food preferences and ranks meals. Amount arithmetic, merchant allowlisting, expiry, remaining budget and revocation use deterministic code and the TRON contract. The planned four payment attempts should require **zero additional LLM calls** after planning and recommendation. Verify that claim from final-run usage records before putting it on a slide.

## Primary Sources

- FuriosaAI Qwen3 dense model deployment table: https://developer.furiosa.ai/latest/en/furiosa_llm/models/qwen3.html
- FuriosaAI RNGD hardware specifications: https://developer.furiosa.ai/latest/en/overview/rngd.html
