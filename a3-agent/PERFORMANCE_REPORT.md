# Performance report — A3 hybrid-LLM personal assistant

Deployment: OpenClaw 2026.10.9 on a Cloud Run Instance (us-west1, **2 vCPU / 4 GiB**).
Cloud model `openai/gpt-5.6-sol` (ChatGPT Edu OAuth), **thinking: low** (`agents.defaults.thinkingDefault`).
Local model `ollama/gemma4:e4b` on an RTX 5080 (16 GB), context 32768, **thinking: off**, `keep_alive: -1`,
reached over Tailscale.

Data sources: the routing log (one JSON line per decision, no message text), OpenClaw's
automation run history (`a3job runs <job>`), and the lifecycle log. The full export covers
2026-11-16 06:04 → 2026-11-17 22:30 UTC: **179 routing decisions** (116 cloud, 57 local,
6 held), in `evidence/routing_log.json`. Times are wall-clock for the whole agent turn, from
model selection to the end of the run, including tool calls.

## 1. Latency by task type

| Task type → route (rule) | n | p50 | p90 | min | max | Notes |
|---|---|---|---|---|---|---|
| simple → **local** (`simple_local`), success | 11 | 7.8 s | 12.5 s | 1.2 s | 15.3 s | Arithmetic, short chat, memory recall ("Bluebird") |
| simple → local, failed | 6 | — | — | 3.4 s | 300.7 s | All before the v17 fix: two 300 s timeouts in the Tailscale black hole (section 4), plus stream/incomplete errors on a cold or recovering link |
| background turn in a private session → **local** (`private_session_local`) | 38 | 1.8 s | 2.9 s | 1.3 s | 3.5 s | Heartbeat checks every 30 min, overnight Nov 17 |
| private → **local** (`privacy_local`) | 1 | 5.7 s | — | — | — | "This is confidential: say 'back online'…" |
| private → **held** (`privacy_held`, `private_session_held`) | 6 | 0.1–4.4 s | — | — | — | Local offline (Ollama quit on purpose), or idle-link probe timeouts before v17 |
| tool use → **cloud** (`tools_cloud`) | 15 | 14.5 s | 40.8 s | 2.8 s | 93.2 s | Calendar reads, drafts, sends, web search |
| short follow-up → cloud (`tools_session_cloud`) | 8 | 11.7 s | 24.5 s | 3.4 s | 24.5 s | "yes" after a tool turn |
| reasoning → **cloud** (`reasoning_cloud`) | 50 | 18.6 s | 47.9 s | 1.7 s | 190.9 s | "Explain step by step…", and the alert job (its prompt matches reasoning keywords first) |
| simple → cloud (`default_cloud`) | 41 | 4.6 s | 11.1 s | 3.5 s | 38.6 s | Mostly background turns while local was down or cooling down on Nov 16 |

Full tool-using scheduled turns (automation run history, cloud route):

| Job | Duration | Tokens (total / cached / output) | Tools used |
|---|---|---|---|
| Morning briefing (manual run, 02:51 UTC) | 183.7 s | 208,251 / 186,112 / 2,372 | gog calendar, gog gmail, weather |
| Proactive alert (02:15 UTC, nothing to report → silent) | 163.5 s | 53,988 / 38,400 / 506 | gog calendar, gog gmail |
| End-of-day recap (manual run, 02:55 UTC) | 119.5 s | not reported | gog gmail, gog calendar, session history |

Takeaways:

- Local Gemma is fastest for short turns when the link is healthy (p50 7.8 s, best 1.2 s;
  most of the spread is first-token time after OpenClaw's ~21k-token system prompt).
- Tool-using turns are dominated by tool round-trips, not model speed: the briefing made
  several gog calls and a weather fetch, each a full model ↔ tool cycle.
- The cloud's prompt cache does most of the work: 89% of the briefing's input tokens were
  cache reads.

## 2. Quality

| Observation | Evidence | Consequence |
|---|---|---|
| Gemma e4b answers short factual and memory questions correctly | Short arithmetic and chat answered locally; "What is my fictional project called…" → "Bluebird, Friday Nov 20" after a restart | Kept `simple → local` |
| **Gemma e4b fails multi-step tool calls** on OpenClaw's prompt | A "yes, send it" routed to Gemma failed the send 3 times; OpenClaw stopped the turn ("3 consecutive failures of the same tool call") | Added `tools_cloud` (calendar/email/search/weather → cloud) and `tools_session_cloud` (short follow-ups to a tool turn stay on cloud). After the change: 15/15 tool turns succeeded in the sample |
| Cloud model handles calendar, drafts and approved sends | Calendar answer, Gmail draft saved, approved send delivered once | — |
| Scheduled outputs are grounded in real account data | Briefing listed the actual test-calendar events, unread count and LA weather; recap listed the sent "A3 test" mail, drafts and the conversation's requests | — |

## 3. Cost

| Component | Cost model | Observed |
|---|---|---|
| Cloud model | ChatGPT Edu seat (flat, OAuth); no per-token bill, but a usage meter (5-hour and weekly windows) | `/status` showed 98–99% remaining during testing. The alert job used ~54k tokens per run, so it runs every **30** minutes, not 15 (≈2.6M tokens/day instead of ≈5.2M) |
| Local model | Desktop electricity only | Gemma resident in VRAM (`keep_alive: -1`), 100% GPU in `ollama ps` |
| Cloud Run Instance | Always-on 2 vCPU / 4 GiB in us-west1 | See the project's Billing report for the run window; size chosen from the measurements in section 4, not guessed |
| GCS bucket, Secret Manager, Logging | Small (a few MB of snapshots and logs) | — |

Routing directly saves cloud usage: 57 of 179 decisions (32%) were answered locally at zero
marginal cost, and every privacy-sensitive turn stays local or is held by policy.

## 4. Sizing and reliability measurements

**CPU (1 vs 2 vCPU).** On 1 vCPU the boot was CPU-starved: the first attempts failed four
times in a row with `startup_failed: router plugin install failed` (04:22–04:48 UTC Nov 16),
and the boot that succeeded took **6 min** from `start` to `gateway_started`, with SQLite
host-admission timeouts and failed cron maintenance. On **2 vCPU**, boots take about
**2 min 10 s** (00:04:24→00:06:33, 01:04:44→01:07:02, 02:04:25→02:06:45 UTC Nov 17).

**Memory (2 vs 4 GiB).** At 2 GiB the gateway was killed for out-of-memory (exit 137) five
times on Nov 16 (07:03, 13:50, 13:58, 14:09, 14:19 UTC), including when one request spawned
two sub-agents; the idle baseline was ~1.6 GiB. Each OOM restart recovered automatically from
the last snapshot. After moving to 4 GiB there were no further exit-137 events.

**Tailscale path.** After the desktop woke from sleep, local turns hung for 300 s. A
request-size ladder from the container showed the direct UDP path dropped anything over
~1 KB (600 B passed, 1,100 B failed), while the DERP relay passed 120 KB in 0.5 s. Fix: pin
the container to DERP (`TS_DEBUG_ALWAYS_USE_DERP=true`), add a padded (3 KB) health probe
so a black-holed path fails the probe instead of a real turn, and a 5-minute local cooldown
after a local timeout.

**Desktop availability.** An overnight outage (23:07–10:24) was Windows sleep (confirmed by
the Power-Troubleshooter event). During it the router sent normal turns to the cloud and
would have held private ones. Sleep and hibernate are now disabled for the run window.

**Scheduled-job setup timeouts.** Two alert runs failed with "isolated agent setup timed out
before runner start" (OpenClaw's fixed 60 s pre-model watchdog) while operator CLI commands
were running over SSH on the same 2 vCPUs. Runs without concurrent CLI activity succeeded.

**Idle-link health probes.** On the evening of Nov 16, background turns at 20:50, 21:20 and
21:26 in a private session were held with `local_unavailable` (probe latency ≈ 4.3 s, i.e. the
3 s probe timed out) while Ollama was loaded and Tailscale was connected. The first request
after ~30 idle minutes over the relay was slower than the probe timeout. Fix (v17): one
immediate second probe on a network failure, never on "model not listed"; at most two short
probes, no loop. Result: after the v17 deploy, 66 decisions overnight (Nov 17 06:30–22:30
UTC), 0 held, 0 failed; the 32 local ones had p50 1.7 s, max 3.5 s. A side effect worth noting: a held background turn posts the hold message
into the chat, which looks like a failed send to the user; starting a new session (`/new`)
ends the private session and stops it.

**Failed optional deploy and outage (Nov 17–18).** After submission, v19 tried OpenClaw-managed
Tailscale Serve for tokenless grader access. OpenClaw rejected it at boot
("gateway.bind must resolve to loopback when gateway.tailscale.mode=serve"), because this
deployment binds the gateway to the container network so Cloud Run's TCP startup probe can
reach it. The entrypoint failed closed four times (06:02–06:12 UTC Nov 18) and Cloud Run left
the instance stopped. It was restored at 18:40 UTC by redeploying the same image with
`-ManagedServe 0` and `gcloud beta run instances start`; the rejected setting was never saved,
so the snapshot restored cleanly. Downtime: about 12.5 hours. On the restart, the missed
morning briefing ran as a catch-up and hit the 60 s setup watchdog while the agent was still
in startup preparation (reported as two failures in Telegram). Lesson: optional changes go
through a soak run before they are left unattended, and the restart policy alone does not
recover from a deterministic boot failure.

**Restarts and state.** Planned restarts (deploys) log `shutdown_begin` → `state_snapshot`
→ `state_restored` → `gateway_started`. Once (05:34 UTC Nov 16) the container was stopped
before the shutdown snapshot finished, so the next boot restored the previous snapshot; for
that reason a manual snapshot is taken after any sign-in. The memory test proved recall
across a restart (fact saved 17:50, instance restarted 18:03–18:06, recalled 18:15 Pacific).

## 5. Routing correctness

The router is a pure function with ordered rules (`src/router/decide.ts`), covered by unit
tests for every rule including the HELD path. Live, every one of the 179 decisions matches its
rule: privacy-sensitive turns are local or held, tool turns are cloud, short non-tool turns
are local when the local model is healthy. The video shows the four required requests
(local → cloud → held → local) with the routing log on screen.

Reproduce the routing table:

```
gcloud logging read 'jsonPayload.component="a3-router"' --project=a3-sosapineda-599 --freshness=2d --order=asc --format=json > evidence/routing_log.json
```

## 6. Limits of this report

- The sample is one day of real use by one person, not a benchmark.
- The run window was about 40 hours (Nov 16 ~04:30 → Nov 17 ~22:30 UTC), shortened to fit
  the deadline. Lifecycle (26 starts: 21 restored from snapshot, 4 failed boots on 1 vCPU,
  5 OOM restarts at 2 GiB, the rest planned deploys), routing and approval logs are exported
  in `evidence/`.
- Latencies include OpenClaw's own overhead (system prompt ~21k tokens, tool scaffolding),
  which dominates for short local turns.
