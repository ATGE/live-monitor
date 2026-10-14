---
name: accessibility-audit
description: >
  Accessibility audit of a running page against WCAG 2.2 (level AA), combining
  a manual pass with one executable check (axe-core or pa11y) whose output is
  reported as evidence. Use when asked to audit, verify or certify the
  accessibility of a page or flow, or to confirm a fix.
---

# Accessibility audit

An audit that was not run is an opinion. Always run the executable check below and report its raw
result; add the manual pass for what automation cannot see (automated tools find roughly a third of
WCAG problems).

## 1. Executable check

Run it against the URL of the running page, never against a guess. Pick one tool that is available
and say which; use a project-local install when there is one, otherwise a one-off run.

- axe-core through the CLI: `npx --yes @axe-core/cli <url> --tags wcag2a,wcag2aa,wcag21aa,wcag22aa --exit`
- or pa11y: `npx --yes pa11y --standard WCAG2AA --reporter json <url>`

Do not start a browser the person is using, and do not kill processes you did not start. If the tool
cannot run (no browser, no network), say so and mark the audit as manual only; never claim a pass.

Keep, per violation: rule id, impact, WCAG success criterion, the selector, and the count.

## 2. Manual pass (WCAG 2.2 AA)

- **Keyboard**: every function reachable by Tab and operable by keyboard, visible focus (2.4.7), focus
  not obscured by sticky headers (2.4.11), no keyboard trap, logical order.
- **Names and roles**: controls have accessible names; headings and landmarks give a usable outline.
- **Contrast**: text 4.5:1 (3:1 for large text), UI components and focus rings 3:1.
- **Target size**: pointer targets at least 24x24 CSS px (2.5.8).
- **Reflow and zoom**: usable at 320 px wide and 200% zoom without two-direction scrolling.
- **Forms**: labels, error messages that say what to fix, no re-asking known data (3.3.7), no
  cognitive test to authenticate (3.3.8).
- **Motion**: honors reduce-motion; nothing flashes more than three times a second.
- **Dragging**: any drag has a single-pointer alternative (2.5.7).

## Output

Report the tool used and its command, then one table: criterion, location, finding, evidence (tool
rule or manual step), severity (Blocker, Major, Minor), fix. End with a verdict: pass, pass with
minors, or fail, and what was not covered.
