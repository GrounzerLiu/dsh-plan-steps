# dsh-plan-steps

[中文](README.md) | English

Plan steps for DeepSeek Harness: `plan_write` records a two-level plan,
`complete_step` signs one item off and the host advances the list, a guard
refuses an unsigned completion, a turn is pulled back while items are open, and
the panel shows the current item and `已完成 N / M` live.

The design follows [Reasonix](https://github.com/esengine/DeepSeek-Reasonix) —
its `todo_write` / `complete_step` / `AdvanceSerialTodo` semantics: two-level
phases and sub-steps, stable `step_id`, and the phase signing off last. This
plugin is a rewrite against DSH's event and slot model, not a port.

## What it adds

| Piece | Effect |
| --- | --- |
| `plan_write` | Records a two-level plan: `level` 0 phases, `level` 1 sub-steps, an optional stable `step_id`, exactly one current item. A rewrite is checked for continuity: an existing id is never dropped, the current item is never removed or moved back to pending, and completed history keeps its position — once every item is completed the plan is history and a new one may replace it. |
| `complete_step` | Signs the current `in_progress` item off, appends the advanced list as a `todo/write` snapshot (the panel follows), and names the next step. A phase signs off only after its sub-steps. |
| guard | Refuses a `plan_write` / `todo_write` that turns an item `completed` while the host still has it open. |
| turn hold | Steers the turn back when it is about to close with open items — once per turn. |
| `wait_for_user` | Declares a wait, so that turn may end with the item open. |
| `abandon_plan` | Drops the current plan: the list clears, the panel disappears, and the required `reason` stays in the transcript. The only write that bypasses the rewrite continuity rules. |
| `unlock_plan` | Releases a stale-plan lock: it records why the list cannot be answered and lets every tool run again. It completes nothing and leaves the list untouched. |
| request state | Carries the host list into the request when the visible window has lost it. |
| dock panel | Replaces the pinned task panel with the current item name and `已完成 N / M` + a segmented bar, expanded into a nested list. |
| step row | The same position on every `complete_step` tool row. |

The list is the latest `todo/write` event in the session log, so a fold, a fork,
or a restart derives the same list. Nothing is cached in plugin memory.

## Why separate writing a plan from certifying work

The shipped `todo_write` is the model's own statement: it both records the plan
and declares the work done. One action for both cannot tell "I finished it" from
"I want this off my list" — and after a fold the model no longer even holds the
table it would be editing.

Splitting them makes the distinction structural:

- `plan_write` owns the plan: which steps exist, in what order.
- `complete_step` owns execution: one item, the current one, only once it is done.
- The host owns the list, so "signed off" and "still open" are facts it can check
  in the guard, at the end of a turn, and in the request.

## How advancement works

In order, depth first: a phase's sub-steps run in list order; the phase stays
`pending` while they run and becomes the current item only after all of them are
completed (the phase signs off last); only then does the next phase's first
sub-step become current.

```
1 调研与设计          pending
   1.1 读现有实现      in_progress   <- current
   1.2 记录要点        pending
2 实现                pending
   2.1 改代码          pending
```

Sign 1.1 and 1.2 becomes current; sign 1.2 and phase 1 becomes current awaiting
sign-off; sign 1 and 2.1 becomes current. The rules are enforced, not conventions:
a phase with unfinished sub-steps can neither be `in_progress` nor be signed off.

## Tools

**`plan_write`**

| Parameter | Meaning |
| --- | --- |
| `todos[].content` | Task name; required and unique |
| `todos[].status` | `pending` / `in_progress` / `completed` |
| `todos[].level` | `0` phase, `1` sub-step |
| `todos[].step_id` | Stable identity, copied verbatim on every rewrite |
| `todos[].activeForm` | Present-continuous label, optional |

**`complete_step`**

| Parameter | Meaning |
| --- | --- |
| `step_id` | Preferred: the stable identity |
| `step` | Item name, when there is no id |
| `index` | 1-based position, when neither of the above resolves |
| `result` | Required: what is now true after finishing the step |

**`wait_for_user`**

| Parameter | Meaning |
| --- | --- |
| `need` | One line naming what you are waiting for; placeholders are refused |

## Install

Local directory, no build step, no runtime dependencies:

```sh
# in the Harness UI: Plugins > Add plugin > pick this directory
# or with the manager tool:
#   install_bundle(target: "D:/dsh-plugins/dsh-plan-steps")
```

From GitHub (real files land in the profile, so the client half is served too):

```sh
dsh plugin --profile desktop add github:GrounzerLiu/dsh-plan-steps
# then add dsh-plan-steps to the profile's dsh.profile.bundles
```

The bundle inserts one row, `include:plan-steps`, and puts `plan_write`,
`plan_write`, `complete_step`, `wait_for_user`, `abandon_plan` and `unlock_plan` into the model's toolset.

**The `client:` half needs a tarball / git install.** With `link:` the Web host
cannot serve `/plugins/<id>/client.js` (the path resolves outside the profile and
the browser gets a 404), so the panel stays the shipped one; the host-side tools
are unaffected. Reload the page once after installing so the client module enters
the boot graph.

## Configure

The five switches live on the **plugin's own page**: find the `plan-steps` row in
the Plugin Manager and press Configure.

| Switch | Default | Effect |
| --- | --- | --- |
| Refuse unsigned completions | on | off: `plan_write` / `todo_write` may mark an item completed itself |
| Pull a turn back while items are open | on | off: a turn may end with the list still open |
| Rebuild the panel snapshot each turn | on | off: after `turn/start` the panel waits for the model's next write |
| Remind when the plan goes stale | on | after N steps without touching the list, the request carries a "keep the plan moving" note |
| Stale reminder threshold (steps) | 8 | how many steps count as stale, and the minimum gap between reminders |

The same fields can be set under the row's `config` in the profile's
`cordis.patch.yml` as deployment defaults; the plugin page wins. The tools stay
registered either way.

## Uninstall

`remove_bundle` in the Plugin Manager, or disable the `plan-steps` row. Nothing is
written outside the plugin directory, so removal needs no cleanup; lists written
before removal stay in the session log and remain readable by the shipped tool.

## Tests

```sh
node --test test/
```

Thirty-six cases: the five two-level advancement positions, the three rewrite
continuity rules, serial validation, call replay, and the stale-lock decisions.

## Stale-plan lock (off by default)

When the list has gone untouched for the configured number of steps and items are
still open, the plugin normally injects a reminder. Turn on **Lock tools when the
plan goes stale** and the same threshold freezes every tool instead:

```
8 steps without a plan update -> locked -> only this plugin's five tools run (plus run_code, the PTC channel)
```

A refused call comes back with the current item, how many items are open, and every
way out. Any of the five tools **that succeeds** releases the lock and resets the
clock:

A PTC session reaches every tool through `run_code`, so the runner itself stays
callable: nested `tools.*` calls run the same guard, which still refuses `bash` there
while `complete_step` gets through.

| Call | What it says |
| --- | --- |
| `complete_step` | This step is finished |
| `wait_for_user` | I am blocked on the user |
| `plan_write` | The list is wrong, here is the corrected one (a rewrite with no change does not count) |
| `abandon_plan` | The list is void |
| `unlock_plan` | I cannot account for the list — here is why |

A call that fails — the wrong item, a rejected rewrite — releases nothing.

The point is not to trap a model but to make the permissive path explicit: when the
work is actually finished, no reason for not answering the list holds up, so the
model either signs off or writes down something the user will read.

## Troubleshooting

**The panel is blank for a moment at the start of a turn.** The shipped task
projection resets on `turn/start`. This plugin writes the open list back on the
next macrotask, and the turn's first step restores it again if that write fails. A
failed early write logs one warning per session (`plan-steps: could not restore
the task panel at turn start`), so a host change shows up in the log instead of as
a silent blank panel.

**`complete_step` says the session has no task list.** No `plan_write` has
succeeded yet, or the host exposes neither a projection nor a session log. Create
the list first.

**A completion is refused.** The guard or the continuity check fired: an item was
marked `completed` in `plan_write`, or a rewrite dropped a `step_id`, removed or
regressed the current item, or moved completed history. Sign off with
`complete_step`, then rewrite.

**A turn keeps getting pulled back.** Expected once per turn while items are open.
To end a turn deliberately, call `wait_for_user` with what you need; to stop the
behaviour entirely, set `PLAN_STEPS_HOLD=0`.

**`step "..." matches no task-list item`.** The list is rebuilt from the log, so
the reference must match an item in the current snapshot; the error lists every
item with its status and position.

## Licence

MIT — see [LICENSE](LICENSE).

The panel inlines path data from [Material Symbols](https://fonts.google.com/icons)
(Google, Apache-2.0): the checklist, check-circle and chevron glyphs in
`client.js`.

## Design notes

No hard final gate, the panel still riding the shipped projection, and levels
travelling through the content as a zero-width marker are deliberate choices; the
reasoning is in [docs/DETAIL.md](docs/DETAIL.md).
