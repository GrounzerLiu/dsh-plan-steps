import assert from 'node:assert/strict'
import test from 'node:test'

import { __testing } from '../index.js'

const { normalize, locate, advance, replayCalls, renderTaskState, stepSeqOf, parseTodos, validateSerial } = __testing

const list = (...items) => items.map(([content, status, extra]) => ({ content, status, ...(extra ?? {}) }))
const phase = (content, status) => ({ content, status, stepNum: 0 })
const sub = (content, status, id) => ({ content, status, level: 1, ...(id === undefined ? {} : { stepId: id }) })

test('normalize collapses whitespace so a retitled step still matches', () => {
  assert.equal(normalize('  run   focused\ttests '), 'run focused tests')
  assert.equal(normalize(undefined), '')
})

test('locate prefers step_id, then the name, then the position', () => {
  const items = [sub('alpha', 'in_progress', 'plan_step_01'), sub('beta', 'pending', 'plan_step_02')]
  assert.equal(locate(items, 'plan_step_02', 'alpha', 1), 1, 'the id wins over name and position')
  assert.equal(locate(items, '', 'beta', 1), 1, 'the name wins over position')
  assert.equal(locate(items, '', 'gamma', 2), 1, 'an unknown name falls back to position')
  assert.equal(locate(items, 'nope', 'gamma', 9), -1)
})

test('advance keeps a flat list serial', () => {
  const items = [phase('a', 'in_progress'), phase('b', 'pending')]
  assert.deepEqual(
    advance(items, 0).map((item) => item.status),
    ['completed', 'in_progress'],
  )
  assert.equal(items[0].status, 'in_progress', 'the input list must not be mutated')
})

test('advance moves to the next sub-step before touching the phase', () => {
  const items = [phase('phase', 'pending'), sub('s1', 'in_progress', 'p1'), sub('s2', 'pending', 'p2')]
  const next = advance(items, 1)
  assert.deepEqual(next.map((item) => item.status), ['pending', 'completed', 'in_progress'])
})

test('advance hands the phase back for sign-off after its last sub-step', () => {
  const items = [phase('phase', 'pending'), sub('s1', 'completed', 'p1'), sub('s2', 'in_progress', 'p2')]
  const next = advance(items, 2)
  assert.deepEqual(next.map((item) => item.status), ['in_progress', 'completed', 'completed'])
})

test('advance refuses to complete a phase with unfinished sub-steps', () => {
  const items = [phase('phase', 'in_progress'), sub('s1', 'pending', 'p1')]
  const next = advance(items, 0)
  assert.deepEqual(next.map((item) => item.status), ['in_progress', 'pending'])
})

test('advance promotes the next phase first sub-step after a phase is signed off', () => {
  const items = [phase('p1', 'in_progress'), phase('p2', 'pending'), sub('s1', 'pending', 'p2a')]
  const next = advance(items, 0)
  assert.deepEqual(next.map((item) => item.status), ['completed', 'pending', 'in_progress'])
})

test('validateSerial accepts a well-formed two-level plan', () => {
  const items = [phase('p1', 'completed'), phase('p2', 'pending'), sub('s1', 'in_progress', 'p2a'), sub('s2', 'pending', 'p2b')]
  assert.equal(validateSerial(items), null)
})

test('validateSerial rejects a second in_progress item', () => {
  const items = [phase('a', 'in_progress'), phase('b', 'in_progress')]
  assert.match(validateSerial(items), /second in_progress/)
})

test('validateSerial rejects a phase made current while its sub-steps are open', () => {
  const items = [phase('p', 'in_progress'), sub('s1', 'pending', 'p1')]
  assert.match(validateSerial(items), /cannot be in_progress while sub-step/)
})

test('validateSerial rejects pending work with no current item', () => {
  const items = [phase('a', 'completed'), phase('b', 'pending')]
  assert.match(validateSerial(items), /no in_progress/)
})

test('renderTaskState carries every item with its status', () => {
  const text = renderTaskState(list(['a', 'completed'], ['b', 'in_progress']))
  assert.match(text, /^Host task state\./)
  assert.match(text, /1\. "a" \[completed\]/)
  assert.match(text, /2\. "b" \[in_progress\]/)
  assert.equal(renderTaskState(null), '')
  assert.equal(renderTaskState([]), '')
})

test('stepSeqOf finds the step this call belongs to', () => {
  assert.equal(stepSeqOf(undefined), null)
  assert.equal(stepSeqOf([{ type: 'turn/start', seq: 1 }]), null)
  assert.equal(stepSeqOf([{ type: 'step/start', seq: 4 }, { type: 'tool/call', seq: 5 }]), 4)
  assert.equal(stepSeqOf([{ type: 'step/start', seq: 4 }, { type: 'step/start', seq: 9 }]), 9)
})

test('parseTodos accepts the initial null and rejects a non-list', () => {
  assert.equal(parseTodos(null), null)
  assert.equal(parseTodos(undefined), null)
  assert.deepEqual(parseTodos([{ content: 'a', status: 'in_progress', level: 1, step_id: 'p1' }]), [
    { content: 'a', status: 'in_progress', level: 1, stepId: 'p1' },
  ])
  assert.throws(() => parseTodos({ todos: [] }), /array or null/)
})

test('replayCalls ignores an unsettled or failed call and applies a settled one', () => {
  const write = {
    type: 'tool/call',
    data: {
      callId: 'w1',
      name: 'todo_write',
      arguments:
        '{"todos":[{"content":"a","status":"pending","level":0},{"content":"b","status":"in_progress","level":1}]}',
    },
  }
  const wrote = { type: 'tool/result', data: { message: { toolCallId: 'w1', isError: false } } }
  const failed = {
    type: 'tool/call',
    data: { callId: 'c0', name: 'complete_step', arguments: '{"step":"a","result":"x"}' },
  }
  const failedResult = { type: 'tool/result', data: { message: { toolCallId: 'c0', isError: true } } }
  const signed = {
    type: 'tool/call',
    data: { callId: 'c1', name: 'complete_step', arguments: '{"step":"b","result":"done"}' },
  }
  const signedResult = { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } }
  assert.deepEqual(replayCalls([write, wrote, failed, failedResult]), [
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'in_progress', level: 1 },
  ])
  assert.deepEqual(replayCalls([write, wrote, signed, signedResult]), [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'completed', level: 1 },
  ])
  assert.equal(replayCalls([]), null)
})

test('continuity rejects dropping a step_id', () => {
  const { continuityProblem } = __testing
  const previous = [phase('p', 'pending'), sub('s1', 'in_progress', 'id1')]
  const next = [phase('p', 'pending'), sub('s1 renamed', 'in_progress', 'id2')]
  assert.match(continuityProblem(previous, next), /step_id "id1" .* was dropped/)
})

test('continuity rejects removing or replacing the current item', () => {
  const { continuityProblem } = __testing
  const named = [phase('p', 'pending'), sub('s1', 'in_progress')]
  assert.match(continuityProblem(named, [phase('p', 'in_progress'), sub('s2', 'pending')]), /cannot be removed or replaced/)
  const identified = [phase('p', 'pending'), sub('s1', 'in_progress', 'id1')]
  assert.match(
    continuityProblem(identified, [phase('p', 'pending'), sub('s1', 'pending', 'id1'), sub('s2', 'in_progress', 'id2')]),
    /cannot move back to pending/,
  )
})

test('continuity keeps completed history in place', () => {
  const { continuityProblem } = __testing
  const previous = [phase('a', 'completed'), phase('b', 'in_progress'), phase('c', 'pending')]
  assert.equal(continuityProblem(previous, [phase('a', 'completed'), phase('b', 'in_progress'), phase('c', 'pending')]), null)
  assert.match(
    continuityProblem(previous, [phase('b', 'in_progress'), phase('a', 'completed'), phase('c', 'pending')]),
    /must keep its position/,
  )
})

test('continuity allows a first write and an additive replan', () => {
  const { continuityProblem } = __testing
  assert.equal(continuityProblem(null, [phase('a', 'in_progress')]), null)
  const previous = [phase('a', 'in_progress'), phase('b', 'pending')]
  assert.equal(continuityProblem(previous, [phase('a', 'in_progress'), phase('new', 'pending'), phase('b', 'pending')]), null)
})

test('a snapshot keeps the sub-step marker through a round trip', () => {
  const { toItem, snapshotOf } = __testing
  const parsed = [phase('p', 'pending'), sub('s1', 'pending', 'id1')]
  const payload = snapshotOf(parsed)
  assert.ok(payload[1].content.startsWith('​'), 'the marker rides in the content')
  assert.equal(payload[1].level, 1)
  const back = toItem(payload[1])
  assert.equal(back.level, 1)
  assert.equal(back.content, 's1')
  assert.equal(back.stepId, 'id1')
})

test('continuity lets a finished plan be replaced', () => {
  const { continuityProblem } = __testing
  const previous = [phase('调研', 'completed'), sub('写文档', 'completed', 'old_1')]
  const next = [phase('新的阶段', 'in_progress')]
  assert.equal(continuityProblem(previous, next), null)
})

test('continuity still guards a plan with anything open', () => {
  const { continuityProblem } = __testing
  const previous = [phase('调研', 'completed'), sub('写文档', 'in_progress', 'old_1')]
  const next = [phase('新的阶段', 'in_progress')]
  assert.match(continuityProblem(previous, next), /step_id "old_1"/)
})

test('the guard names the step it wants signed off', () => {
  const { unsignedCompletion } = __testing
  const named = [phase('phase', 'in_progress'), sub('detail', 'pending')]
  const byName = unsignedCompletion(named, [phase('phase', 'completed'), sub('detail', 'pending')])
  assert.match(byName, /(item 1 of 2, step: "phase")/)

  const identified = [phase('phase', 'in_progress'), sub('detail', 'pending', 'plan_step_07')]
  const byId = unsignedCompletion(identified, [phase('phase', 'completed'), sub('detail', 'pending', 'plan_step_07')])
  assert.match(byId, /(item 1 of 2)/)

  const closingSub = unsignedCompletion(identified, [phase('phase', 'in_progress'), sub('detail', 'completed', 'plan_step_07')])
  assert.match(closingSub, /(step_id "plan_step_07", item 2 of 2)/)

  assert.equal(unsignedCompletion(named, [phase('phase', 'in_progress'), sub('detail', 'pending')]), undefined)
})

test('a stale plan is reminded only after the threshold and the cooldown', () => {
  const { staleReminder } = __testing
  const clock = { touch: 10, remind: -Infinity }
  const base = { enabled: true, waiting: false, open: 3, threshold: 20 }
  assert.equal(staleReminder(clock, 25, base), undefined, '15 steps is not stale yet')
  const due = staleReminder(clock, 30, base)
  assert.match(due, /not changed for about 20 steps and 3 items are still open/)
  assert.match(due, /complete_step/)
  assert.equal(staleReminder(clock, 35, { ...base, waiting: true }), undefined, 'a declared wait silences it')
  assert.equal(staleReminder(clock, 35, { ...base, open: 0 }), undefined, 'a closed list needs no reminder')
  assert.equal(staleReminder(clock, 35, { ...base, enabled: false }), undefined, 'the switch turns it off')
  const cooled = { touch: 10, remind: 30 }
  assert.equal(staleReminder(cooled, 35, base), undefined, 'cooldown holds for another threshold')
  assert.match(staleReminder(cooled, 50, base), /still open/)
})

test('one open item reads as singular', () => {
  const { staleReminder } = __testing
  const text = staleReminder({ touch: 0, remind: -Infinity }, 20, { enabled: true, waiting: false, open: 1, threshold: 20 })
  assert.match(text, /1 item is still open/)
})

test('a volatile cell is read at use time, a plain value as-is', () => {
  const { readCell } = __testing
  let value = true
  const cell = { get: () => value }
  assert.equal(readCell(cell, false), true)
  value = false
  assert.equal(readCell(cell, true), false, 'a later write is seen without remounting')
  assert.equal(readCell(undefined, true), true, 'nothing configured keeps the fallback')
  assert.equal(readCell(true, false), true, 'a plain value passes through')
  assert.equal(readCell({ get() { throw new Error('gone') } }, true), true, 'a broken cell falls back')
})

test('an abandonment keeps the reason and the tally', () => {
  const { abandonMessage } = __testing
  const items = [phase('a', 'completed'), sub('b', 'in_progress'), sub('c', 'pending')]
  const message = abandonMessage(items, '方案 A 不可行')
  assert.match(message, /Plan abandoned: "方案 A 不可行"/)
  assert.match(message, /3 items dropped \(1 of 3 had been completed\)/)
  assert.match(message, /write a new plan with plan_write/)
  assert.match(abandonMessage([phase('a', 'pending')], 'wrong'), /1 item dropped \(nothing was completed\)/)
})

test('stepIndex counts steps, not events', () => {
  const { stepIndex } = __testing
  const events = [
    { type: 'session' },
    { type: 'step/start' },
    { type: 'tool/call' },
    { type: 'tool/result' },
    { type: 'step/start' },
    { type: 'turn/end' },
  ]
  assert.equal(stepIndex(events), 2)
  assert.equal(stepIndex(undefined), null)
})

test('touching the plan resets the staleness clock', () => {
  const { touchPlan, planClock, staleReminder } = __testing
  const session = {}
  touchPlan(session, 3)
  const clock = planClock.get(session)
  assert.equal(clock.touch, 3)
  assert.equal(staleReminder(clock, 22, { enabled: true, waiting: false, open: 2, threshold: 20 }), undefined)
  touchPlan(session, 21)
  assert.equal(planClock.get(session).touch, 21, 'a later write moves the clock forward')
  assert.equal(planClock.get(session).touch, 21, 'and never backwards')
  touchPlan(session, 4)
  assert.equal(planClock.get(session).touch, 21)
})

test('a sign-off refuses the five cases that are not one', () => {
  const { signOffStep } = __testing
  const list = [phase('阶段', 'pending'), sub('子一', 'in_progress', 's1'), sub('子二', 'pending', 's2')]

  assert.throws(() => signOffStep(null, { result: 'x' }), /holds no task list yet/)
  assert.throws(() => signOffStep([], { result: 'x' }, { unreadable: true }), /neither a projection nor a session log/)
  assert.throws(() => signOffStep(list, { step_id: 's1' }), /`result` is required/)
  assert.throws(() => signOffStep(list, { step: '不存在', result: 'x' }), /matches no task-list item/)
  assert.throws(() => signOffStep(list, { step: '阶段', result: 'x' }), /phase whose sub-steps are unfinished/)
  assert.throws(() => signOffStep(list, { step_id: 's2', result: 'x' }), /only signs the current in_progress item/)
})

test('a sign-off resolves the cited item and reports an already-completed one', () => {
  const { signOffStep } = __testing
  const list = [phase('阶段', 'pending'), sub('子一', 'in_progress', 's1')]
  const ok = signOffStep(list, { step_id: 's1', result: '做完了' })
  assert.equal(ok.at, 1)
  assert.equal(ok.said, '做完了')
  assert.equal(ok.item.content, '子一')

  const done = [phase('阶段', 'completed')]
  const already = signOffStep(done, { step: '阶段', result: 'x' })
  assert.equal(already.already, true)
  assert.equal(already.item.content, '阶段')
})

test('a step signs off once', () => {
  const { checkClaim } = __testing
  checkClaim(undefined, 7)
  checkClaim(4, 7)
  checkClaim(7, null)
  assert.throws(() => checkClaim(7, 7), /only one complete_step per step/)
})

test('a stale plan is due once per threshold, and a waiting turn is never due', () => {
  const { staleDue } = __testing
  const clock = { touch: 10, remind: -Infinity }
  const base = { enabled: true, waiting: false, open: 2, threshold: 20 }
  assert.equal(staleDue(clock, 29, base), false, 'below the threshold')
  assert.equal(staleDue(clock, 30, base), true, 'at the threshold')
  assert.equal(staleDue({ touch: 10, remind: 30 }, 45, base), false, 'inside the cooldown')
  assert.equal(staleDue(clock, 51, base), true, 'the cooldown has passed')
  assert.equal(staleDue(clock, 99, { ...base, waiting: true }), false, 'a waiting turn is exempt')
  assert.equal(staleDue(clock, 99, { ...base, open: 0 }), false, 'nothing open to answer')
  assert.equal(staleDue(clock, 99, { ...base, enabled: false }), false, 'switched off')
  assert.equal(staleDue(undefined, 99, base), false, 'no clock yet')
  assert.equal(staleDue(clock, null, base), false, 'no step index')
})

test('the lock notice names the current item and every way out', () => {
  const { lockNotice, LOCK_TOOLS } = __testing
  const text = lockNotice(3, '写测试', 20)
  assert.match(text, /^Plan lock: /)
  assert.match(text, /20 steps/)
  assert.match(text, /3 items are/)
  assert.match(text, /"写测试"/)
  for (const tool of ['complete_step', 'wait_for_user', 'plan_write', 'abandon_plan', 'unlock_plan']) {
    assert.match(text, new RegExp(tool), `${tool} must be offered as an exit`)
    assert.equal(LOCK_TOOLS.has(tool), true)
  }
  assert.equal(lockNotice(1, undefined, 8).includes('The current one is'), false, 'no current item, no phrase')
})

test('an identical rewrite is not an account, any real change is', () => {
  const { planChanged } = __testing
  const before = [phase('阶段', 'pending'), sub('子一', 'in_progress', 's1')]
  assert.equal(planChanged(before, structuredClone(before)), false, 'same content, same order')
  assert.equal(planChanged(before, [phase('阶段', 'pending'), sub('子一', 'completed', 's1')]), true, 'status moved')
  assert.equal(planChanged(before, [phase('阶段二', 'pending'), sub('子一', 'in_progress', 's1')]), true, 'text moved')
  assert.equal(planChanged(before, [phase('阶段', 'pending')]), true, 'length moved')
  assert.equal(planChanged(null, before), true, 'first write')
})

test('a lock is released by answering it, and only then', () => {
  const { lockedSessions, releaseLock } = __testing
  const session = {}
  lockedSessions.add(session)
  assert.equal(lockedSessions.has(session), true)
  releaseLock(session)
  assert.equal(lockedSessions.has(session), false)
})

test('the lock refuses everything but the plan tools, unless the switch is off', () => {
  const { blocksTool, LOCK_TOOLS } = __testing
  assert.equal(blocksTool('bash', true, true), true, 'a locked session refuses an ordinary tool')
  for (const name of LOCK_TOOLS) assert.equal(blocksTool(name, true, true), false, `${name} stays callable`)
  assert.equal(blocksTool('bash', false, true), false, 'an unlocked session runs everything')
  assert.equal(blocksTool('bash', true, false), false, 'turning the switch off must unfreeze')
})

test('a failure inside an allowed tool explains the lock, and only while locked', async () => {
  const { withLockNote, lockedSessions } = __testing
  const session = {}
  const failing = withLockNote(async () => {
    throw new Error('step "x" matches no task-list item')
  })
  await assert.rejects(() => failing({}, { agent: { session } }), /matches no task-list item$/, 'unlocked: unchanged')
  lockedSessions.add(session)
  await assert.rejects(() => failing({}, { agent: { session } }), /the plan lock is still in place/)
  const ok = withLockNote(async () => ({ message: 'fine' }))
  assert.deepEqual(await ok({}, { agent: { session } }), { message: 'fine' })
  lockedSessions.delete(session)
})
