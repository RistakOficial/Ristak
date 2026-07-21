import test from 'node:test'
import assert from 'node:assert/strict'
import { createSingleFlightRunner } from '../src/utils/singleFlight.js'

test('single-flight shares one active HighLevel sync and allows a later run', async () => {
  let releaseFirst
  let executions = 0
  let duplicates = 0
  const runner = createSingleFlightRunner({ onDuplicate: () => { duplicates += 1 } })

  const first = runner(async () => {
    executions += 1
    await new Promise(resolve => { releaseFirst = resolve })
    return 'first-result'
  })
  const second = runner(async () => {
    executions += 1
    return 'should-not-run'
  })

  await Promise.resolve()
  assert.equal(runner.isRunning(), true)
  assert.equal(first, second)
  assert.equal(executions, 1)
  assert.equal(duplicates, 1)

  releaseFirst()
  assert.equal(await second, 'first-result')
  assert.equal(runner.isRunning(), false)

  assert.equal(await runner(async () => {
    executions += 1
    return 'later-result'
  }), 'later-result')
  assert.equal(executions, 2)
})
