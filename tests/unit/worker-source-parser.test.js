import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWebRequest } from './webrequest-helpers.js'

const { parseWorkerSource } = loadWebRequest()

test('worker source parser returns the safe end of the directive prologue', () => {
  const source = '#!/usr/bin/env node\n"use strict";\n"custom";\nrunWorker();'
  const result = parseWorkerSource(source)

  assert.equal(result.state, 'ready')
  assert.equal(result.insertionOffset, source.indexOf('runWorker();'))
})

test('worker source parser reports incomplete prefixes as pending', () => {
  for (const source of ['"use str', '"use strict"\n+', '/* unfinished']) {
    assert.equal(parseWorkerSource(source, false).state, 'pending')
  }
})

const invalidCases = [
  ['unterminated block comment', '/* unfinished', 'unterminated-comment'],
  ['unterminated string', '"unfinished', 'unterminated-string'],
  ['invalid hexadecimal escape', '"bad\\xG0";', 'invalid-escape'],
  ['raw line break in string', '"first\nsecond"', 'invalid-syntax'],
  ['adjacent same-line token', '"use strict" trailing', 'invalid-syntax'],
  ['unsupported decorator syntax', '"use strict"\n@decorator', 'unsupported-syntax']
]

for (const [name, source, reason] of invalidCases) {
  test(`worker source parser classifies ${name}`, () => {
    const result = parseWorkerSource(source)
    assert.equal(result.state, 'invalid')
    assert.equal(result.reason, reason)
  })
}
