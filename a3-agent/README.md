# A3 Hybrid Router (CSCI 599 Assignment 3)

Hybrid-LLM personal assistant on OpenClaw 2026.10.9. This package is the routing plugin:
it decides, per turn, whether local Gemma (`ollama/gemma4:e4b` on the desktop, reached over
Tailscale) or the cloud model (`openai/gpt-5.6-sol`) answers.

Reports: [SECURITY_AUDIT.md](SECURITY_AUDIT.md) · [PERFORMANCE_REPORT.md](PERFORMANCE_REPORT.md) ·
[PROCESS_LOG.md](PROCESS_LOG.md). Evidence exports: [`evidence/`](evidence/).

## Pinned versions

| Component           | Version                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| Node                | 24.22.1                                                                    |
| OpenClaw            | 2026.10.9                                                                  |
| Ollama              | 0.40.16                                                                    |
| Local model         | `gemma4:e4b` (digest `dc35e8d9c606…`, Q4_K_M), context 32768, thinking off |
| Tailscale (desktop) | 1.104.7                                                                    |
| gogcli              | 0.48.0 (release checksum verified at build)                                |
| ClawHub skill       | `@lapseyy/meeting-prep` 1.0.0                                              |

## Routing rules (first match wins)

1. `privacy_sensitive` → local if available, otherwise **HELD**.
   `session_private` (an earlier turn in this conversation was private) → the same
2. `reasoning_heavy` or `needs_long_context` → cloud
3. `cloud_rate_limited` → local if available
4. `needs_tools` (calendar, email, web search, weather, news) → cloud. Gemma e4b answers
   short chat well but failed multi-step tool calls on OpenClaw's ~21k-token base prompt
   in testing, so tool-using requests stay on the cloud unless private or rate-limited.
   A short follow-up within 15 minutes of a tool-using turn in the same session ("yes",
   "send it") also goes to the cloud (`tools_session_cloud`); in v9 such a "yes" went to
   Gemma, which failed the send three times.
5. `simple` → local if available
6. default → cloud

Task properties come from a deterministic keyword/length classifier
(`src/router/classify.ts`); the rules are a pure function (`src/router/decide.ts`).

## Private-task policy: HELD

When a task is privacy-sensitive and local Gemma is unavailable, the task is **held**: it is
not sent to any model, the user is told to retry when the local model is online, and the
routing log records `route=held`, `model=none`. This is enforced in code at three points
(`src/plugin/runtime.ts`), not by prompt:

1. `before_dispatch` claims the inbound message and replies without running the agent.
2. `before_model_resolve` pins a held run to the local provider, so it cannot resolve to cloud.
3. `before_agent_run` blocks held runs, and blocks any private run whose resolved provider
   is not the local one.

### Private sessions

OpenClaw sends the whole conversation to whichever model answers, so routing one message at
a time is not enough: a private exchange answered locally would reach the cloud as history
on the next cloud-routed turn. The router therefore marks a session private on its first
privacy-sensitive turn and keeps every later turn in that session on local Gemma
(`rule=private_session_local`), or holds it when Gemma is offline
(`rule=private_session_held`). Send `/new` (or `/reset`) to start a fresh session. OpenClaw
keeps the same session id across a reset, so the plugin clears the private flag itself on the
`before_reset` / `session_end` (reason `new` or `reset`) hooks and logs a `session_reset` line
(component `a3-session`, no message text). The list of private sessions lives in the OpenClaw state directory
(`a3-router/private-sessions.json`), so it is snapshotted and restored together with the
transcripts, and an unreadable list is treated as "every session is private" (fail closed).

Two OpenClaw features that call a cloud model outside the router are closed in config:
`agents.defaults.utilityModel` is set to the local model (titles and progress text), and
memory-core "dreaming" is disabled (it re-reads transcripts with the default model).

Known limit: this policy covers model calls for chat turns. If a generated title fails on
the local model, OpenClaw retries it once on the primary model; see SECURITY_AUDIT.md.

`agents.defaults.model.fallbacks` must stay empty: OpenClaw 2026.10.9 gives plugins no
per-run fallback override, so a configured cloud fallback could otherwise pick up a failed
local call.

## The "Model Fallback" notice in chat

When the router picks a model other than the configured default, OpenClaw posts
`Model Fallback: ollama/gemma4:e4b (selected openai/gpt-5.6-sol; selected model unavailable)`,
and `Model Fallback cleared: ...` when a later turn goes back to the cloud. This is OpenClaw
announcing a routing switch made by this plugin. The cloud model was not tried and was not
down; "selected model unavailable" is OpenClaw's stock wording. The routing log is the
record of what happened and why.

## Email and calendar: human approval gate

Email and calendar go through `gog` (gogcli 0.48.0) on a dedicated test account, authorised
for Gmail and Calendar only. Every send, and every change to mail or the calendar, needs a
human yes. Two layers enforce it in code:

1. **Plugin hook** (`src/approval/gate.ts`, `before_tool_call`). Reads and drafts pass. A
   send or change pauses the agent and posts an approval request in the chat; the human
   answers with the button or `/approve <id> allow-once` / `deny`. The approver is the
   owner in `commands.ownerAllowFrom` (also `channels.telegram.execApprovals.approvers`);
   with no owner configured, OpenClaw denies every request at once. Only "allow once" writes a single-use
   token, valid for 3 minutes, bound to the action kind and the exact recipients shown.
   Runs started by cron or the heartbeat are blocked here without being offered approval:
   scheduled jobs draft and notify.
2. **`gog` wrapper** (`src/approval/gogWrapper.ts`). The command named `gog` in the image is
   this wrapper; the real binary is started only from it. It classifies the real argument
   vector (`src/approval/gogPolicy.ts`) and refuses any send or change without a matching
   token, so a command the plugin failed to recognise still cannot send. Reads and drafts
   run with gog's own `--gmail-no-send` lock on.

Recipient allowlist: the test account itself plus `A3_EMAIL_ALLOWLIST` (`-EmailAllowlist` in
`deploy.ps1`). A send to anyone else is refused without an approval prompt. Sends whose
recipients cannot be read from the command (`reply`, `reply-all`, `drafts send`,
`--reply-all`, `--raw-file`) are refused; the agent must use `gog gmail send --to ...`.
Other Google services, `gog auth`, `gog config`, and switching account, home or client are
refused.

Known limit: the wrapper and the real binary run as the same OS user, so this stops a model
that was tricked, not a process deliberately hunting for the real binary. The plugin blocks
any command that names it. See SECURITY_AUDIT.md.

The plugin's command parser is a convenience layer, not the boundary. Text that mentions gog
in a form it cannot parse is blocked only when it contains a write word (send, delete,
create, ...) or names the real binary; anything else (for example `which gog`) passes and is
logged as `passed_unparsed` with command names only, because the wrapper still refuses every
send or change that has no approval token. Commands the agent runs through OpenClaw's code
tool (`await exec({command: "gog ..."})`) are read from the JavaScript string literals. If
the approved command reaches the hook a second time (the code tool's inner `exec`), the
pending token is honoured without a second prompt; the wrapper still uses it up once.

## Scheduled jobs (briefing, alert, recap)

Three jobs live in OpenClaw's scheduler (`openclaw automations`) and deliver to the owner's
Telegram DM. `container/jobs.sh ensure` runs at every boot and creates only the jobs that are
missing, matched by exact name, so restarts never duplicate them. Prompts are in
`config/jobs/*.txt`. Times are America/Los_Angeles.

| Job | Schedule | Session | What it does |
|---|---|---|---|
| A3 Morning briefing | `30 7 * * *` | isolated | Today's calendar, unread mail needing a reply (flags Prof. White / deadlines), LA weather |
| A3 Proactive alert | `*/30 * * * *` | isolated | Events starting in 30–60 minutes and urgent new mail; replies `NO_REPLY` (silent) when there is nothing |
| A3 End-of-day recap | `0 18 * * *` | main | What the agent did today in the conversation, mail sent/drafted, tomorrow's first events |

The 30–60 minute window, checked every 30 minutes, means each event is alerted once. One
alert run costs about 54k tokens (38k cached) on the cloud model, so every 30 minutes rather
than every 15 halves the daily cost.
Scheduled runs only read and draft: the approval gate blocks any send or change from a
cron-triggered run, without offering approval.

Run a job now (same delivery path as the schedule), from an SSH session on the instance:

```sh
a3job list
a3job run briefing      # or: alert, recap
a3job runs briefing     # recent run history
a3job remove recap      # delete one job; the next boot (or `a3job ensure`) recreates it
```

The recap is a main-session job (a system event in the conversation's own session, woken
immediately) so it can see what the agent did today; if OpenClaw rejects that, `ensure` falls
back to an isolated job and logs a warning. Job creation is retried for up to 4 minutes after
boot, because the agent rejects new jobs until its startup preparation finishes.

## Skills

| Skill | Source | Notes |
|---|---|---|
| Calendar + email | `gog` (bundled OpenClaw skill + gogcli 0.48.0) | Dedicated test Gmail and its calendar; Gmail + Calendar scopes only; sends gated (above) |
| Web search | OpenAI hosted `web_search` on the ChatGPT (OAuth) transport | `tools.web.search.openaiCodex.enabled: true` in `config/openclaw.patch.json5`; no API key, no extra plugin |
| Weather | Bundled OpenClaw `weather` skill (wttr.in, no key) | Used by the morning briefing (Los Angeles) |
| News | Not a separate skill; answered through web search | — |
| **Meeting prep** (custom) | [`skills/meeting-prep/SKILL.md`](skills/meeting-prep/SKILL.md), published to ClawHub | Read-only prep brief for the next or a named meeting |

### Advanced integration: custom skill on ClawHub

- Public location: https://clawhub.ai/lapseyy/skills/meeting-prep
- Pinned version: **1.0.0** (`clawhub skill publish ./skills/meeting-prep --slug meeting-prep --version 1.0.0`)
- ClawHub security audit: **Pass** (install-time verdict "Safe") https://clawhub.ai/lapseyy/skills/meeting-prep/security-audit?version=1.0.0
- Fresh-install transcript from the deployed instance: [`evidence/clawhub-install.txt`](evidence/clawhub-install.txt)

Install it yourself:

```sh
openclaw skills install @lapseyy/meeting-prep --version 1.0.0 --global
```

`--global` installs into the OpenClaw state directory. On this deployment the workspace is a
GCS FUSE mount, which cannot rename directories, so a workspace install fails with `EMFILE`
during the final rename; the state directory is on container disk and is included in the
snapshots.

## Memory and persistence

OpenClaw's memory (keyword search, `memory.search.provider: "none"`) and transcripts live in
the state directory, which is snapshotted to the bucket on shutdown and restored on boot.
Test: "Remember that my fictional project is called Bluebird and is due Friday" (17:50) →
redeploy (18:03–18:06) → `/new` → "What is my fictional project called…" (18:15) answered
"Bluebird, Friday November 20". Lifecycle evidence: `evidence/memory_restart_lifecycle.txt`.

Workspace files (`SOUL.md`, `USER.md`, `IDENTITY.md`) live on the bucket at
`gs://a3-sosapineda-599-state/workspace/` and contain only fictitious data.

## Grader access

Everything below is submitted **through Brightspace only**, never in this repository, the
README or the video:

- **Tailscale share link** for the `a3-agent` node, and the **agent URL**
  (`https://<agent>.<tailnet>.ts.net/`, the OpenClaw Control UI served with `tailscale serve`;
  gateway auth accepts the Tailscale identity, `gateway.auth.allowTailscale: true`).
- **Test email/calendar account** login (one dedicated class-only Gmail account that also owns
  the calendar), 2-Step Verification off (Path 1, because the agent uses Gmail/Calendar through
  OAuth, not an App Password).

Graders can plant a test meeting to see the proactive alert (sent 30–60 minutes before the
start, checked every 30 minutes) and a test email for the injection defense. The Telegram bot
accepts only allowlisted numeric user IDs; a grader ID can be added to
`channels.telegram.allowFrom` in `config/openclaw.container.patch.json5` and redeployed.

## Local route: operating notes

- The desktop must stay on and awake. While it sleeps, simple tasks go to the cloud and
  private tasks are held.
- The instance's Tailscale is pinned to the relay path (`TS_DEBUG_ALWAYS_USE_DERP=true` in
  `container/entrypoint.sh`). On a direct path from Cloud Run, packets over about 1 KB were
  dropped, so small health checks passed while real prompts hung.
- The health probe is padded to about 3 KB so it fails when a real prompt would.
- If a local model call times out or errors, the router stops choosing local for
  `localCooldownMs` (5 minutes): non-private tasks go to the cloud, private tasks are held.

## Rate-limit simulation

Reversible and uses no real quota. Either set `A3_SIMULATE_CLOUD_429=1`, or create the file
named by `A3_RATE_LIMIT_FLAG_FILE` (delete it to switch back). While active the router
treats the cloud as rate limited and sends eligible work to local Gemma
(`rule=rate_limited_local`). A real 429 from the cloud provider starts a 5-minute cooldown
with the same effect; there are no retry loops.

## Routing log

One JSON line per decision on stdout (Cloud Logging `jsonPayload`), never any message text:

`{ts, request_id, task_type, route, rule, model, success, latency_ms, error_class}` plus
`component: "a3-router"`.

```sh
gcloud logging read 'jsonPayload.component="a3-router"' --project=a3-sosapineda-599 --freshness=30m --order=desc --format="table(timestamp.date('%H:%M:%S'),jsonPayload.request_id,jsonPayload.task_type,jsonPayload.route,jsonPayload.rule,jsonPayload.model,jsonPayload.success,jsonPayload.latency_ms,jsonPayload.error_class)"
```

## Plugin allowlist (container)

`config/openclaw.container.patch.json5` sets `plugins.allow` to exactly
`a3-router, openai, ollama, telegram, memory-core`. OpenClaw otherwise auto-enables every
bundled plugin (browser, computer use, file transfer and others), which this agent does not
use and the threat model does not cover. A new plugin-backed feature must add its plugin id
to that list. Check a boot with the gateway's `http server listening (N plugins: ...)` log
line: it must name only those five.

## Deploy

```powershell
.\deploy\deploy.ps1 -Tag v5              # build + deploy, 2 vCPU / 4 GiB
.\deploy\deploy.ps1 -Tag v4 -SkipBuild   # roll back to an earlier image without rebuilding
```

Uses `gcloud beta run instances` only. Never reuse a tag: each build gets a new one.

## Develop

```sh
npm ci
npm run check   # typecheck + lint + tests
```
