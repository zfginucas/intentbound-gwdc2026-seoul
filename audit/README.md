# Independent Shasta Audit

This verifier needs the exported session evidence JSON and the public TRON Shasta node. It does not read Kiln credentials or either testnet private key.

Run from the project root after installing chain dependencies:

~~~sh
npm run audit:shasta
~~~

To inspect another exported record:

~~~sh
npm run audit:shasta -- path/to/session-evidence.json
~~~

It re-computes the policy hash, reads the current contract policy and allowlist, checks the approval and stop transactions, replays every quote and decision against independently fetched Shasta events, and checks that the sum of payment events equals the contract's spent total. A passing result proves the recorded **testnet financial boundary**, not that a simulated restaurant delivered a meal.
