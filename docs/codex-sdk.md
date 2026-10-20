# E2 — Codex SDK pilot (read-only issue triage)

This pilot introduces the official `@openai/codex-sdk` **without replacing the Claude pipeline**.
`claude` is the default; Codex is opt-in for **triage only**. It works on the
same local checkout/worktree as the board, and the Codex SDK spawns the bundled
CLI using the **login of the OS account that runs the board**.

## Before changing the board configuration

Run the pilot in the **Incus Ubuntu VM** as the same `dev` user that runs
Live Monitor. Do not enable it for Kovar production, and do not use the
remote runner for this pilot.

```bash
cd /home/dev/orca/workspaces/live-monitor/merfolk
git fetch origin feat/e2-codex-sdk-triage-pilot
git worktree add ../live-monitor-codex-qa origin/feat/e2-codex-sdk-triage-pilot
cd ../live-monitor-codex-qa

npm ci --prefix server
npm ci --prefix web
node --test server/test/codex-provider.test.mjs server/test/codex-sdk-smoke.test.mjs
node server/tools/codex-readonly-smoke.mjs
node --test --test-concurrency=2 server/test/*.test.mjs
```

**Reproducible packaging:** `@openai/codex-sdk@0.163.0` is pinned in
`server/package.json` and `server/package-lock.json` (E2 commit `a998e53`).
`npm ci --prefix server` installs the SDK without a separate temporary
installation. The npm audit report still contains five **preexisting**
advisories; they require a separate security review. Do not run an
unreviewed `npm audit fix` as part of this pilot.

### Codex authentication in the VM

The first live turn requires Codex to be logged in **inside the VM** (not only
on the Kubuntu host), under the same Unix user.

```bash
npm install -g @openai/codex@0.163.0
codex login status
# If not logged in:
codex login --device-auth
```

Complete device authentication in your browser using the URL/code displayed by
the CLI. Do not paste the code or any credentials into Live Monitor or git.
Login via ChatGPT should not require setting `OPENAI_API_KEY`. If device
authentication is unavailable, use the interactive `codex login` flow.

### Smoke test, no GitHub issues or writes

In the Codex QA worktree after logging in:

```bash
node server/tools/codex-readonly-smoke.mjs
```

The hardened smoke requires a successful read of `package.json` through the
Codex SDK and checks the returned name/build script against the local file.
It rejects plausible text-only answers, failed tool reads and unexpected tool
types. The script uses the SDK, **read-only sandbox**, no agent network access
and no approval prompts. If the SDK or login is missing, it prints an error
and returns nonzero.

## Opt-in triage in Live Monitor

Enable only after the smoke test. Keep the existing board stopped while
changing its local overlay. Add these keys to **your own** ignored
`config.local.json`; **merge**, don't replace existing VM project paths or
access tokens:

```json
{
  "agents": {
    "phases": { "triage": "codex" },
    "codex": {
      "reasoningEffort": "medium",
      "timeoutMinutes": 10
    }
  }
}
```

Omit `agents.codex.model` to select the CLI default for the logged-in plan,
or set a model name your installed Codex supports. Do **not** reuse Claude
aliases such as `opus` or `sonnet`.

**The board needs the SDK installed in its own checkout** (`server/node_modules`),
not just in the separate QA worktree. For example:

```bash
cd /home/dev/orca/workspaces/live-monitor/merfolk
# First update this checkout to a commit containing the pinned SDK dependency.
npm ci --prefix server
bash restart.sh
```

Configuration is reloaded by the board, but a restart is recommended to clear
any older in-flight triage sessions. Existing Claude session IDs cannot be
resumed by Codex: the provider rejects them rather than mixing transcripts.
Triages already in progress should finish with their previous provider.

### Why triage is read-only

- The prompt already contains the GitHub issue context; Codex should inspect
  checkout files, not publish branches or PRs.
- `sandboxMode: "read-only"`, `approvalPolicy: "never"`,
  `networkAccessEnabled: false` are enforced in the bridge; they are not
  configurable from the board UI.
- The pilot rejects remote runner machines. It does **not** emulate Claude's
  `canUseTool`, hooks, fork/session lifecycle, subagent events, Playwright,
  interactive approval or shared quota state.
- All later pipeline phases (planning, editing, tests, QA and PR) continue to
  use the existing Claude implementation. Do not claim Codex-only operation.
- Errors, including quota failures, are surfaced as **Codex task errors**;
  they do not trigger the existing *Anthropic* quota hold.

## Rollback

Remove `agents.phases.triage` from `config.local.json`, or set it to
`"claude"`, and restart the board. Existing Codex session IDs remain prefixed
with `codex:`; retries of an unfinished Codex triage cannot automatically
switch to Claude. Start a new triage cycle for those tasks.

## Validation

```bash
node --test server/test/codex-provider.test.mjs server/test/codex-sdk-smoke.test.mjs
node server/tools/codex-readonly-smoke.mjs
node --test --test-concurrency=2 server/test/*.test.mjs
git status --short
```

Report a real SDK smoke result separately from mocked unit tests. For a first
end-to-end issue, use a disposable test repository and an issue that can safely
be classified without writes. This E2 pilot is not meant for automated
production deployments.

Official references: https://github.com/openai/codex/tree/main/sdk/typescript
and https://developers.openai.com/codex/sdk .
