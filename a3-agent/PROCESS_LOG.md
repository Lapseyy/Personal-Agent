# Process log — A3 hybrid-LLM personal assistant

Edmarck Sosa Pineda · CSCI 599 · Fall 2026

## AI tools used

- **Claude (Anthropic) in claude.ai with a cloud workspace linked to my desktop** — Claude Fable 5.2 and Claude Opus 5.5 (switched mid-project). Used as a pair engineer for code, configuration, debugging and documentation drafts.
- **Gemma 4 E4B (`gemma4:e4b`) via Ollama** — runtime model of the agent (local route), not a development tool.
- **OpenAI GPT-5.6 (sol) via ChatGPT Edu** — runtime model of the agent (cloud route), not a development tool.

## Narrative

I set out to build a personal agent that is able to summarize, retrieve, and create ways to make daily worklife simpler. I chose OpenClaw, Telegram, and local Gemma as I thought it would make the process easier as my computer has the power to do it. Personally, the hardest hump that I had to get over was understanding why the 1 vCPU instance kept failing, which caused a lot of headaches. There was also the approval gates that kept not working and causing me to redeploy multiple instances. I had the AI create a sort of pathway of what to do and what I had to do is make sure what it suggested actually connected, and make sense for the scope of the project. Being very precise is what allowed me to catch the different edge cases of Gemma fall back, creating a gist, making sure there is proper prompt injecting for security, and being proactive in latency of the model and using it how a regular person would.


Prompts that produced material output (verbatim or near-verbatim):

- "For some reason it is stalled? Is it because i dont have my .env folder on file?" — led to the boot investigation and, eventually, the 1 vCPU → 2 vCPU change.
- "From earlier you said you needed … Is this what this build contains? What files have you changed? I want to know before I start deployment again" — from then on every build came with a change list before deploying.
- "I can access it now … how far away are we from completing the project?" — produced the remaining-work plan mapped to the rubric.
- "Lets make a mock run of all scenarios that will be covered in the grading portion." — the dry run that exposed the `/new` and private-session problems before recording.
- "Here are the results" (with the approval and routing log tables) — each log paste drove one of the approval-gate and routing fixes (v9–v12, v17, v18).

## Verification narrative

I did not accept generated code because it ran. Every module has unit tests (92 by the end): every routing rule including the HELD path, the approval policy, the recipient allowlist, single-use tokens, scheduled-run blocking, and injection cases; every bug found live got a regression test with the exact input from the logs. Hook behaviour and config keys were checked against the OpenClaw 2026.10.9 documentation shipped in the package, and several assumptions failed there or live (session ids surviving `/new`, approvals needing an owner). Live behaviour was verified from structured logs rather than chat replies: the routing log for each route, the approval log for every send attempt, the lifecycle log for restarts and snapshots, and OpenClaw's run history for each scheduled job. Network problems were traced with a request-size ladder and the Windows event log instead of guessing. The three prompt-injection tests were run against the deployed agent and checked in the approval log.

## Timeline (factual)

| When (Pacific) | What happened | Outcome |
|---|---|---|
| Nov 15 | First deploys stalled; investigated a missing `.env` (red herring) and "no valid plugin manifest" | Transient under CPU starvation; entrypoint retry + logging added |
| Nov 15 evening | 1 vCPU boots took 4–9 min and failed 4 times | Moved to 2 vCPU (boot ≈ 2 min) |
| Nov 15 late | OpenAI login saved a credential but skipped promotion → "No route-compatible authentication source" | Re-login as the `node` user from its home directory; gateway restart |
| Nov 15 22:31 | First end-to-end turns: `reasoning_cloud` 12.5 s, `simple_local` 1.6 s | Both routes verified |
| Nov 15 23:03 – Nov 16 06:19 | Five OOM kills (exit 137) at 2 GiB when a turn spawned sub-agents | Moved to 4 GiB |
| Nov 16 night | Local route "down" overnight | Cause: Windows sleep (23:07–10:24); sleep/hibernate disabled |
| Nov 16 morning | Local turns hung 300 s after wake | Size ladder showed the Tailscale direct path dropped packets > ~1 KB; pinned DERP relay, padded health probe, local cooldown (v7) |
| Nov 16 | Private-session leak found (private history could reach cloud on a later turn) | Sticky private sessions + utility model set to local |
| Nov 16 afternoon | Workspace persona (SOUL/USER/IDENTITY), memory search set to keyword-only | Bot answers as "Beerus" for "Jesse Pinkman" |
| Nov 16 12:20–17:35 | Send-approval gate v8 → v12: secrets, gog sign-in on the instance, then four live bugs (redirection parsing, Gemma on "yes", no owner → instant deny, code-tool JS wrapper, duplicate actions) | Approved send delivered once; allowlist refusal; Gmail draft saved |
| Nov 16 17:50–18:15 | Memory persistence test across a restart | "Bluebird, due Friday" recalled after the v13 restart |
| Nov 16 18:00–19:20 | Scheduled jobs v13–v15 (briefing, alert, recap) | All three delivered; alert set to every 30 min after measuring ~54k tokens/run |
| Nov 16 19:36–19:56 | Custom skill `meeting-prep` published to ClawHub (v1.0.0, audit "Safe"), installed fresh on the instance, used live | Advanced-integration item done |
| Nov 16 20:13–20:26 | Full dry run of the video script | Found request 1 inheriting the cloud route from an earlier tool turn; added `/new` steps to the script |
| Nov 16 21:30 | Held messages from background turns while Ollama was healthy | Idle tailnet link slower than the 3 s probe; one bounded probe retry (v17); 0 held overnight after |
| Nov 17 07:31–18:00 | Scheduled jobs ran unattended: briefing 07:31, alerts 08:30 and 11:30, recap 18:00 | Proactive evidence at real times |
| Nov 17 14:52–15:00 | First injection-test attempt ran on local Gemma | One session id stayed private through four `/new` commands; private flag now cleared on `/new`/`/reset` (v18) |
| Nov 17 18:06–18:11 | Injection tests P1 (email), P2 (calendar), P3 (web page) rerun on the cloud model | All pass: instructions recognised or ignored, no send or change attempted |
| Nov 17 21:58 – Nov 18 10:44 | Optional v19 (OpenClaw-managed Tailscale Serve for tokenless grader access) failed to boot: managed Serve requires a loopback-bound gateway, ours binds to the container network for Cloud Run's probe | Instance down ~12.5 h; restored with `-ManagedServe 0` + `gcloud beta run instances start`; submitted config unchanged |

## AI assistance (attribution)

Claude (Anthropic) was used as a pair engineer throughout. Every generated file was reviewed
and verified by tests and/or a live run before being kept.

| Path | Generated by | What I verified / changed |
|---|---|---|
| `src/router/*` (classify, decide, cooldown, privateSessions, types) | Claude | Unit tests for every rule incl. HELD; live routing log; added `tools_cloud` / `tools_session_cloud` after Gemma failed tool calls live |
| `src/plugin/*` (index, runtime, SDK types) | Claude | Hook behaviour checked against the OpenClaw 2026.10.9 docs and live logs |
| `src/local/*` (health probe, SOCKS forwarder) | Claude | Size-ladder test over Tailscale; padded probe verified against Ollama |
| `src/approval/*` (gate, gogPolicy, shell, tokens, gogWrapper) | Claude | 26 approval tests; live: approved send once, allowlist refusal, draft saved; four bugs found live and fixed with regression tests |
| `container/entrypoint.sh`, `container/jobs.sh`, `Dockerfile`, `deploy/deploy.ps1` | Claude | Each deploy's lifecycle log; `a3job run` for each job |
| `config/*.json5`, `config/jobs/*.txt` | Claude | `openclaw config validate` at boot; job outputs in Telegram |
| `workspace/SOUL.md`, `IDENTITY.md`, `USER.md` | Claude draft, persona edited by me | Bot identity and persona in chat |
| `skills/meeting-prep/SKILL.md` | Claude | ClawHub security audit "Safe"; live prep brief |
| `README.md` (root and `a3-agent/`), `SECURITY_AUDIT.md`, `PERFORMANCE_REPORT.md` | Claude draft from my logs and evidence | Numbers checked against `evidence/` and Cloud Logging |

## Mistakes the AI made (and how they were caught)

- Diagnosed the overnight outage as a Tailscale ACL problem; the ACL was correct and the
  cause was Windows sleep (found from the Power-Troubleshooter event log).
- Guessed a broken GPU runner, then model contention, for the 300 s hangs; the size-ladder
  test proved it was the network path.
- Its first approval-gate parser assumed plain shell commands; live logs showed the agent
  wraps commands in a JavaScript code tool and repeats them across parameters. Each case
  became a regression test.
- Missed that OpenClaw denies approval requests instantly when no owner is configured; found
  from `approval_requested` → `denied` in the same second.
- Assumed OpenClaw's session id changes on `/new`; the private-session file showed one id
  surviving four resets, which sent a fresh conversation to local Gemma.

## What I learned

I learned that making an agent work in daily life is more than getting a model to answer a message. I had to make routing decisions based on things I could actually test, like whether a turn needed tools or belonged to a private session. I also learned that human approval has to happen outside the model. Giving the agent an OAuth connection did not mean it should be able to send something on its own, and the live tests caught cases where the approval gate looked right in code but failed when the agent used it.
The logs helped me get past a lot of wrong guesses. Exit 137 pointed me to memory, the Windows event log explained why the local route went down overnight, and the size-ladder test showed why small requests worked while larger ones hung. The same thing happened with the approval gate where I was seeing a request denied in the same second led me to the missing owner setting. I learned to test the agent the way a regular person would use it, checking all edge cases, then check what actually happened instead of trusting what I expected to happen from the guidance of AI. With another week, I would spend more time on recovery after restarts and on making the scheduled jobs use fewer tokens, so the agent is easier to keep running every day. I would also add an easy profile switcher so that way I can pull from multiple emails and calendars and perhaps even have it integrated on Brightspace.
