import assert from 'node:assert/strict'
import test from 'node:test'

import { __testing } from '../index.js'

const { normalize, locate, advance, replayCalls, renderTaskState } = __testing

const list = (...items) => items.map(([content, status]) => ({ content, status }))

test('normalize collapses whitespace so a retitled step still matches', () => {
  assert.equal(normalize('  run   focused\ttests '), 'run focused tests')
  assert.equal(normalize(undefined), '')
})

test('locate prefers the exact name, then case, then the 1-based position', () => {
  const items = list(['Alpha', 'in_progress'], ['beta', 'pending'])
  assert.equal(locate(items, 'Alpha', undefined), 0)
  assert.equal(locate(items, 'BETA', undefined), 1)
  assert.equal(locate(items, '', 2), 1)
  assert.equal(locate(items, 'gamma', undefined), -1)
  assert.equal(locate(items, '', 3), -1)
})

test('advance completes the step and promotes the next pending one', () => {
  const items = list(['a', 'in_progress'], ['b', 'pending'], ['c', 'pending'])
  const next = advance(items, 0)
  assert.deepEqual(next, list(['a', 'completed'], ['b', 'in_progress'], ['c', 'pending']))
  assert.equal(items[0].status, 'in_progress', 'the input list must not be mutated')
})

test('advance leaves no current item once the last step is signed off', () => {
  const next = advance(list(['a', 'completed'], ['b', 'in_progress']), 1)
  assert.deepEqual(next, list(['a', 'completed'], ['b', 'completed']))
})

test('replayCalls ignores an unsettled call and a failed one', () => {
  const events = [
    { type: 'tool/call', data: { callId: 'w1', name: 'todo_write', arguments: '{"todos":[{"content":"a","status":"in_progress"},{"content":"b","status":"pending"}]}' } },
    { type: 'tool/result', data: { message: { toolCallId: 'w1', isError: false } } },
    // settled, failed sign-off: must not move the list
    { type: 'tool/call', data: { callId: 'c0', name: 'complete_step', arguments: '{"step":"a","result":"x"}' } },
    { type: 'tool/result', data: { message: { toolCallId: 'c0', isError: true } } },
    // never settled: the current call, still in flight
    { type: 'tool/call', data: { callId: 'c1', name: 'complete_step', arguments: '{"step":"a","result":"y"}' } },
  ]
  assert.deepEqual(replayCalls(events), list(['a', 'in_progress'], ['b', 'pending']))
})

test('replayCalls applies a settled sign-off and moves the next step in', () => {
  const events = [
    { type: 'tool/call', data: { callId: 'w1', name: 'todo_write', arguments: '{"todos":[{"content":"a","status":"in_progress"},{"content":"b","status":"pending"}]}' } },
    { type: 'tool/result', data: { message: { toolCallId: 'w1', isError: false } } },
    { type: 'tool/call', data: { callId: 'c1', name: 'complete_step', arguments: '{"step":"a","result":"done"}' } },
    { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } },
  ]
  assert.deepEqual(replayCalls(events), list(['a', 'completed'], ['b', 'in_progress']))
})

test('replayCalls stays null without a task list', () => {
  assert.equal(replayCalls([]), null)
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
  const { stepSeqOf } = __testing
  assert.equal(stepSeqOf(undefined), null)
  assert.equal(stepSeqOf([{ type: 'turn/start', seq: 1 }]), null)
  assert.equal(stepSeqOf([{ type: 'step/start', seq: 4 }, { type: 'tool/call', seq: 5 }]), 4)
  assert.equal(
    stepSeqOf([{ type: 'step/start', seq: 4 }, { type: 'step/start', seq: 9 }, { type: 'tool/call', seq: 10 }]),
    9,
  )
})

test('locate prefers the name over the position', () => {
  const items = list(['alpha', 'in_progress'], ['beta', 'pending'])
  // both name and a position are given: the name wins
  assert.equal(locate(items, 'beta', 1), 1)
  assert.equal(locate(items, 'alpha', 2), 0)
  // an unknown name still falls back to the position
  assert.equal(locate(items, '', 2), 1)
  assert.equal(locate(items, 'gamma', 2), 1)
  assert.equal(locate(items, 'gamma', 5), -1)
})

test('parseTodos accepts the initial null and rejects a non-list', () => {
  const { parseTodos } = __testing
  assert.equal(parseTodos(null), null)
  assert.equal(parseTodos(undefined), null)
  assert.deepEqual(parseTodos([{ content: 'a', status: 'in_progress' }]), [{ content: 'a', status: 'in_progress' }])
  assert.throws(() => parseTodos({ todos: [] }), /array or null/)
})
