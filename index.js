/**
 * Host-owned task-list steps.
 *
 * The shipped `todo_write` tool records a whole-list snapshot and nothing else:
 * a completed item exists only because the model remembered to re-send the table
 * with a different status. This plugin adds the missing half — `complete_step`
 * signs exactly one item off and the host advances the list — plus the guard
 * that refuses a `todo_write` marking a new item completed with no sign-off, and
 * a turn-stopping hold that steers the model back while the list is still open.
 *
 * The canonical list is rebuilt the way the host rebuilds any derived state:
 * by replaying the session log (the latest successful `todo_write` call, then
 * every successful `complete_step` after it). Nothing is cached in plugin
 * memory, so a fold, a fork, or a restarted process still reads the same list.
 *
 * Zero external runtime dependencies on purpose: a profile copy of
 * `@deepseek-ai/dsh-tools` is a different module instance from the one the host
 * registry is built on, so this hands the registry a plain object whose
 * parameters and output already use standard JSON Schema.
 *
 * @module dsh-plan-steps
 */

import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'

export const name = 'plan-steps'
export const inject = ['tools']

/** Marks a level-1 sub-step inside content, which every projection keeps. */
const SUB_STEP_MARK = '​'

/**
 * Turn parsed items back into the snapshot payload, restoring the sub-step
 * marker that `toItem` strips: every reader of the event, the panel included,
 * only sees what the payload carries.
 * @param items - the parsed list.
 * @returns the payload for a `todo/write` append.
 */
function snapshotOf(items) {
  return items.map((item) => ({
    content: item.level === 1 ? SUB_STEP_MARK + item.content : item.content,
    status: item.status,
    ...(item.level === 1 ? { level: 1 } : {}),
    ...(item.stepId === undefined ? {} : { step_id: item.stepId }),
  }))
}

/** The shipped task list's snapshot event: one whole-list write per update. */
const TODO_WRITE = 'todo/write'

/** The switches this plugin exposes on its row in the plugin page. */
export const Config = Schema.object({
  // `.volatile()` is what makes a field editable from the plugin page without a
  // remount; an ordinary field is validated but never rendered.
  guardUnsignedCompletions: Schema.boolean().default(true).volatile(),
  holdOpenList: Schema.boolean().default(true).volatile(),
  restorePanel: Schema.boolean().default(true).volatile(),
  remindStalePlan: Schema.boolean().default(true).volatile(),
  stalePlanSteps: Schema.number().default(20).volatile(),
})

/** Turns already held once, so a model that will not update its list still ends. */
const heldTurn = new WeakMap()

/** Last step that touched the plan, and the step last reminded, per session. */
const planClock = new WeakMap()

/** Sessions that declared they are waiting on the user this turn. */
const waitingSessions = new WeakSet()

/** The turn whose panel snapshot was already re-written, per session. */
const restoredTurns = new WeakMap()

/** The step whose one sign-off was already claimed, per session. */
const claimedStep = new WeakMap()

/** Sessions whose turn-start restore failure was already reported. */
const restoreWarned = new WeakSet()

/** Declarations that say nothing: a test word or a placeholder is not a need. */
const PLACEHOLDER_NEED = /^(?:test|testing|todo|tbd|n\/a|none|foo|bar|baz|asdf|xxx)[.!]?$/i

/** One plugin-authored context message: host-authored, so no user bubble. */
function makeMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'system-prompt' },
  }
}

/** Step names compared after trimming and collapsing runs of whitespace. */
function normalize(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ')
}

/**
 * The guard's message for a rewrite that closes an item the host still holds
 * open. It names the item the way `complete_step` wants it, so the reader can
 * copy one identifier instead of guessing which step was meant.
 * @param previous - the list the host holds.
 * @param submitted - the submitted payload.
 * @returns a refusal reason, or undefined when the rewrite adds no completion.
 */
function unsignedCompletion(previous, submitted) {
  const done = previous.filter((item) => item.status === 'completed').length
  const nextDone = submitted.filter((item) => item?.status === 'completed').length
  if (nextDone <= done) return undefined
  const already = new Set(previous.filter((item) => item.status === 'completed').map((item) => normalize(item.content)))
  for (const item of submitted) {
    if (item?.status !== 'completed') continue
    const key = normalize(item.content)
    if (already.has(key)) continue
    const known = previous.find((candidate) => normalize(candidate.content) === key)
    const index = known === undefined ? -1 : previous.indexOf(known) + 1
    const identified =
      known?.stepId === undefined
        ? index === -1
          ? ''
          : ` (item ${index} of ${previous.length}, step: ${JSON.stringify(known.content)})`
        : ` (step_id ${JSON.stringify(known.stepId)}, item ${index} of ${previous.length})`
    return (
      `blocked: todo ${JSON.stringify(item.content)}${identified} is newly completed with no complete_step sign-off. ` +
      'Call complete_step for it first — the host marks it completed and advances the list for you — ' +
      'or send todo_write again leaving that item in_progress.'
    )
  }
  return undefined
}

/**
 * One stored item. The mirrored fields — `level` and `stepId` — are the ones a
 * two-level plan needs; a flat list simply has neither.
 */
function toItem(todo) {
  let content = String(todo?.content ?? '')
  // The shipped projection keeps only content and status, so a sub-step carries
  // a leading zero-width space: it survives every reader and is invisible.
  let marker = false
  if (content.startsWith(SUB_STEP_MARK)) {
    marker = true
    content = content.slice(SUB_STEP_MARK.length)
  }
  const item = { content, status: todo?.status ?? 'pending' }
  if (marker || Number(todo?.level) === 1) item.level = 1
  const id = String(todo?.step_id ?? todo?.stepId ?? '').trim()
  if (id !== '') item.stepId = id
  return item
}

/**
 * Validate one stored projection value. The unit starts as `null`, so the
 * schema has to accept that state as well as a list.
 * @param value - a stored snapshot.
 * @returns the normalized list, or null before the first write.
 */
function parseTodos(value) {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) throw new Error('plan-steps: a stored task list must be an array or null')
  return value.map(toItem)
}

/** One logged call's arguments, or undefined when the log holds no parseable ones. */
function callArgs(event) {
  const raw = event?.data?.arguments
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * The session's events, as a stable frozen snapshot.
 * @param session - the session to read.
 * @returns the log snapshot, or undefined when this host exposes none.
 */
function sessionEvents(session) {
  if (session === undefined) return undefined
  if (typeof session.snapshotEvents === 'function') {
    try {
      const snapshot = session.snapshotEvents()
      if (Array.isArray(snapshot)) return snapshot
    } catch {
      return undefined
    }
  }
  return Array.isArray(session.events) ? session.events : undefined
}

/**
 * Read the list through the plugin's own projection when the host handed one
 * back, and fall back to a log scan otherwise. The projection is the sanctioned
 * incremental read; the scan is what a host without the seam can still serve.
 */
let readProjected = null

/**
 * Rebuild the host list from the session log. The `todo/write` event is the
 * canonical snapshot — the shipped tool appends one per write, and so does
 * `complete_step` — so the last event is the whole answer. A host whose todo
 * tool writes no event falls back to replaying the tool calls.
 * @param session - the session to read.
 * @returns the current items, or null before a successful `todo_write`.
 */
function listOf(session) {
  if (session === undefined) return null
  if (readProjected !== null) {
    try {
      const projected = readProjected(session)
      if (Array.isArray(projected)) return projected.map(toItem)
    } catch {
      // A session the projection has not materialized falls through to the scan.
    }
  }
  const events = sessionEvents(session)
  if (events === undefined) return null
  let written = null
  let sawWrite = false
  for (const event of events) {
    if (event?.type !== TODO_WRITE) continue
    sawWrite = true
    if (Array.isArray(event.data?.todos)) written = event.data.todos.map(toItem)
  }
  if (sawWrite) return written
  return replayCalls(events)
}

/**
 * Fallback: the same list, rebuilt from the tool calls when the host stores no
 * `todo/write` event. Only settled calls count, and only a successful one.
 * @param events - the session log snapshot.
 * @returns the current items, or null.
 */
function replayCalls(events) {
  const settled = new Set()
  const failed = new Set()
  for (const event of events) {
    const message = event?.type === 'tool/result' ? event.data?.message : undefined
    if (message === undefined) continue
    settled.add(message.toolCallId)
    if (message.isError === true) failed.add(message.toolCallId)
  }
  let list = null
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const call = event.data
    if (call === undefined) continue
    if (!settled.has(call.callId) || failed.has(call.callId)) continue
    const args = callArgs(event)
    if (call.name === 'todo_write') {
      if (Array.isArray(args?.todos)) list = args.todos.map(toItem)
      continue
    }
    if (call.name !== 'complete_step' || list === null) continue
    const at = locate(list, args?.step_id, args?.step, args?.index)
    if (at !== -1 && list[at].status === 'in_progress') list = advance(list, at)
  }
  return list
}

/** The model-facing inventory a citation error names. */
function inventory(items) {
  return items
    .map((item, index) => {
      const id = item.stepId === undefined ? '' : ` ${item.stepId}`
      const indent = (item.level ?? 0) === 1 ? '  ' : ''
      return `${index + 1}.${indent}${id} ${JSON.stringify(item.content)} [${item.status}]`
    })
    .join(', ')
}

/**
 * The list as host state for the request, in the reading order a sign-off uses.
 * @param items - the current list.
 * @returns the block, or an empty string when there is nothing to carry.
 */
function renderTaskState(items) {
  if (items === null || items.length === 0) return ''
  const lines = items.map((item, index) => {
    const id = item.stepId === undefined ? '' : ` ${item.stepId}`
    const indent = (item.level ?? 0) === 1 ? '   ' : ''
    return `${index + 1}.${indent}${id} ${JSON.stringify(item.content)} [${item.status}]`
  })
  return (
    "Host task state. This list is the host's, not a message you sent; sign a step off with complete_step once it is finished.\n" +
    lines.join('\n')
  )
}

/** Whether the visible history already carries a host task-state block. */
function alreadyStated(agent) {
  try {
    const messages = agent.session.deriveMessages()
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const parts = Array.isArray(messages[i]?.content) ? messages[i].content : []
      if (parts.some((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.startsWith('Host task state.'))) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

/** The only item a sign-off may cite right now: the current one, if any. */
function currentItem(items) {
  return items.find((item) => item.status === 'in_progress')
}

/**
 * Resolve the cited step against the list, most stable identity first: a
 * `step_id` survives a replan, a 1-based position survives a retitle, a title
 * survives neither.
 * @param items - the current list.
 * @param stepId - the cited stable id, when one was given.
 * @param step - the cited name, when one was given.
 * @param index - the cited 1-based position, when one was given.
 * @returns the 0-based index, or -1.
 */
function locate(items, stepId, step, index) {
  const wantedId = normalize(stepId)
  if (wantedId !== '') {
    const hit = items.findIndex((item) => normalize(item.stepId) === wantedId)
    if (hit !== -1) return hit
  }
  const wanted = normalize(step)
  if (wanted !== '') {
    const exact = items.findIndex((item) => normalize(item.content) === wanted)
    if (exact !== -1) return exact
    const folded = wanted.toLowerCase()
    const foldedHit = items.findIndex((item) => normalize(item.content).toLowerCase() === folded)
    if (foldedHit !== -1) return foldedHit
  }
  if (Number.isInteger(index) && index > 0) return index <= items.length ? index - 1 : -1
  return -1
}

/**
 * Split a list into serial units: a level-0 phase owns the level-1 items
 * directly after it; every other item is its own single-step unit.
 * @param items - the current list.
 * @returns the segments, each `{ head, end }` (end exclusive).
 */
function segmentsOf(items) {
  const segments = []
  for (let i = 0; i < items.length; ) {
    let end = i + 1
    if ((items[i].level ?? 0) === 0) {
      while (end < items.length && (items[end].level ?? 0) === 1) end += 1
    }
    segments.push({ head: i, end })
    i = end
  }
  return segments
}

/**
 * The first unfinished sub-step of the phase at `index`, when that item is a
 * phase with sub-steps.
 * @param items - the current list.
 * @param index - 0-based index of a candidate phase.
 * @returns the 0-based index of the first unfinished sub-step, or -1.
 */
function firstUnfinishedSubStep(items, index) {
  if ((items[index]?.level ?? 0) !== 0) return -1
  for (let i = index + 1; i < items.length && (items[i].level ?? 0) === 1; i += 1) {
    if (items[i].status !== 'completed') return i
  }
  return -1
}

/**
 * Sign one item off and promote the next serial unit, mirroring Reasonix's
 * `AdvanceSerialTodo`: a sub-step promotes its next pending sibling, or hands
 * the phase back for sign-off once every sibling is done; a phase (or a plain
 * step) promotes the next unit — a phase's first pending sub-step, or the
 * phase itself. A phase with unfinished sub-steps does not complete.
 * @param items - the current list.
 * @param at - 0-based index of the item being signed off.
 * @returns the advanced list, as a new array.
 */
function advance(items, at) {
  const next = items.map((item) => ({ ...item }))
  if (next[at] === undefined || next[at].status !== 'in_progress') return next
  if (firstUnfinishedSubStep(next, at) >= 0) return next
  next[at].status = 'completed'
  if ((next[at].level ?? 0) === 1) {
    for (let i = at + 1; i < next.length && (next[i].level ?? 0) === 1; i += 1) {
      if (next[i].status === 'pending') {
        next[i].status = 'in_progress'
        return next
      }
    }
    let head = at - 1
    while (head >= 0 && (next[head].level ?? 0) === 1) head -= 1
    if (head >= 0) {
      if (next[head].status !== 'completed') next[head].status = 'in_progress'
      return next
    }
  }
  if (next.some((item) => item.status === 'in_progress')) return next
  for (let i = 0; i < next.length; i += 1) {
    if (next[i].status !== 'pending') continue
    const sub = firstUnfinishedSubStep(next, i)
    if (sub >= 0) {
      if (next[sub].status === 'pending') next[sub].status = 'in_progress'
      return next
    }
    next[i].status = 'in_progress'
    return next
  }
  return next
}

/**
 * Find the same item in a rewrite: by step_id when both carry one, else by
 * normalized content.
 * @param item - the item to look for.
 * @param list - the submitted list.
 * @returns the match and its index, or null.
 */
function findSame(item, list) {
  if (item.stepId !== undefined) {
    const byId = list.findIndex((candidate) => candidate.stepId === item.stepId)
    if (byId !== -1) return { item: list[byId], index: byId }
  }
  const key = normalize(item.content)
  const byName = list.findIndex((candidate) => normalize(candidate.content) === key)
  return byName === -1 ? null : { item: list[byName], index: byName }
}

/**
 * The three continuity rules a rewrite must respect, mirroring Reasonix's
 * `verifyStepIDsPreserved`, `verifyTodoCurrentContinuity` and
 * `verifyCompletedTodoPositions`: an id is never dropped, the current item is
 * never removed or moved back to pending, and completed history keeps its
 * position.
 * @param previous - the list the host holds, or null before the first write.
 * @param next - the submitted list.
 * @returns an error message, or null when the rewrite is coherent.
 */
function continuityProblem(previous, next) {
  if (previous === null || previous.length === 0) return null
  // A finished plan is history, not state: once every item is completed there is
  // no completion left to keep attached, so a new plan may replace it outright.
  if (previous.every((item) => item.status === 'completed')) return null
  for (const item of previous) {
    if (item.stepId === undefined) continue
    if (next.some((candidate) => candidate.stepId === item.stepId)) continue
    return (
      `step_id ${JSON.stringify(item.stepId)} (${JSON.stringify(item.content)}) was dropped; ` +
      'copy every existing step_id verbatim so a completion stays attached to its step'
    )
  }
  const current = previous.find((item) => item.status === 'in_progress')
  if (current !== undefined) {
    const match = findSame(current, next)
    if (match === null) {
      return (
        `the current item ${JSON.stringify(current.content)} cannot be removed or replaced while it is in progress; ` +
        'sign it off with complete_step first'
      )
    }
    if (match.item.status === 'pending') {
      return (
        `the current item ${JSON.stringify(current.content)} cannot move back to pending; ` +
        'keep it in_progress or sign it off with complete_step'
      )
    }
  }
  for (let i = 0; i < previous.length; i += 1) {
    if (previous[i].status !== 'completed') continue
    const match = findSame(previous[i], next)
    if (match === null || match.index !== i) {
      return (
        `completed item ${JSON.stringify(previous[i].content)} must keep its position; ` +
        'completed history cannot be removed, renamed or reordered while the plan is active'
      )
    }
  }
  return null
}

/**
 * Validate a submitted list against the serial state machine: at most one
 * current item, completed work as a prefix, pending work after the current
 * item, sub-steps in order, and a phase that is current only once its
 * sub-steps are all done. Mirrors Reasonix's `ValidateSerialTodos`.
 * @param items - the submitted list.
 * @returns an error message, or null when the list is valid.
 */
function validateSerial(items) {
  let currentSeen = false
  for (let i = 0; i < items.length; i += 1) {
    const status = items[i].status
    if (status !== 'completed' && status !== 'pending' && status !== 'in_progress') {
      return `todo ${i + 1} has invalid status ${JSON.stringify(status)}`
    }
    if (status === 'in_progress') {
      if (currentSeen) return `todo ${i + 1} ${JSON.stringify(items[i].content)} is a second in_progress item; a serial list allows exactly one current item`
      currentSeen = true
    }
  }
  if (items.length > 0 && (items[0].level ?? 0) === 1) {
    return `todo 1 ${JSON.stringify(items[0].content)} is a level-1 sub-step with no phase above it; add a level-0 phase header or use level 0`
  }
  let seenCurrent = false
  let seenPending = false
  for (const segment of segmentsOf(items)) {
    const head = items[segment.head]
    const headStatus = head.status
    let subCurrent = false
    let subPending = false
    let completedSubs = 0
    let unfinished = -1
    for (let i = segment.head + 1; i < segment.end; i += 1) {
      const sub = items[i]
      if (sub.status === 'completed') {
        if (subCurrent || subPending) return `todo ${i + 1} ${JSON.stringify(sub.content)} is completed after unfinished work; completed items must form a prefix`
        completedSubs += 1
      } else if (sub.status === 'in_progress') {
        if (subPending) return `todo ${i + 1} ${JSON.stringify(sub.content)} is in_progress after pending work; the current item must be the first unfinished one`
        subCurrent = true
        if (unfinished < 0) unfinished = i
      } else {
        subPending = true
        if (unfinished < 0) unfinished = i
      }
    }
    if (headStatus === 'completed') {
      if (unfinished >= 0) {
        return `phase ${segment.head + 1} ${JSON.stringify(head.content)} is completed but sub-step ${unfinished + 1} ${JSON.stringify(items[unfinished].content)} is unfinished`
      }
      if (seenCurrent || seenPending) return `phase ${segment.head + 1} ${JSON.stringify(head.content)} is completed after unfinished work; completed items must form a prefix`
    } else if (headStatus === 'in_progress') {
      if (unfinished >= 0) {
        return `phase ${segment.head + 1} ${JSON.stringify(head.content)} cannot be in_progress while sub-step ${unfinished + 1} ${JSON.stringify(items[unfinished].content)} is unfinished; keep the phase pending, finish its sub-steps, then mark it in_progress`
      }
      if (seenPending) return `phase ${segment.head + 1} ${JSON.stringify(head.content)} is in_progress after pending work; the current item must be the first unfinished one`
      seenCurrent = true
    } else if (subCurrent) {
      if (seenPending) return `phase ${segment.head + 1} ${JSON.stringify(head.content)} holds the current item after pending work`
      seenCurrent = true
    } else if (completedSubs > 0) {
      if (seenCurrent) return `phase ${segment.head + 1} ${JSON.stringify(head.content)} has completed sub-steps after unfinished work`
      seenPending = true
    } else {
      seenPending = true
    }
  }
  if (items.length > 0 && seenPending && !seenCurrent) return 'the list has pending work but no in_progress item'
  return null
}

/**
 * The seq of the step this call belongs to: the last `step/start` in the log.
 * @param events - the session log snapshot, when the host exposes one.
 * @returns the step's seq, or null when the step cannot be identified.
 */
function stepSeqOf(events) {
  if (events === undefined) return null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'step/start') return events[i].seq ?? -1
  }
  return null
}

/**
 * Mark the plan as touched at the current step: every write or sign-off resets
 * the staleness clock.
 * @param session - the owning session.
 * @param step - the step seq this happened in, or null when unknown.
 */
function stepIndex(events) {
  if (!Array.isArray(events)) return null
  let count = 0
  for (const event of events) if (event?.type === 'step/start') count += 1
  return count
}

function touchPlan(session, step) {
  if (step === null || step === undefined) return
  const clock = planClock.get(session)
  if (clock === undefined) planClock.set(session, { touch: step, remind: -Infinity })
  else clock.touch = Math.max(clock.touch, step)
}

/**
 * Whether a stale-plan reminder is due, and which one.
 * @param clock - the session's clock, or undefined before the first touch.
 * @param current - the seq of the step about to run.
 * @param options - threshold, open count, and whether the turn is waiting.
 * @returns the reminder text, or undefined when none is due.
 */
function staleReminder(clock, current, options) {
  if (!options.enabled || options.waiting || options.open === 0) return undefined
  if (clock === undefined || current === null) return undefined
  const threshold = options.threshold
  const sinceTouch = current - clock.touch
  if (sinceTouch < threshold) return undefined
  if (current - clock.remind < threshold) return undefined
  const noun = options.open === 1 ? 'item is' : 'items are'
  return (
    `Plan check: the task list has not changed for about ${threshold} steps and ${options.open} ${noun} still open. ` +
    'If a step is finished, call complete_step now; if the list is out of date, rewrite it with plan_write. ' +
    'If you are waiting on the user, call wait_for_user instead of ending the turn silently.'
  )
}

/**
 * The sentence an abandonment returns: what was dropped, and the reason kept in
 * the transcript.
 * @param items - the list being abandoned.
 * @param reason - why it is abandoned.
 * @returns the tool's message.
 */
function abandonMessage(items, reason) {
  const done = items.filter((item) => item.status === 'completed').length
  const carried = done === 0 ? 'nothing was completed' : `${done} of ${items.length} had been completed`
  const plural = items.length === 1 ? '' : 's'
  return (
    `Plan abandoned: ${JSON.stringify(reason)}. ${items.length} item${plural} dropped (${carried}). ` +
    'The list is now empty; write a new plan with plan_write when the next piece of work starts.'
  )
}

const DESCRIPTION =
  'Sign off ONE step of the current task list as done. The host marks that item completed and moves the next ' +
  'serial unit to in_progress — a sub-step promotes its next sibling, and a phase only becomes current after ' +
  'every sub-step is done. Cite the item by its step_id (preferred), by name, or by 1-based position. A plan ' +
  'write that marks a new item completed without a complete_step sign-off is refused.'

/**
 * Read one config switch. A `.volatile()` field resolves to a live cell
 * ({ get, [write] }) rather than a plain value, and reading it on use is what
 * makes a setting take effect without a remount; a plain value is accepted too.
 * @param cell - the config entry, possibly a cell.
 * @param fallback - the value used when nothing is configured.
 * @returns the current value.
 */
function readCell(cell, fallback) {
  if (cell === undefined || cell === null) return fallback
  if (typeof cell === 'object' && typeof cell.get === 'function') {
    try {
      return cell.get()
    } catch {
      return fallback
    }
  }
  return cell
}

export function apply(ctx, config = {}) {
  // Settings come from the plugin row; an unset key keeps the mechanism on.
  const guardEnabled = () => readCell(config.guardUnsignedCompletions, true) !== false
  const holdEnabled = () => readCell(config.holdOpenList, true) !== false
  const restoreEnabled = () => readCell(config.restorePanel, true) !== false
  const remindEnabled = () => readCell(config.remindStalePlan, true) !== false
  const staleSteps = () => {
    const value = Number(readCell(config.stalePlanSteps, 20))
    return Number.isFinite(value) ? Math.max(2, value) : 20
  }

  // The plan writer. The shipped `todo_write` stores a flat name list; a
  // two-level plan needs a phase header, ordered sub-steps and stable step ids,
  // so this tool owns the structured form and writes the same `todo/write`
  // snapshot the panel already reads.
  ctx.tools.register({
    name: 'plan_write',
    description:
      'Record and update a structured task list for the current work. Send the COMPLETE list every call — it replaces ' +
      'the previous one. The list is two-level: a `level` 0 item is a PHASE (a milestone) and the `level` 1 items ' +
      'after it are its concrete sub-steps. Keep exactly one item in_progress: a phase stays pending while its ' +
      'sub-steps run and becomes the current item only after all of them are done, so the phase signs off last. ' +
      'COPY `step_id` VERBATIM for every item that already has one: it is how a completion stays attached across ' +
      'retitles and reordering. Give a new item a fresh unique id (e.g. "plan_step_07"). Sign finished items off ' +
      'with complete_step; do not mark a new item completed here.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        todos: {
          type: 'array',
          description: 'The complete task list, in order. Replaces any previous list.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              content: { type: 'string', description: 'Imperative description of the task.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              level: { type: 'integer', description: '0 = phase/milestone, 1 = a sub-step of the phase above it.' },
              step_id: { type: 'string', description: 'Stable identity for this item, copied verbatim on every rewrite.' },
              activeForm: { type: 'string', description: 'Present-continuous form shown while the item is in progress.' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('plan_write requires an owning agent session')
      const raw = args?.todos
      if (!Array.isArray(raw)) throw new Error('`todos` must be the complete list')
      const items = []
      const seenContent = new Set()
      const seenId = new Set()
      for (let i = 0; i < raw.length; i += 1) {
        const entry = raw[i] ?? {}
        const content = String(entry.content ?? '').trim()
        if (content === '') throw new Error(`todo ${i + 1}: content is required`)
        const key = normalize(content)
        if (seenContent.has(key)) throw new Error(`todo ${i + 1} ${JSON.stringify(content)} repeats an earlier item`)
        seenContent.add(key)
        const status = entry.status ?? 'pending'
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
          throw new Error(`todo ${i + 1}: invalid status ${JSON.stringify(status)}`)
        }
        const level = Number(entry.level) === 1 ? 1 : 0
        const stepId = String(entry.step_id ?? '').trim()
        if (stepId !== '') {
          if (seenId.has(stepId)) throw new Error(`todo ${i + 1} reuses step_id ${JSON.stringify(stepId)}`)
          seenId.add(stepId)
        }
        const item = { content, status }
        if (level === 1) item.level = 1
        if (stepId !== '') item.stepId = stepId
        items.push(item)
      }
      const problem = validateSerial(items)
      if (problem !== null) throw new Error(problem)
      const continuity = continuityProblem(listOf(agent.session), items)
      if (continuity !== null) throw new Error(continuity)
      agent.session.append(TODO_WRITE, { todos: snapshotOf(items) })
      const done = items.filter((item) => item.status === 'completed').length
      const active = items.filter((item) => item.status === 'in_progress').length
      const pending = items.length - done - active
      return { message: `Plan updated: ${items.length} items — ${done} completed, ${active} in progress, ${pending} pending.` }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Update plan',
      kind: 'other',
      content: [{ type: 'text', text: Array.isArray(args?.todos) ? `${args.todos.length} items` : 'plan' }],
    }),
  })

  ctx.tools.register({
    name: 'complete_step',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        step_id: {
          type: 'string',
          description:
            'PREFERRED: the stable step_id of the task-list item this completes, e.g. "plan_step_02". Unlike a title or a number it survives retitles, insertions and reordering.',
        },
        step: {
          type: 'string',
          description: 'The task-list item this completes, by name. Use when the item has no step_id.',
        },
        index: {
          type: 'number',
          description: 'The 1-based task-list position, used when the item has neither a step_id nor a unique name.',
        },
        result: {
          type: 'string',
          description: 'What is now true or changed as a result of finishing this step.',
        },
      },
      required: ['result'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('complete_step requires an owning agent session')
      const items = listOf(agent.session)
      if (items === null || items.length === 0) {
        const unreadable = readProjected === null && sessionEvents(agent.session) === undefined
        throw new Error(
          'this session holds no task list yet; call plan_write with the plan, then sign each step off as you finish it' +
            (unreadable ? ' (this host exposes neither a projection nor a session log to the plugin)' : ''),
        )
      }
      const said = String(args?.result ?? '').trim()
      if (said === '') {
        throw new Error('`result` is required — state what is now true after finishing this step')
      }
      const cited = args?.step ?? args?.step_id ?? ''
      const at = locate(items, args?.step_id, args?.step, args?.index)
      if (at === -1) {
        throw new Error(
          `${cited === '' ? 'no step was cited and no in_progress item is current' : `step ${JSON.stringify(cited)} matches no task-list item`}; the list is: ${inventory(items)}`,
        )
      }
      if (firstUnfinishedSubStep(items, at) >= 0) {
        const sub = firstUnfinishedSubStep(items, at)
        throw new Error(
          `${JSON.stringify(items[at].content)} is a phase whose sub-steps are unfinished; complete sub-step ` +
            `${JSON.stringify(items[sub].content)} first, then sign the phase off`,
        )
      }
      const target = items[at]
      if (target.status === 'completed') {
        return { message: `Step ${JSON.stringify(target.content)} was already completed; the list is unchanged.` }
      }
      if (target.status !== 'in_progress') {
        const current = currentItem(items)
        throw new Error(
          `step ${JSON.stringify(target.content)} is ${target.status}; complete_step only signs the current in_progress item` +
            (current === undefined
              ? ' — mark the item you are working on with todo_write first'
              : ` — finish ${JSON.stringify(current.content)} first`),
        )
      }
      // One sign-off per step. The claim is taken before the append and before
      // any await, so a second call in the same parallel batch is refused
      // instead of signing a list the first call already moved.
      const stepSeq = stepSeqOf(sessionEvents(agent.session))
      if (stepSeq !== null) {
        if (claimedStep.get(agent.session) === stepSeq) {
          throw new Error(
            'only one complete_step per step: a second sign-off in the same batch signs against the list as it stood ' +
              'before the first one advanced it. Sign the next item in your next step.',
          )
        }
        claimedStep.set(agent.session, stepSeq)
      }
      const advanced = advance(items, at)
      // Persist the advance as the same snapshot the shipped tool writes, so
      // the task panel and every log reader see the step close here and now.
      agent.session.append(TODO_WRITE, { todos: snapshotOf(advanced) })
      touchPlan(agent.session, stepIndex(sessionEvents(agent.session)))
      const next = currentItem(advanced)
      const remaining = advanced.filter((item) => item.status !== 'completed').length
      const tail =
        next === undefined
          ? 'Every step in the task list is now complete. Do not open new work under this plan.'
          : `The host advanced the list; the next step is ${advanced.indexOf(next) + 1} ${JSON.stringify(next.content)}.`
      return {
        // The total is stated, not inferred: a two-level list can have a phase
        // current *before* its completed sub-steps, so "index - 1 + open" is not
        // the list length and a reader must not compute it.
        message: `Step ${JSON.stringify(target.content)} done: ${said} ${tail} (${remaining} open of ${advanced.length})`,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Complete step',
      kind: 'other',
      content: [
        {
          type: 'text',
          text:
            args && typeof args.step === 'string' && args.step !== ''
              ? `Signing off ${args.step}`
              : 'Signing off the current step',
        },
      ],
    }),
  })

  ctx.tools.register({
    name: 'wait_for_user',
    description:
      'Declare that the current task-list item cannot go on without the user: their decision, material only they have, ' +
      'or their view on what you just showed them. The turn may then end with that item still in progress and the host ' +
      'will not pull the turn back for it. Name what you need in one line; the substance belongs in your reply. ' +
      'Use ask_user_question instead when you can offer the choices yourself and want the answer in this turn.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        need: {
          type: 'string',
          description: 'One short line saying what you are waiting for, addressed to the user.',
        },
      },
      required: ['need'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('wait_for_user requires an owning agent session')
      const need = String(args?.need ?? '').trim()
      if (need === '') throw new Error('`need` is required — say in one line what you are waiting for')
      if (need.length < 2 || PLACEHOLDER_NEED.test(need)) {
        throw new Error(
          '`need` must name the actual thing you are waiting for — a bare test word or a placeholder leaves the user ' +
            'nothing to answer; write the decision, the material, or the confirmation you need',
        )
      }
      waitingSessions.add(agent.session)
      return {
        message:
          `Recorded: waiting on the user for ${JSON.stringify(need)}. The task list is kept as it stands, ` +
          'and the host will not pull this turn back for it.',
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Waiting on you',
      kind: 'other',
      content: [{ type: 'text', text: String(args?.need ?? 'Waiting for your input.') }],
    }),
  })

  ctx.tools.register({
    name: 'abandon_plan',
    description:
      'Abandon the current task list instead of completing it. Use it when the plan is wrong, superseded, or the ' +
      'work is dropped: the list is cleared, the panel disappears, and the reason stays in the transcript. This is ' +
      'the only write that bypasses the rewrite continuity rules, so the reason is required — signing steps off ' +
      'with complete_step remains the path for work that was actually finished.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: {
          type: 'string',
          description: 'One line saying why the plan is abandoned; the user reads it in the transcript.',
        },
      },
      required: ['reason'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('abandon_plan requires an owning agent session')
      const reason = String(args?.reason ?? '').trim()
      if (reason === '') throw new Error('`reason` is required — say in one line why the plan is abandoned')
      if (reason.length < 4) throw new Error('`reason` is too short to be useful; name what changed')
      const items = listOf(agent.session)
      if (items === null || items.length === 0) {
        throw new Error('there is no task list to abandon; write one with plan_write when work starts')
      }
      agent.session.append(TODO_WRITE, { todos: [] })
      // A dropped list cannot be waiting on the user, and the turn that ended a
      // plan should not be pulled back for items that no longer exist.
      waitingSessions.delete(agent.session)
      heldTurn.delete(agent.session)
      planClock.delete(agent.session)
      return { message: abandonMessage(items, reason) }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Abandon plan',
      kind: 'other',
      content: [{ type: 'text', text: String(args?.reason ?? 'Abandoning the task list.') }],
    }),
  })

  // The canonical list as a projection: the incremental read the host keeps for
  // every session, so a read no longer rescans the log. A host without the seam
  // falls back to the scan in `listOf`.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    try {
      const pending = projectionCtx.sessionProjections.register({
        key: 'plan-steps/todos',
        stateSchema: { parse: parseTodos },
        init: () => null,
        apply: (state, event) =>
          event?.type === TODO_WRITE && Array.isArray(event.data?.todos) ? event.data.todos.map(toItem) : state,
        stateVersion: 1,
      })
      Promise.resolve(pending)
        .then((handle) => {
          readProjected = (session) => handle.stateOf(session)
        })
        .catch(() => {})
    } catch {
      // Without a usable seam the log scan stays the reader.
    }
  })

  if (guardEnabled()) {
    ctx.tools.guard((exec) => {
      if ((exec.name !== 'todo_write' && exec.name !== 'plan_write') || exec.agent === undefined) return undefined
      const items = listOf(exec.agent.session)
      if (items === null || items.length === 0) return undefined
      const submitted = exec.arguments?.todos
      if (!Array.isArray(submitted)) return undefined
      // A rewrite that does not add a completion is a relabel or a replan, not a
      // claim about work: names are the only identity a shipped item has, so a
      // completed item renamed must not read as a fresh completion.
      const reason = unsignedCompletion(items, submitted)
      if (reason !== undefined) return { reason }
      // Only a write the guard lets through counts as touching the plan: a
      // refused one changed nothing, so it must not reset the staleness clock.
      touchPlan(exec.agent.session, stepIndex(sessionEvents(exec.agent.session)))
      return undefined
    })
  }

  // The turn is about to close with the list still open. Steering is the only
  // thing that reopens a step: the loop re-reads its inbox, finds this message,
  // and runs another step instead of committing the boundary. One hold per turn
  // bounds a model that will not update the list — it ends on the second stop.
  if (holdEnabled()) {
    ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
      if (agent === undefined || signal?.aborted === true) return
      if (waitingSessions.has(agent.session)) return
      const items = listOf(agent.session)
      if (items === null || items.length === 0) return
      const open = items.filter((item) => item.status !== 'completed')
      if (open.length === 0) return
      if (heldTurn.get(agent.session) === turn) return
      heldTurn.set(agent.session, turn)
      const current = open.find((item) => item.status === 'in_progress') ?? open[0]
      try {
        agent.steer(
          makeMessage(
            `Your task list still has ${open.length} open step(s); the current one is ${JSON.stringify(current.content)}. ` +
              'Keep working on it, and call complete_step the moment a step is finished. ' +
              'If you are waiting on the user, call wait_for_user with one line naming what you need — that is what lets ' +
              'the turn end with the item still open. Do not end a turn that still has work you can do.',
          ),
        )
      } catch {
        // A host that refuses steering simply lets the turn close.
      }
    })
  }

  // The list rides the request as host state once per visible window: a fold
  // takes the model's own todo_write out of view, and this puts the list back
  // where a sign-off can be judged against it. It is not re-sent while the
  // window already carries one.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || payload?.agent === undefined) return decision
    const session = payload.agent.session
    const items = listOf(session)
    if (items === null || items.length === 0) return decision
    if (!items.some((item) => item.status !== 'completed')) return decision
    // The shipped task projection resets at `turn/start`, so the first step of
    // a turn writes the open list back as its own snapshot: the panel is there
    // when the turn starts instead of after the model happens to re-send it.
    const restored = restoredTurns.get(session)
    if (restoreEnabled() && restored !== payload.turn) {
      restoredTurns.set(session, payload.turn)
      try {
        session.append(TODO_WRITE, { todos: snapshotOf(items) })
      } catch {
        // A read-only or closing session keeps its own behaviour.
      }
    }
    const extra = []
    if (!alreadyStated(payload.agent)) {
      const text = renderTaskState(items)
      if (text !== '') extra.push(makeMessage(text))
    }
    if (remindEnabled()) {
      const current = stepIndex(sessionEvents(session))
      // The clock starts when this plugin first sees the session, so a list that
      // was already open counts its staleness from now rather than from a write
      // it may never receive.
      if (current !== null && planClock.get(session) === undefined) {
        planClock.set(session, { touch: current, remind: -Infinity })
      }
      const text = staleReminder(planClock.get(session), current, {
        enabled: remindEnabled(),
        waiting: waitingSessions.has(session),
        open: items.filter((item) => item.status !== 'completed').length,
        threshold: staleSteps(),
      })
      if (text !== undefined) {
        extra.push(makeMessage(text))
        const clock = planClock.get(session)
        if (clock !== undefined) clock.remind = current
      }
    }
    if (extra.length === 0) return decision
    try {
      return { ...decision, messages: [...decision.messages, ...extra] }
    } catch {
      return decision
    }
  })

  // A declaration lasts one turn: the next turn's work has to earn its own.
  // The shipped task projection also resets here, so an open list is written
  // back as a snapshot of its own — otherwise the panel is blank until the
  // model happens to write a table it already owns.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/start') return
    waitingSessions.delete(session)
    if (restoreEnabled() !== true) return
    // Appending inside the turn/start dispatch does not land, so the snapshot is
    // written on the next macrotask, once the boundary has committed. The
    // pre-step restore stays as the fallback when this one does not run.
    const turn = event.data?.turn
    setTimeout(() => {
      const items = listOf(session)
      if (items === null || items.length === 0) return
      if (!items.some((item) => item.status !== 'completed')) return
      try {
        session.append(TODO_WRITE, { todos: snapshotOf(items) })
        restoredTurns.set(session, turn)
      } catch (error) {
        // The pre-step restore still runs for this turn, so the panel is not
        // lost; say it once, because this path is expected to work on this host
        // and a silent fallback would hide a host change.
        if (!restoreWarned.has(session)) {
          restoreWarned.add(session)
          ctx.logger?.warn?.('plan-steps: could not restore the task panel at turn start; falling back to the pre-step restore', error)
        }
      }
    }, 0)
  })
}

/** Pure helpers, exposed for the regression tests in test/. */
export const __testing = { normalize, locate, advance, replayCalls, renderTaskState, stepSeqOf, parseTodos, validateSerial, segmentsOf, firstUnfinishedSubStep, continuityProblem, snapshotOf, toItem, unsignedCompletion, staleReminder, touchPlan, planClock, readCell, abandonMessage, stepIndex }
