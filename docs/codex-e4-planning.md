# E4a — Codex planning (read-only) with Claude executor fallback

This stacked change follows E2 (Codex SDK triage) and E3 (App Server
interactive chat) without changing the existing Claude default. The initial E4
milestone is intentionally **planning only**. Do not conflate a model's ability
to draft a plan with authorization to edit the repository or publish a PR.

## Architecture and protection

`server/src/agents/planning.js` provides a one-shot App Server execution
surface. It uses the same Codex CLI that successfully ran in the user's
Ubuntu 24.04 Incus VM with ChatGPT login. The board invokes it through
`runTaskAgent({ ..., prompt }, { stage: 'plan', cfg })`.

Security invariants:
- `permissionMode: 'plan'` is hard-coded to the read-only App Server
  sandbox; a request for write escalation is denied. No bypass option exists
  in this adapter.
- It runs only in **local worktrees** inside the guest VM; remote runners are
  rejected, as are missing or relative worktree paths.
- No Claude-specific `canUseTool` / `PreToolUse` callback is forwarded,
  since the Codex transport cannot execute it. The read-only sandbox is a
  separate enforcement mechanism, not an emulation of the GitHub gate.
- Existing GitHub/MCP tools configured globally for Codex may still have
  network access *outside* its shell sandbox. For this pilot, do not attach
  write-capable or privileged external tools to the Codex account/config.
  Full tool-policy isolation remains an E4b acceptance gate.
- On any timeout or abort the App Server is closed; a failed result cannot be
  mistaken for a valid plan.
- `providerFor` checks session ownership. A Codex planning transcript
  (`codex:<id>`) must never be fed to Claude when the executor forks: the
  existing Claude executor starts a fresh session with the rendered plan in its
  prompt instead.
- The `fix`, `qa`, `pr` and other mutating phases remain on **Claude**.
  Asking to use Codex there fails explicitly, rather than silently dropping
  the Anthropic-specific safety hooks.

## Enable the E4a pilot

Use an **isolated QA checkout or a disposable repository**, not Kovar or
DeepTrade. After the two-turn App Server smoke has already passed:

```bash
cd ~/orca/workspaces/live-monitor/merfolk
git fetch origin
git worktree add ../live-monitor-codex-plan-qa origin/feat/e4-codex-readonly-planning
cd ../live-monitor-codex-plan-qa
npm ci --prefix server
node --test server/test/codex-planning.test.mjs
node server/tools/codex-planning-smoke.mjs
npm test
```

The read-only smoke checks the actual `web/package.json` build command and
refuses uncommitted work. The upstream UI still does not offer per-phase
provider selection, so a local JSON overlay controls it:

```json
{
  "agents": {
    "phases": { "plan": "codex" },
    "codex": { "reasoningEffort": "medium", "timeoutMinutes": 10 }
  }
}
```

Merge this into the ignored `config.local.json` alongside existing project,
machine and access settings. **Never replace the whole overlay.** Claude remains
the default for every other phase; do not change `agents.phases.fix` to
`codex`. Plan approval, selection, downstream testing and PR review retain
their original Live Monitor logic.

## QA contracts

Run `node --test server/test/codex-planning.test.mjs` for:
- Claude default and Codex opt-in only for planning.
- No mixing of Claude and Codex sessions, including across the executor fork.
- Strict read-only planning adapter; Claude's tool callbacks never forwarded.
- Denied remote runners, missing/relative worktrees and aborted signals.
- Timeout cleanup and failed-turn propagation.

The existing full suite checks prompt templates, plan revisions, tagged plans,
`ghGateHooks` inventory, plan approval and executor behavior. In particular,
`ghgate-wiring.test.mjs` now explicitly inventories `runPlanning({` calls:
new planner sites must carry the Claude gate **or** the Codex read-only adapter
and must not bypass either.

## Remaining E4b before declaring Codex full support

The next separate change must enforce an explicit command/MCP/GitHub-write
policy independent of model-provided instructions, then implement and certify
an isolated Codex **workspace-write** executor. Test rollback, diff checks,
Playwright QA, review comments and PR creation against a throwaway fork.
`CODEX_PLAN_SMOKE=PASS` alone is not authorization for those operations.

Once those security contracts pass, extend `agents.phases.fix`,
`agents.phases.qa` and publishing. The isolated Codex SDK packaging/lockfile
from E2 also remains to be finalized after its own real account smoke.
