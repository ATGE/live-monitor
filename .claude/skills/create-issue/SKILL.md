---
name: create-issue
description: File ONE GitHub issue that someone (often an autonomous agent) can resolve without asking anything — and stop there. Use whenever an issue, ticket or task is to be created: the user says "open an issue", "file a bug", "create a ticket", "make an issue for X", "crea un issue / una tarea / un ticket", "abre un issue", "asígnamelo", or you are about to capture follow-up or leftover work from a review, a PR or this conversation. Use it instead of calling `gh issue create` directly. Creates the issue only; never implements the fix.
---

> Skill propia del tablero (2026-10-08). Nació como copia de la de hfs, pero ya no la sigue:
> se edita aquí, a gusto de Edson, y `server/test/board-skills.test.mjs` solo vigila su forma.
> Los comandos de esta skill asumen que el cwd es la raíz del repo donde va el issue o un
> worktree suyo: desde otro sitio ejecútalos con `git -C <ruta>` / `gh -R <owner>/<repo>`.

# Create a GitHub Issue

**Create the issue. Do not do the work.**

This skill ends when the issue URL is printed. Writing the issue is the entire
deliverable — the fix, the refactor, the test, the doc change described in the
issue are explicitly out of scope.

Assume the reader is an agent or contributor with **no access to this
conversation**, who will implement exactly what the issue says and whose work
will be reviewed against its acceptance criteria. Whatever you know and leave
out of the body is lost, and comes back later as "gaps" in review.

## Hard rules

- Do NOT edit, create, or delete any source file.
- Do NOT run builds, tests, formatters, or linters to "verify" the problem.
- Do NOT open a branch, commit, or PR.
- Do NOT start implementing after creating the issue, even if the fix looks
  trivial or you already know exactly what it is. Put that knowledge *in the
  issue body* instead.
- Create **one** issue unless the user explicitly asked for several. If the
  work looks separable, say so inside the issue (parts A, B, ... that can be
  separate commits or PRs), not by filing more issues.
- Never invent. A fact, citation, number or decision that you cannot point to
  in the conversation or in the code does not go in the body as a fact: ask the
  user, or put it under **Open questions**.
- If the user wants the work done too, they will ask in a separate turn. Wait
  for it.

Read-only investigation is allowed and encouraged — `grep`, reading files,
`git log`, `gh` — as much as it takes to make every citation true.

## Steps

1. **Harvest what the conversation already knows (mandatory).** Before
   writing anything, go back over the conversation and list, in your notes:
   - the problem and how it was observed (commands run, outputs, error text,
     measurements, counts, review findings);
   - every file, function, symbol, line, command, issue, PR or commit
     mentioned;
   - decisions already taken, options already discarded and why;
   - what the user explicitly wants included and excluded;
   - constraints and house rules that apply to the fix (language of docs,
     generated files that must not be hand-edited, secrets handling, test
     conventions such as "red first");
   - what "done" was said to mean, and how it would be checked.
   The user's last message is usually a one-line request; the substance is in
   the turns before it. Nothing from this list may be silently dropped: it
   goes in the body, or under Out of scope, or under Open questions.

2. **Fill the gaps or ask.** If something the body needs is not known
   (expected behaviour, scope boundary, who the issue is for), ask the user
   before creating — one short message with all the questions at once. If the
   user prefers not to answer, put the unknowns under **Open questions**.
   Never fill them with guesses.

3. **Ground and verify every citation (read-only).** Open each file you cite
   and check that the symbol, line or text is really there today. Prefer
   `path/to/file#symbol` (function, constant, test name) over bare
   `path:line`, because line numbers drift before the issue is worked; if you
   give a line, give the symbol next to it. Quote short code or log
   fragments exactly. A citation you could not verify is removed or moved to
   Open questions.

4. **Check for duplicates.**
   ```bash
   gh issue list --search "<keywords>" --state all --limit 20
   ```
   If a close match exists, show it to the user and ask whether to comment on
   it (or reopen it, if the project instructions say so) instead of opening a
   new one.

5. **Pick labels from what the repo actually has.**
   ```bash
   gh label list --limit 100
   ```
   Only apply labels that already exist — `gh issue create` fails on unknown
   labels. When nothing fits cleanly, apply none.

6. **Decide the assignee** (see "Assignment" below).

7. **Write the body** to a file in your session scratchpad directory, using
   your file-writing tool or a quoted heredoc (either avoids shell-quoting
   damage to backticks, `$`, and newlines). Follow "Issue shape" below.

8. **Run the self-check** below. Fix the body until every box is true.

9. **Create it.**
   ```bash
   gh issue create --title "<title>" --body-file "<scratch>/issue-body.md" --label <label> --assignee <login>
   ```
   If `gh issue create` misbehaves in this repo, fall back to the REST API:
   ```bash
   gh api repos/{owner}/{repo}/issues -f title="..." -F body=@"<scratch>/issue-body.md" -f "assignees[]=<login>"
   ```

10. **Report and stop.** Two or three sentences: the URL, who it is assigned
    to (or that it was left unassigned and why), and any Open questions left
    in it. Then hand control back.

## Assignment

- If the project instructions (CLAUDE.md or equivalent) name a default
  assignee — typically because an automated board only picks up issues
  assigned to a given login — assign to that login **without asking**, every
  time, unless the user says otherwise for this issue.
- If the user names an assignee ("assign it to me", "asígnamelo"), use it
  (`@me` for "me").
- If neither applies, leave it unassigned.
- Never assign someone else uninvited.

An unassigned issue in a repository watched by such a board is invisible to it
and never starts. Always say in the report whom you assigned.

## Issue shape

Language: **English** for the title and the body, whatever the language of the
conversation. Quote non-English UI text or logs only as quoted evidence.

Title: one specific line, imperative or symptom-first, at most ~100
characters. `Tenant slug mirror drops trailing hyphen on paste`, not `UI bug`.
For follow-ups, name the origin: `Follow-up to #12 / PR #15: ...`.

Body — every section below is **required**. Write `None.` only when that is
the honest answer (for example, no open questions); never drop a heading.

```markdown
## Summary
Two to four sentences: what is wrong or what should exist, why it matters,
and any ordering constraint ("do this after PR #15 is merged").

## Problem and evidence
What happens today, with the concrete trigger: exact command, request or
click path, and what was observed.
- `path/to/file#symbol` — what this code does that matters here (verified)
- Error output, log lines, measurements or failing assertion, in a fenced block
- Where the finding comes from (review, measurement, user report), so the
  reader knows how much to trust it

## Proposed approach
The fix as understood so far: what to change, where, and why this way.
Options already discarded, with the reason, so they are not re-proposed.
Split into Part A, Part B, ... when the work has independent pieces.

## Scope
What this issue covers, as a list.

## Out of scope
What it deliberately does not cover (with the issue/PR where it lives, if
any), and what is already done and must not be redone.

## Acceptance criteria
- [ ] One checkbox per observable outcome, each one checkable by someone who
      did not write the code (a test that is red before the change, a
      command whose output changes, a doc statement that becomes true).
- [ ] Project-wide conditions that apply (test suite passes, docs verifier
      green, generated files untouched).

## How to verify
The exact commands or steps that show the criteria hold, and what their
output should be.

## Open questions
What is still undecided or unknown, each with the options and, if there is
one, the recommended answer. `None.` if there are none.
```

For a feature request, "Problem and evidence" becomes the **Motivation**
(who needs it and the evidence for the need) and "Proposed approach" becomes
the **Proposed behavior**; every other section stays.

## Self-check before creating

Do not run `gh issue create` until every line is true:

- [ ] I re-read the conversation and every item of the harvest (step 1) is in
      the body, under Out of scope, or under Open questions.
- [ ] Every citation was opened and checked in the code today; symbols over
      bare line numbers.
- [ ] Nothing in the body is a guess presented as a fact.
- [ ] All required sections are present; Acceptance criteria is a checklist of
      observable outcomes; How to verify has concrete commands.
- [ ] Title and body are in English.
- [ ] It is one issue (unless several were asked for), not a duplicate.
- [ ] A reader with no access to this conversation could implement it without
      asking a question (no "as we discussed", no "the bug above").
- [ ] The assignee follows "Assignment", and I will state it in the report.

## Style

- Write for a contributor or agent who has not seen this conversation. No "as
  we discussed", no references to the current session.
- Complete over short: an issue that will be executed by an agent should carry
  everything the conversation established. Be concrete — paths, symbols,
  commands, outputs — not wordy.
- No emoji, no severity theater, no "🚨 CRITICAL".
- Do not attribute the issue to Claude or add tool footers unless asked.
