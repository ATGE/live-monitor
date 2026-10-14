---
name: design-canvas
description: >
  Board-owned design-canvas flow for exploring a UI before touching the repo:
  write a brief, draw the same screens in every direction, fix the tokens,
  then read the canvas back to compare the implementation screen by screen.
  Use when a person asks for design directions, a mockup, or a visual
  comparison of a new or reshaped screen.
---

# Design canvas

A canvas is a scratch surface (an artifact, a standalone HTML file outside the repo, or a design tool). It
holds the design; the repository holds only the implementation. Work in this order and do not skip steps.

## Rules

- **Do not touch the repo while designing.** No edits, no branches, no commits. The canvas is the only
  thing you write until the person picks a direction.
- **Every direction shows the same screens.** If direction A has a list, a detail and an empty state,
  directions B and C have exactly those three. A comparison between different screens decides nothing.
- **Tokens are declared once per direction**, not inlined: color roles (surface, text, accent, danger,
  focus ring), type scale, spacing scale, radius, elevation. Name the roles, not the hex values.

## Flow

1. **Brief.** Write it before drawing anything, in a few lines: who uses it, the task they are doing,
   the screens in scope, constraints already fixed (existing components, brand, devices), and what
   "better" means. Ask the person for what is missing; do not invent it.
2. **Inventory.** List the screens and the states each needs: default, empty, loading, error, long
   content, narrow viewport. This list is the contract for every direction.
3. **Directions.** Propose two or three that differ in structure or hierarchy, not only in color. Give
   each a one-line idea and its token set. Draw every screen of the inventory in every direction.
4. **Review with the person.** Show the directions side by side. Record the choice and the reasons, and
   any tweaks, in the canvas itself.
5. **Hand-off.** Freeze the chosen direction: its tokens and its screens. Only now implementation may
   start, in the repo, following the project's own conventions and components.
6. **Read the canvas back.** After implementing, open the canvas again and compare the running UI to it
   screen by screen and state by state. List each difference (layout, token, copy, state missing) and
   fix or justify it. Do not declare done from memory of the design.

## Output

Report: the brief, the screen inventory, the chosen direction with its tokens, and the comparison table
from step 6 (screen, state, matches or difference, action taken).
