# subagent-probe

Live probe for issue #21. It answers one question: does a `PreToolUse` hook that
returns `updatedInput` keep the subagent tool (`Agent`/`Task`) in the foreground
under `bypassPermissions`? (ADR-0066 says a hook cannot return `updatedInput`;
the SDK types say it can.)

```
node tools/subagent-probe/probe.mjs [--mode rewrite|deny] [--no-control] [--scenario single|parallel|inturn] [--out file.json]
```

It opens a minimal haiku session with the input channel held open (as
`runClaude` does), asks it to launch one trivial subagent without
`run_in_background`, and records the hook call, the `task_started` frame and the
order of `task_notification` / `system/init` / `result`. A control run without
the hook gives the baseline. The SDK is found through `$SDK_DIR`, this
checkout's `server/node_modules`, or any worktree's (`git worktree list`). It
costs a few cents. The result files record `sdkDir` as a placeholder, not the
real path.

## Result (SDK 0.3.291, CLI 2.1.291, Windows, 2026-10-06)

Saved in `result-rewrite.json`.

| | control (no hook) | hook, `rewrite` |
|---|---|---|
| `task_started.is_backgrounded` | `true` | `false` |
| `task_started.task_type` | `local_agent` | `local_agent` |
| `task_started.subagent_type` / `tool_use_id` | present | present |
| tool result the model got | "launched in the background" | the subagent's report |
| first `result` of the session | `Agent launched. Waiting for it to complete...` | `FINAL: PONG` |
| `system/init` after the `task_notification` | yes (a CLI turn of its own) | no |
| `result` frames | 2 | 1 |

- `updatedInput` **is honoured** under `bypassPermissions`: the model omitted
  `run_in_background`, the hook returned the whole input with it set to `false`,
  and the subagent ran in the foreground. ADR-0066:34 is wrong on this point.
- The control run reproduces the bug: the first result, the one the board seals,
  is the waiting sentence; the real answer comes in a second turn.
- The `task_started` frame carries `task_type: 'local_agent'`, `subagent_type`
  and `tool_use_id`, so a subagent can be told from a background command.
- The `deny` fallback was not run; it is covered by the unit test only. It is
  needed only if a CLI (for instance the native one on `runner-1`) stops
  honouring `updatedInput`; rerun the probe there to check.

## Do foreground subagents run in parallel? (issue #28)

`--scenario parallel`, saved in `result-parallel.json` (SDK 0.3.291, CLI 2.1.291,
Windows, 2026-10-06, haiku, gate on in `rewrite` mode, no control run). One
session asked to launch TWO `Agent` calls in ONE message, each subagent running
`sleep 20`.

| | measured |
|---|---|
| both `tool_use` in the same assistant message | yes (same `message.id`) |
| hook calls | 2 |
| `task_started.is_backgrounded` (2 agents + their 2 `sleep` commands) | all `false` |
| `result` frames | 1 (after both reports; no `system/init` after a notification) |
| subagent starts | t=6267 ms and t=6848 ms |
| subagent reports | t=30685 ms and t=30738 ms |
| subagent durations | 24.4 s and 23.9 s (sum 48.3 s) |
| first start to last report | 24.5 s |
| whole session to the `result` | 32.8 s |
| verdict | `overlap: true`, `serialised: false` |

- **They run in parallel.** Serialised they would take about 40 s plus
  overhead; the two spans overlap and the last report lands 24.5 s after the
  first start. The extra ~4 s over the 20 s sleep is the subagents' own start-up
  and the model turns.
- `updatedInput` is honoured for both calls under `bypassPermissions`, which
  also settles that point for the multi-subagent case.
- The `serialised` flag is `span > 0.9 x sum of the subagents' durations`; only
  `local_agent` tasks count, because the inner `sleep` commands arrive as
  `local_bash` tasks too.
- Cost: two haiku sessions (a first run, kept out of the repo because its verdict
  also counted the `local_bash` tasks, and the saved one), a few cents in total.
  The probe does not record dollars.

## Does a report inside the sealed turn get a reaction turn? (issue #31, section 6)

`--scenario inturn`, saved in `result-inturn-report.json` (SDK 0.3.291, CLI 2.1.291,
Windows, 2026-10-06, haiku, **no gate**, one run). One message with a background
`Agent` call (`run_in_background: true`) and a foreground `Bash` `sleep 25`, then
`FINAL: DONE`. The idle window is re-armed on every `init`, and Bash calls are
recorded as `bash_use`.

| | measured |
|---|---|
| background `Agent` calls / `task_started.is_backgrounded` | 1 / `true` |
| subagent report (`task_notification`) | t=6413 ms, **before** the first `result` |
| first `result` (t=10318 ms) | the good answer: `... FINAL: DONE` |
| `system/init` after the first `result` | **yes** (t=10326 ms, 8 ms later) |
| second `result` (t=12938 ms) | `Background agent completed: PONG received.` |
| `result` frames | 2 |

- **The case is real.** A background subagent that reports inside the turn that
  already holds the good answer still gets a CLI turn of its own, and that turn's
  `result` is a one-line acknowledgement. A net that adopts "the last
  successful result" after the seal would replace the good answer with it, so
  the sealed answer needs a guard (ADR-0079): `server/src/sealedanswer.js#answerOf`,
  wired at the validators in `server/src/pipeline.js` (7 call sites).
- **Caveat: the foreground `sleep 25` did not run.** The CLI blocked it
  ("standalone sleep ... use Monitor"), so the turn was kept open by the model
  turn itself, not by a sleep. The report still landed inside the first turn
  (before its `result`), which is the condition under test, but the timing
  came from the model's own turn and not from a controlled wait. Rerun with a
  command the CLI does not block (for instance `node -e "setTimeout(()=>{},25000)"`)
  to make the in-turn arrival deterministic.
- One run only; the verdict fields are `reportedInsideFirstTurn`,
  `initAfterFirstResult` and `resultTexts`. Cost: a few cents (haiku).

### Rerun with a command the CLI does not block (`result-inturn-timer.json`)

Same scenario, same day, the foreground command is `node -e "setTimeout(()=>{},25000)"`
(the CLI blocks a bare `sleep`). It ran, and the CLI moved it to the background
(`local_bash`, `is_backgrounded: false` in the frame).

| | measured |
|---|---|
| background `Agent` calls | 1 (`is_backgrounded: true`) |
| subagent report (`task_notification`) | t=8192 ms, inside the first turn |
| `system/init` after a `result` | **no** |
| `result` frames | 1: `FINAL: DONE` (3 turns, t=34900 ms) |

- **No reaction turn this time.** The report was absorbed by the turn in flight.
  Together with the first run, the real CLI sometimes opens a turn of its own for
  a report that landed inside the turn that holds the answer, and sometimes
  not; what decides it is not known (one run of each). The guard in
  `server/src/sealedanswer.js` stays: once is enough to lose a plan.
- Cost: a few cents (haiku).

## Does the CLI send `init` before every turn? (issue #36, part G1)

`--cli <path>` runs the session on another Claude Code executable
(`pathToClaudeCodeExecutable`), and each run's verdict carries `initPerTurn`:
`true` when every `result` after the first had a `system/init` before it,
`false` when one did not, `null` when the run had a single `result` and so
cannot say. The probe now removes its own `subagent-probe-*` temp directory when
a run ends.

Scenario `inturn`, run twice on 2026-10-07 (SDK 0.3.292, Windows, haiku):

| CLI | file | `results` | `initPerTurn` |
|---|---|---|---|
| the SDK's bundled one | `result-init-bundled.json` | 1 | `null` |
| `claude.exe` on the PATH (`--version` says 2.1.289) | `result-init-native.json` | 1 | `null` |

Both runs were the "no reaction turn" shape: the report landed inside the turn
in flight, there was one `init` at the start and one `result`, so **these two
runs do not decide whether `init` arrives per turn**. The one measurement that
does is the first `inturn` run above (`result-inturn-report.json`): the reaction
turn there was preceded by an `init`, 8 ms after the first `result`. So the
bundled CLI sends `init` per turn when it opens one; the PATH CLI has not been
seen opening a turn at all. The `claudeCode` field of the saved files is the
SDK's own version, not the executable's; the `cli` field says which one ran.
The runner's native CLI on `runner-1` was not reachable from this session and
was not measured. That is why `server/src/sealnet.js` also opens a turn on the
first main-thread `assistant` frame: with `init` present it changes nothing.

## Mutants (`mutants.mjs`, issues #31 g1 and #36 part A)

`node tools/subagent-probe/mutants.mjs` applies each named mutant of the seal
net (`server/src/sealnet.js`, `server/src/claude.js`,
`server/src/sealedanswer.js`) and of the seven `answerOf` call sites of
`server/src/pipeline.js` (one mutant per site: it hands `answerOf` a result that
carries only the adopted text), runs the tests listed in `TESTS`, and prints
`RED` when some test fails (what you want) or `GREEN` when the mutant survived.
The list is `MUTANTS` and `TESTS` in the script; the exit code is non-zero if
any mutant is not red.

- **Never on the live tree.** Each mutant is applied to a copy in a fresh
  temporary directory (`server/src`, `server/prompts`, `server/test`, the
  probe's `*.json`, the two `package.json`). The live files are only read, so
  killing the script at any point leaves `git status` clean. `config.json` is
  not copied: under test the board reads `server/test/fixtures/config.test.json`.
- **`server/node_modules` is a junction** into the copy (ESM ignores
  `NODE_PATH`). It is removed explicitly before the copy is, so the removal
  (`removeTree` from `server/test/teardown.mjs`) never follows it into the real
  modules. Without `server/node_modules` the tests that import the SDK cannot
  run.
- **A baseline first.** The unmutated copy must pass; if it does not, the script
  stops with the failing tail instead of reporting every mutant red for the wrong
  reason.
- **Also importable:** `runMutants({ root, mutants, tests, baseline, onMutant })`
  returns `{ results, tempDir }`. `server/test/probe-mutants.test.mjs` runs one
  real mutant through it and checks that `sealnet.js`, `claude.js` and
  `pipeline.js` are byte-identical before, during and after, that the copy is
  gone, and that the real `node_modules` is untouched.
