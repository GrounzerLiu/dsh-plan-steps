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
