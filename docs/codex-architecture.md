# E3: Codex App Server and multiprovider architecture

> **Current status**: staged implementation for ChatGPT login in an Ubuntu/Incus VM.
> The Claude SDK route is still the default. **E3 is not yet a claim of full parity**.

## Design decisions

`pipeline.js` is a 9k-line orchestrator, not a reusable Claude-only adapter.
A rewrite would jeopardize the 3,432 existing green Linux tests. Keep the
orchestration, task machine boundaries, worktrees, GitHub and QA state machines,
and phase prompts; swap only the model execution transport.

Use two Codex transports:
- `server/src/agents/codex.js` — official **@openai/codex-sdk**, one batched
  turn at a time. Currently read-only issue triage only (E2).
- `server/src/agents/app-server.js` — **codex app-server**, JSON-RPC/stdin,
  persistent threads, fork, steer and interrupt. A background server-initiated
  approval is denied unless the board owner explicitly accepts **once**.
- `server/src/agents/chat-session.js` implements the chat surface without
  any Claude frame parsing. It can reopen an idle process from the same Codex
  thread, and stores a `codex:<threadId>` namespaced session ID.
- `server/src/agents/status.js` queries Codex login and limits independently:
  `GET /api/agents`, `GET /api/agents/codex/limits`. Never modify the
  Anthropic quota JSON when Codex hits its own limit.

### Module dependency map

| Component | Contract to preserve | Current implementation |
|---|---|---|
| `claude.js` | Claude provider and legacy events | **Unchanged** |
| `agents/index.js` | Selection, thread ownership | Claude default; Codex triage and chat opt-in |
| `agents/codex.js` | Batch turns, normalized streaming, resume | E2 read-only triage |
| `agents/app-server.js` | Lifecycle, RPC, requests, interrupt | E3 |
| `agents/chat-session.js` | send, retune, interrupt, close, fork, steer | E3 |
| `pipeline.js` | Issue and chat state machine, question UI, quotas | E2 triage + E3 chat |
| `activity.js` | Stable normalized tool events | E3 reuses E2 mapping |
| `settings.js` | Per-project/provider role options | **Pending** configurable UI |
| `qa.js` | QA_PLAN/QA_RESULTS + Playwright artifacts | **Claude only** until MCP policy validated |
| `machine.js`, runner | Local vs remote execution | Codex local VM only, remote unsupported |
| `quota.js`, `usage.js` | Provider-specific limits, metrics | Separate probe E3; scheduling still Claude-only |
| `upgrade.js` | SDK and CLI lifecycle | Existing Claude-only updater unchanged |
| `web/src` | Provider/model selector, quota display | **Pending** dedicated Codex controls |
| `plugins`, tools | Per-phase MCP and permission policy | **Pending** parity gates |

## App Server JSON-RPC compatibility (Codex CLI 0.162.1)

The first native smoke from the Incus VM initially failed with
`APP_SERVER_SMOKE=FAIL Codex App Server closed` even though
`codex login status` said `Logged in using ChatGPT`.

Root cause in the client: Codex App Server speaks a JSON-RPC 2.0-like protocol
**without a `jsonrpc` version field on the wire**. An earlier version of this
bridge sent `jsonrpc: "2.0"` with all requests, notifications and approval
responses. The mock server accepted it, masking the incompatibility. See the
official protocol at https://developers.openai.com/codex/app-server#protocol .

A second real smoke on **Codex CLI 0.162.1** revealed another wire mismatch:
`thread/start.sandbox` is the **kebab-case CLI enum**
(`read-only`, `workspace-write`, `danger-full-access`), while
`turn/start.sandboxPolicy.type` is the **camelCase structured policy**
(`readOnly`, `workspaceWrite`). Both thread and turn
`approvalPolicy` are `on-request`, not `onRequest`. These values were
verified against the exact `rust-v0.162.1` protocol JSON schemas:
`codex-rs/app-server-protocol/schema/json/v2/ThreadStartParams.json` and
`TurnStartParams.json` in https://github.com/openai/codex .
The unit-test mock now asserts both wire formats.

The App Server transport now omits that field everywhere, and protocol unit
tests reject requests containing it. The startup handler also settles with the
**original RPC error** before closing the child, so future failures show
`Codex App Server startup failed: ...` rather than a misleading close message.

To update an existing detached E3 worktree safely:

```bash
cd ~/orca/workspaces/live-monitor/live-monitor-codex-app-qa
git status --short                # verify no uncommitted tracked changes
git fetch origin
git switch --detach origin/feat/e3-codex-appserver-chat
node --test server/test/codex-app-server.test.mjs
node server/tools/codex-app-server-smoke.mjs
```

This test is read-only, uses the same `dev` account's ChatGPT CLI login and
does not modify production projects. If it still fails, report the new full
`APP_SERVER_SMOKE=FAIL` line and CLI version; the original RPC error should
now be visible. Do not share auth codes, access tokens or private CLI config.

## Running the E3 QA in the VM

Use an isolated Git worktree. Do not enable this for any production repo.

```bash
cd ~/orca/workspaces/live-monitor/merfolk
git fetch origin
git worktree add ../live-monitor-codex-app-qa origin/feat/e3-codex-appserver-chat
cd ../live-monitor-codex-app-qa

npm ci --prefix server
npm ci --prefix web
npm run build --prefix web
node --test server/test/codex-provider.test.mjs server/test/codex-app-server.test.mjs server/test/codex-status.test.mjs
npm test
```

Codex SDK is lazy-loaded for batch triage; use E2's temporary install command
if testing that phase with a real account. **App Server chat uses the Codex CLI
directly**, no extra npm SDK package is required for it.

```bash
codex --version
codex login status
# Authenticate if needed:
codex login --device-auth
node server/tools/codex-app-server-smoke.mjs
```

Expected: `APP_SERVER_SMOKE=PASS` after two read-only turns on one session.
If it fails, do not merge the PR. Record the CLI version and the error
(without pasting auth codes). Ensure `git status --short` is clean.

### Opt-in, isolated pilot

In the **board checkout**, merge into the ignored `config.local.json`:

```json
{
  "agents": {
    "phases": { "triage": "codex", "chat": "codex" },
    "codex": { "reasoningEffort": "medium", "timeoutMinutes": 10 }
  }
}
```

Omit `agents.codex.model` to follow the model available to the VM's authenticated
Codex CLI. Restart the board to avoid mixing long-lived preexisting sessions.
Create **new** chats for Codex; Claude session IDs are intentionally rejected.
`/model` and the Claude model selector do not apply to these chats.

```bash
bash restart.sh
curl --noproxy '*' -fsS http://127.0.0.1:7420/api/agents
curl --noproxy '*' -fsS http://127.0.0.1:7420/api/agents/codex/limits
```

If `access.token` is configured, use the board's normal authenticated access;
do not paste secrets in shell history. From the Kubuntu host, keep using the
SSH localhost forward instead of binding the board to the VM's external IP.

### Sandbox and approvals

- Codex chats in plan mode use `sandboxPolicy: {type:"readOnly"}`.
- Working chats use `workspaceWrite` with `writableRoots` limited to the
  project worktree and `networkAccess: false`. The host process is still the
  unprivileged VM user, not root.
- `approvalPolicy: "onRequest"` on the protocol wire. Requests for command
  execution or file modifications are presented through the existing board
  question UI. No unanswered request is approved; unrecognized permissions
  default to decline/empty grants.
- **Codex sandbox is not a GitHub authorization gate.** User-configured MCP
  servers can have credentials and powers outside that sandbox. Do not connect
  production secrets or write-capable GitHub MCP tools to this pilot. Full
  policy parity needs a separate, **fail-closed** tool mediation layer.

### Limitations and required follow-up gates

- Codex in `/plan on` produces a read-only reply. It does **not** yet invoke
  Claude's `ExitPlanMode` or automatically enter Live Monitor's plan executor.
- The central task pipeline beyond triage (advisor, coding, QA, PR) remains
  Claude-only. These stages currently rely on `ghGateHooks`, task questions,
  background tasks and Playwright MCP; silently routing them to the Codex SDK
  would skip those controls.
- The existing global quota scheduler and upgrade flow are Claude-specific.
  Codex chat itself is not gated by an Anthropic quota hold; the interactive
  limits API reads from Codex directly. Cross-provider task scheduling remains
  a follow-up.
- Codex provider model selection UI, configurable per-phase permissions and
  remote runner transport are not yet implemented.
- A full parity claim requires: **(1)** policy enforcement across commands and
  MCP calls; **(2)** verified issue→plan→fix→tests→Browser QA→PR with Codex;
  **(3)** approval/rejection UI integration end to end; **(4)** resumable
  sessions and fork tests against a real Codex CLI; **(5)** independent quota
  hold/resume; **(6)** a non-destructive rollback to Claude; **(7)** no new
  regressions in the entire test suite, and **(8)** restored QA screenshots and
  recordings as applicable.

### Rollback

Remove `agents.phases.chat` and `agents.phases.triage` from your local
configuration (or set them to `"claude"`), restart the board and start fresh
Claude chats. Never reinterpret a `codex:` ID as an Anthropic transcript.

Official protocol: https://developers.openai.com/codex/app-server
Official SDK: https://github.com/openai/codex/tree/main/sdk/typescript
