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
 * @module dsh-task-steps
 */

import { randomUUID } from 'node:crypto'

export const name = 'task-steps'
export const inject = ['tools']

/** The shipped task list's snapshot event: one whole-list write per update. */
const TODO_WRITE = 'todo/write'

/**
 * Deployment escape hatches, read once when the plugin activates. `0` turns a
 * mechanism off; anything else (including unset) leaves it on.
 */
const guardEnabled = process.env.PLAN_STEPS_GUARD !== '0'
const holdEnabled = process.env.PLAN_STEPS_HOLD !== '0'
const restoreEnabled = process.env.PLAN_STEPS_RESTORE !== '0'

/** Turns already held once, so a model that will not update its list still ends. */
const heldTurn = new WeakMap()

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

/** One stored item, reduced to the two fields the shipped schema declares. */
function toItem(todo) {
  return { content: String(todo?.content ?? ''), status: todo?.status ?? 'pending' }
}

/**
 * Validate one stored projection value. The unit starts as `null`, so the
 * schema has to accept that state as well as a list.
 * @param value - a stored snapshot.
 * @returns the normalized list, or null before the first write.
 */
function parseTodos(value) {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) throw new Error('task-steps: a stored task list must be an array or null')
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
    const at = locate(list, args?.step ?? '', args?.index)
    if (at !== -1 && list[at].status === 'in_progress') list = advance(list, at)
  }
  return list
}

/** The model-facing inventory a citation error names. */
function inventory(items) {
  return items.map((item, index) => `${index + 1}. ${JSON.stringify(item.content)} [${item.status}]`).join(', ')
}

/**
 * The list as host state for the request, in the reading order a sign-off uses.
 * @param items - the current list.
 * @returns the block, or an empty string when there is nothing to carry.
 */
function renderTaskState(items) {
  if (items === null || items.length === 0) return ''
  const lines = items.map((item, index) => `${index + 1}. ${JSON.stringify(item.content)} [${item.status}]`)
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
 * Resolve the cited step against the list, preferring an exact name, then a
 * case-insensitive name, then a 1-based position.
 * @param items - the current list.
 * @param step - the cited name, when one was given.
 * @param index - the cited 1-based position, when one was given.
 * @returns the 0-based index, or -1.
 */
function locate(items, step, index) {
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
 * Sign one item off and promote the next pending one, so the list keeps exactly
 * one current item while work remains.
 * @param items - the current list.
 * @param at - 0-based index of the item being signed off.
 * @returns the advanced list, as a new array.
 */
function advance(items, at) {
  const next = items.map((item) => ({ ...item }))
  next[at].status = 'completed'
  if (next.every((item) => item.status !== 'in_progress')) {
    const pending = next.findIndex((item) => item.status !== 'completed')
    if (pending !== -1) next[pending].status = 'in_progress'
  }
  return next
}

const DESCRIPTION =
  'Sign off ONE step of the current task list as done. The host marks that item completed and moves the ' +
  'next pending item to in_progress, so you never re-send the list with todo_write to record a completion. ' +
  'Call it as you finish each step and say what is now true. Cite the step by name, or leave both ' +
  'identifiers out to sign the current in_progress item. A todo_write that marks a new item completed ' +
  'without a complete_step sign-off is refused.'

export function apply(ctx) {
  ctx.tools.register({
    name: 'complete_step',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        step: {
          type: 'string',
          description: 'The task-list item this completes, by name. Omit to sign the current in_progress item.',
        },
        index: {
          type: 'number',
          description: 'The 1-based task-list position, used when the name does not resolve uniquely.',
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
          'this session holds no task list yet; call todo_write with the plan, then sign each step off as you finish it' +
            (unreadable ? ' (this host exposes neither a projection nor a session log to the plugin)' : ''),
        )
      }
      const said = String(args?.result ?? '').trim()
      if (said === '') {
        throw new Error('`result` is required — state what is now true after finishing this step')
      }
      const cited = args?.step ?? ''
      const at = locate(items, cited, args?.index)
      if (at === -1) {
        throw new Error(
          `${cited === '' ? 'no step was cited and no in_progress item is current' : `step ${JSON.stringify(cited)} matches no task-list item`}; the list is: ${inventory(items)}`,
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
      agent.session.append(TODO_WRITE, { todos: advanced })
      const next = currentItem(advanced)
      const remaining = advanced.filter((item) => item.status !== 'completed').length
      const tail =
        next === undefined
          ? 'Every step in the task list is now complete. Do not open new work under this plan.'
          : `The host advanced the list; the next step is ${advanced.indexOf(next) + 1} ${JSON.stringify(next.content)}.`
      return {
        message: `Step ${JSON.stringify(target.content)} done: ${said} ${tail} (${remaining} open)`,
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

  // The canonical list as a projection: the incremental read the host keeps for
  // every session, so a read no longer rescans the log. A host without the seam
  // falls back to the scan in `listOf`.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    try {
      const pending = projectionCtx.sessionProjections.register({
        key: 'task-steps/todos',
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

  if (guardEnabled) {
    ctx.tools.guard((exec) => {
      if (exec.name !== 'todo_write' || exec.agent === undefined) return undefined
      const items = listOf(exec.agent.session)
      if (items === null || items.length === 0) return undefined
      const submitted = exec.arguments?.todos
      if (!Array.isArray(submitted)) return undefined
      // A rewrite that does not add a completion is a relabel or a replan, not a
      // claim about work: names are the only identity a shipped item has, so a
      // completed item renamed must not read as a fresh completion.
      const done = items.filter((item) => item.status === 'completed').length
      const nextDone = submitted.filter((item) => item?.status === 'completed').length
      if (nextDone <= done) return undefined
      const already = new Set(
        items.filter((item) => item.status === 'completed').map((item) => normalize(item.content)),
      )
      for (const item of submitted) {
        if (item?.status !== 'completed') continue
        const key = normalize(item.content)
        if (already.has(key)) continue
        return {
          reason:
            `blocked: todo ${JSON.stringify(item.content)} is newly completed with no complete_step sign-off. ` +
            'Call complete_step for it first — the host marks it completed and advances the list for you — ' +
            'or send todo_write again leaving that item in_progress.',
        }
      }
      return undefined
    })
  }

  // The turn is about to close with the list still open. Steering is the only
  // thing that reopens a step: the loop re-reads its inbox, finds this message,
  // and runs another step instead of committing the boundary. One hold per turn
  // bounds a model that will not update the list — it ends on the second stop.
  if (holdEnabled) {
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
    if (restoreEnabled && restored !== payload.turn) {
      restoredTurns.set(session, payload.turn)
      try {
        session.append(TODO_WRITE, { todos: items })
      } catch {
        // A read-only or closing session keeps its own behaviour.
      }
    }
    if (alreadyStated(payload.agent)) return decision
    const text = renderTaskState(items)
    if (text === '') return decision
    try {
      return { ...decision, messages: [...decision.messages, makeMessage(text)] }
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
    if (restoreEnabled !== true) return
    // Appending inside the turn/start dispatch does not land, so the snapshot is
    // written on the next macrotask, once the boundary has committed. The
    // pre-step restore stays as the fallback when this one does not run.
    const turn = event.data?.turn
    setTimeout(() => {
      const items = listOf(session)
      if (items === null || items.length === 0) return
      if (!items.some((item) => item.status !== 'completed')) return
      try {
        session.append(TODO_WRITE, { todos: items })
        restoredTurns.set(session, turn)
      } catch (error) {
        // The pre-step restore still runs for this turn, so the panel is not
        // lost; say it once, because this path is expected to work on this host
        // and a silent fallback would hide a host change.
        if (!restoreWarned.has(session)) {
          restoreWarned.add(session)
          ctx.logger?.warn?.('task-steps: could not restore the task panel at turn start; falling back to the pre-step restore', error)
        }
      }
    }, 0)
  })
}

/** Pure helpers, exposed for the regression tests in test/. */
export const __testing = { normalize, locate, advance, replayCalls, renderTaskState, stepSeqOf, parseTodos }
