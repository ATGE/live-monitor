---
name: heuristic-review
description: >
  Heuristic usability review using the Nielsen Norman Group method: inspect an
  interface against the ten usability heuristics and rate every problem with
  a severity from 0 to 4. Use when asked to review, critique or audit the
  usability of a screen, flow or running UI.
---

# Heuristic review

Method: Nielsen's ten usability heuristics (Nielsen Norman Group). Evaluate the real interface, a
screenshot, or a flow description; never review from the code alone.

## The ten heuristics

1. Visibility of system status
2. Match between the system and the real world
3. User control and freedom
4. Consistency and standards
5. Error prevention
6. Recognition rather than recall
7. Flexibility and efficiency of use
8. Aesthetic and minimalist design
9. Help users recognize, diagnose, and recover from errors
10. Help and documentation

## Severity scale (0 to 4)

| Rating | Meaning |
|---|---|
| 0 | Not a usability problem. |
| 1 | Cosmetic: fix only if time allows. |
| 2 | Minor: low priority. |
| 3 | Major: important to fix, high priority. |
| 4 | Catastrophe: imperative to fix before release. |

Rate by three factors together: how often the problem occurs, how hard it is for users to get past it,
and whether it persists after they have met it once.

## Procedure

1. Fix the scope: the task, the user, the screens or flow. Walk it end to end at least twice, once to
   get the picture and once to inspect each element against the heuristics.
2. For every problem record: the screen and element, the heuristic violated, what happens to the user
   (evidence, not taste), the severity 0 to 4, and a concrete fix.
3. Merge duplicates: one problem violating two heuristics is one finding naming both.
4. Do not list things that work; mention a strength only when changing it would be a risk.

## Output

A table sorted by severity, highest first: `#`, location, heuristic, finding, severity, fix. Close with
the count of findings per severity and the three fixes with the best impact for the least work.
