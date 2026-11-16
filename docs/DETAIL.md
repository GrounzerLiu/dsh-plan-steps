# Plan steps

The built-in `todo_write` tool records a whole-list snapshot and nothing else: a
completed item exists only because the model remembered to re-send the table
with a different status, and nothing checks that the two agree.

This plugin turns a completion into a host transaction:

- **`complete_step`** signs exactly one item off. It refuses an item that is not
  the current `in_progress` one, appends the advanced list as a `todo/write`
  snapshot — the same event the shipped tool writes, so the task panel and every
  log reader see the step close — and names the step that became current. The
  model never re-sends the table to record progress.
- **A tool guard** refuses a `todo_write` that turns an item `completed` when the
  host's list still has it open. Closing an item has one legal path.
- **A turn-stopping hold** steers the model back when a turn is about to close
  with open items. The steering message is authored as
  `source.kind: 'system-prompt'`, not as the user speaking.
- **`wait_for_user`** is the sanctioned way out: a turn that declares what it is
  waiting for is not held back. The declaration lasts one turn.
- **Host task state** rides the request while the list has open items, so a fold
  that drops the model's own `todo_write` does not leave it guessing. It is
  re-sent only when the visible window no longer carries it.

The host list is the latest `todo/write` event in the session log, so a fold, a
fork, or a restarted process derives the same list. Nothing is cached in plugin
memory. A host whose todo tool writes no event falls back to replaying the
`todo_write` and `complete_step` calls.

## What the model sees

Signing a step off:

```json
{ "step": "probe C", "result": "probe C verified" }
```

> Step "probe C" done: probe C verified The host advanced the list; the next
> step is 2 "probe D". (1 open)

Closing an item behind the host's back:

> blocked: todo "probe D" is newly completed with no complete_step sign-off.
> Call complete_step for it first — the host marks it completed and advances the
> list for you — or send todo_write again leaving that item in_progress.

Ending a turn with open items:

> Your task list still has 2 open step(s); the current one is "...". Keep working
> on it, and call complete_step the moment a step is finished. If you are waiting
> on the user, call wait_for_user with one line naming what you need — that is
> what lets the turn end with the item still open. Do not end a turn that still
> has work you can do.

The request carries the list itself:

> Host task state. This list is the host's, not a message you sent; sign a step
> off with complete_step once it is finished.
> 1. "..." [completed]
> 2. "..." [in_progress]

## Configuration

Environment variables, read when the plugin activates:

| Variable | Default | Effect |
| --- | --- | --- |
| `PLAN_STEPS_GUARD` | on | `0` stops the `todo_write` guard. |
| `PLAN_STEPS_HOLD` | on | `0` stops the turn-stopping hold. |
| `PLAN_STEPS_RESTORE` | on | `0` stops writing the open list back at the start of a turn. |

The tools stay registered either way.

## Tests

```sh
node --test test/
```

Fifteen cases over the pure helpers: name normalisation, step resolution
(`step_id` before name before position), the flat and two-level advance rules
(next sibling, phase sign-off last, phase with open sub-steps refused, next
phase's first sub-step), serial validation (single current item, phase made
current too early, pending work with no current item), call replay, step
identity, the stored-state parser, and the state block.

## Verification

Checked in a live session:

- Two-item list, sign the first item off — the reply names the second as the
  next step.
- A `todo_write` closing the second item directly — refused.
- Sign the second item off — the reply reports every step complete.
- End a turn with two items still open — the turn did not close; a steering
  message arrived and the work continued.
- Signing an item off writes a `todo/write` snapshot (checked in the session
  log), so the task panel reads the advance without a `todo_write` call.
- The steering message is recorded with `source.kind: 'system-prompt'`.
- The next step's request carried the host task state block.

## Deliberate non-goals

Three things a fuller implementation would have are left out on purpose. Each
one is a decision, not a gap waiting to be found.

**No step ids.** The shipped task list stores a name and a status, so the name
is the only identity an item has. This plugin could mint ids in a side table
keyed by name — but a rename breaks that key anyway, and owning an id would mean
owning the list's write format, which is the shipped tool's job. The guard's
"completed count first, names second" rule is the cheapest thing that still
distinguishes a relabel from a completion.

**The hold is soft.** A turn is pulled back at most once, and a second stop is
allowed. DSH has no core "waiting on the user" state a gate could key on, so a
hard gate would have to infer intent from text — and a model that is genuinely
blocked would be trapped in a loop it cannot leave. One hold plus `wait_for_user`
gets the behaviour without that failure mode: a model that ignores the list still
ends its turn, just visibly.

**The panel stays the shipped one.** The `todos` projection resets at
`turn/start` by design, so this plugin writes the open list back at the boundary
instead of replacing the panel. Owning a cross-turn panel means a Client module,
a wire view and a second source of truth in the UI; that is a different plugin,
and two panels showing different lists would be worse than one that restores.

A fourth omission is not a decision but an accepted consequence: any other writer
of `todo/write` — plan mode seeding, a direct `todo_write` — replaces the list
wholesale. The host reads the last snapshot, so the two views realign at the next
write; nothing drifts permanently.

## Limits

- The turn-start restore runs on a macrotask because appending inside the
  `turn/start` dispatch does not land. That is an observed host behaviour, not a
  contract: a failed early write logs one warning per session and the pre-step
  restore still runs, so a host change degrades to a one-step delay rather than
  a blank panel.
- The hold fires at most once per turn. A model that refuses to update its list
  still finishes its turn on the second stop; the plugin reports the list rather
  than trapping the session.
- `wait_for_user` cannot tell a real wait from a convenient one: it trusts the
  declaration. A turn that declares a wait and then keeps working simply skips
  one hold.
- The client still decides how a `system-prompt`-sourced message looks. If it
  draws a user bubble, the content is at least attributed to the host in the log.
- The shipped task projection resets on `turn/start`, so the panel shows the
  list only once this turn has written one.
- Item identity is the item's name, because the shipped task list has no step
  ids. A rewrite that adds no completion may rename freely; one that adds a
  completion is checked name by name, so renaming *and* closing in one write is
  still refused.
- The list is read through the plugin's own `sessionProjections` unit
  (`task-steps/todos`); `deriveMessages()` is still read directly for the
  visible-window check, and a host without the projection seam falls back to
  `Session.snapshotEvents()`, which the core deprecates.
- The state block is injected at most once per visible window; when a step is
  signed off, the list in the request is one snapshot behind until the next
  window or until the model reads the tool result.
