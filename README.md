# dsh-task-steps

Host-owned task-list steps for DeepSeek Harness: `complete_step` signs one item
off and the host advances the list, a guard refuses an unsigned completion, and a
turn is pulled back while the list still has open work.

## What it adds

| Piece | Effect |
| --- | --- |
| `complete_step` | Signs the current `in_progress` item off, appends the advanced list as a `todo/write` snapshot (the panel follows), and names the next step. |
| guard | Refuses a `todo_write` that turns an item `completed` while the host still has it open. |
| turn hold | Steers the turn back when it is about to close with open items — once per turn. |
| `wait_for_user` | Declares a wait, so that turn may end with the item open. |
| request state | Carries the host list into the request when the visible window has lost it. |

The list itself is the latest `todo/write` event in the session log, so a fold,
a fork, or a restart derives the same list. Nothing is cached in plugin memory.

## Why not just make `todo_write` mark things completed?

Because the shipped `todo_write` is the model's own statement, and a statement
about progress is exactly the thing that goes stale silently. A tool that both
records the plan and certifies the work cannot tell "I finished it" from "I want
this off my list" — and after a fold, the model no longer even has the table it
would be editing.

Splitting the two makes the distinction structural:

- `todo_write` still owns the plan: what the steps are, in what order.
- `complete_step` owns execution: one item, the current one, at the moment it is
  done.
- The host owns the list, so "signed off" and "still open" are facts it can
  check — in the guard, at the end of a turn, and in the request.

## Coexistence with the shipped todo tool

The shipped `todo_write` stays authoritative for the plan, so the two never
fight over one state:

- **One source of truth.** The list is the last `todo/write` event. The shipped
  tool writes one per call, and so does `complete_step`, so anything that writes
  that event is what both sides read.
- **Creating and rewriting a plan still goes through `todo_write`.** A new list
  (items `pending`) is always accepted; the guard only looks at items turning
  `completed`.
- **A replan may rename freely** as long as it does not add a completion: the
  guard compares the completed count, then the names. Renaming *and* closing in
  the same write is refused.
- **Plan mode / other seeders** that write the same event are honoured; this
  plugin has no separate store to fall out of sync.
- **Disabling this plugin** leaves the lists in the log; the shipped panel keeps
  rendering them.

## Install

Local directory, no build step, no dependencies:

```sh
# in the Harness UI: Plugins > Add plugin > pick this directory
# or, with the manager tool:
#   install_bundle(target: "D:/dsh-plugins/dsh-task-steps")
```

The bundle inserts one row, `include:task-steps`. Two tools join the model's
toolset: `complete_step` and `wait_for_user`.

## Configure

Environment variables, read when the plugin activates:

| Variable | Default | Effect |
| --- | --- | --- |
| `PLAN_STEPS_GUARD` | on | `0` stops the `todo_write` guard. |
| `PLAN_STEPS_HOLD` | on | `0` stops the turn-stopping hold. |
| `PLAN_STEPS_RESTORE` | on | `0` stops writing the open list back at the start of a turn. |

The tools stay registered either way.

## Uninstall

`remove_bundle` in the Plugin Manager, or disable the `task-steps` row. Nothing
is written outside the plugin directory, so removal needs no cleanup. Task lists
written before removal stay in the session log and remain readable by the shipped
todo tool.

## Tests

```sh
node --test test/
```

## Troubleshooting

**The panel goes blank at the start of a turn.** The shipped task projection
resets on `turn/start`. This plugin writes the open list back on the next
macrotask, and the first step of the turn restores it again if that write fails.
A failed early write logs one warning per session (`task-steps: could not
restore the task panel at turn start`), so a host change shows up in the log
instead of as a silent blank panel.

**`complete_step` says the session has no task list.** No `todo_write` has
succeeded in this session yet, or the host exposes no session log to the plugin.
Create the list first.

**A completion is refused.** The guard fired: the item was closed in a
`todo_write` without a `complete_step` in the same session. Sign it off first,
or send the list again leaving it `in_progress`.

**A turn keeps getting pulled back.** Expected once per turn while items are
open. To end a turn deliberately, call `wait_for_user` with what you need; to
stop the behaviour entirely, set `PLAN_STEPS_HOLD=0`.

**`step "..." matches no task-list item`.** The list is rebuilt from the log, so
the name must match an item in the current snapshot. The error lists every item
with its status and position.

**A `client:` half is served only from a tarball/registry install.** The Web host
serves `/plugins/<id>/client.js` from a path inside the profile; an install that
resolves through `link:D:/...` reports a module outside it and the browser gets a
404 (`import failed` on boot). Replacing the profile's symlink with a junction or
a real copy does not help: the client scan resolves the package from the
profile's `link:` spec. A tarball install does serve the module, but a
registration for `tool.call.toolview` / `todo_write` still did not shadow the
shipped row at either priority (`-1` and `1` both accepted, neither rendered), so
this repository ships no client half. The host half is unaffected — tools,
guards and the turn hold all run from the linked package.

## Behaviour notes

- The hold fires at most once per turn, so a model that refuses to update its
  list still finishes.
- `wait_for_user` trusts the declaration; it cannot tell a real wait from a
  convenient one.
- The request state block is injected at most once per visible window, so a
  freshly signed-off list can be one snapshot behind in the request.
- Item identity is the item's name; the shipped list has no step ids.

Three of those are deliberate: no step ids, a soft hold, and the shipped panel.
The reasoning for each is in [docs/DETAIL.md](docs/DETAIL.md#deliberate-non-goals).
