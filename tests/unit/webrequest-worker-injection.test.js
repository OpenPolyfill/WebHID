import assert from 'node:assert/strict'
import test from 'node:test'
import { Script } from 'node:vm'
import { loadWebRequest, sendWorkerScript } from './webrequest-helpers.js'

test('worker strict directive split across UTF-8 chunks remains first', async () => {
  const encoder = new TextEncoder()
  const script = '// é\n"use strict";\nrunWorker();'
  const bytes = encoder.encode(script)
  const splitUtf8 = bytes.indexOf(0xc3) + 1
  const splitDirective = bytes.indexOf(0x0a) + 1 + 7
  const chunks = [
    bytes.slice(0, splitUtf8),
    bytes.slice(splitUtf8, splitDirective),
    bytes.slice(splitDirective)
  ]
  const harness = loadWebRequest()
  const filter = await sendWorkerScript(harness, chunks)
  await filter.done

  const output = filter.output()
  const outputText = new TextDecoder().decode(output)
  assert.ok(outputText.startsWith('// é\n"use strict";'))
  assert.ok(outputText.indexOf('/* worker polyfill */') > outputText.indexOf('"use strict";'))
  assert.doesNotThrow(() => new Script(outputText))
  assert.ok(outputText.endsWith('runWorker();'))
  assert.deepEqual([...output.slice(0, 4)], [...bytes.slice(0, 4)])
})

test('worker injection ignores strict-looking text in a leading comment', async () => {
  const script = '/* "use strict" */\n"use strict";\nrunWorker();'
  const harness = loadWebRequest()
  const filter = await sendWorkerScript(harness, [new TextEncoder().encode(script)])
  await filter.done

  const output = new TextDecoder().decode(filter.output())
  assert.ok(output.startsWith('/* "use strict" */\n"use strict";'))
  assert.ok(output.indexOf('/* worker polyfill */') > output.indexOf('"use strict";'))
  assert.doesNotThrow(() => new Script(output))
  assert.ok(output.endsWith('runWorker();'))
})

test('worker string expressions continued on the next line are not directives', async () => {
  const script = '"use strict"\n+1;\nwith ({}) {}'
  assert.doesNotThrow(() => new Script(script))

  const harness = loadWebRequest()
  const filter = await sendWorkerScript(harness, [new TextEncoder().encode(script)])
  await filter.done

  const output = new TextDecoder().decode(filter.output())
  assert.ok(output.indexOf('/* worker polyfill */') < output.indexOf('"use strict"'))
  assert.doesNotThrow(() => new Script(output))
  assert.ok(output.endsWith(script))
})

test('worker comment opener split after slash waits for the next chunk', async () => {
  const script = '"use strict"\n/* comment */\nrunWorker();'
  const encoder = new TextEncoder()
  const bytes = encoder.encode(script)
  const commentStart = script.indexOf('/*')
  const harness = loadWebRequest()
  const filter = await sendWorkerScript(harness, [
    bytes.slice(0, commentStart + 1),
    bytes.slice(commentStart + 1)
  ])
  await filter.done

  const output = new TextDecoder().decode(filter.output())
  assert.ok(output.startsWith('"use strict"\n/* comment */'))
  assert.ok(output.indexOf('/* comment */') < output.indexOf('/* worker polyfill */'))
  assert.doesNotThrow(() => new Script(output))
  assert.ok(output.endsWith('runWorker();'))
})

test('worker in keyword split across chunks does not become a directive', async () => {
  const script = '"use strict"\nin globalThis;\nwith ({}) {}'
  assert.doesNotThrow(() => new Script(script))
  const encoder = new TextEncoder()
  const bytes = encoder.encode(script)
  const inStart = script.indexOf('\nin') + 1
  const harness = loadWebRequest()
  const filter = await sendWorkerScript(harness, [
    bytes.slice(0, inStart + 1),
    bytes.slice(inStart + 1)
  ])
  await filter.done

  const output = new TextDecoder().decode(filter.output())
  assert.ok(output.indexOf('/* worker polyfill */') < output.indexOf('"use strict"'))
  assert.doesNotThrow(() => new Script(output))
  assert.ok(output.endsWith(script))
})

for (const operator of ['++', '--']) {
  test(`worker ${operator} token split across chunks preserves the directive`, async () => {
    const script = `"use strict"\n${operator}globalThis.__workerCounter;\nrunWorker();`
    assert.doesNotThrow(() => new Script(script))
    const encoder = new TextEncoder()
    const bytes = encoder.encode(script)
    const operatorStart = script.indexOf(operator)
    const harness = loadWebRequest()
    const filter = await sendWorkerScript(harness, [
      bytes.slice(0, operatorStart + 1),
      bytes.slice(operatorStart + 1)
    ])
    await filter.done

    const output = new TextDecoder().decode(filter.output())
    assert.ok(output.indexOf('/* worker polyfill */') > output.indexOf('"use strict"'))
    assert.doesNotThrow(() => new Script(output))
    assert.ok(output.endsWith(`${operator}globalThis.__workerCounter;\nrunWorker();`))
  })
}

for (const operator of ['==', '!=']) {
  test(`worker ${operator} token split across chunks stays in the expression`, async () => {
    const script = `"use strict"\n${operator}globalThis.__workerValue;\nwith ({}) {}`
    assert.doesNotThrow(() => new Script(script))
    const encoder = new TextEncoder()
    const bytes = encoder.encode(script)
    const operatorStart = script.indexOf(operator)
    const harness = loadWebRequest()
    const filter = await sendWorkerScript(harness, [
      bytes.slice(0, operatorStart + 1),
      bytes.slice(operatorStart + 1)
    ])
    await filter.done

    const output = new TextDecoder().decode(filter.output())
    assert.ok(output.indexOf('/* worker polyfill */') < output.indexOf('"use strict"'))
    assert.doesNotThrow(() => new Script(output))
    assert.ok(output.endsWith(script))
  })
}

test('worker injection preserves a leading hashbang without a strict directive', async () => {
  const script = '#!/usr/bin/env node\nrunWorker();'
  const harness = loadWebRequest()
  const filter = await sendWorkerScript(harness, [new TextEncoder().encode(script)])
  await filter.done

  const output = new TextDecoder().decode(filter.output())
  assert.ok(output.startsWith('#!/usr/bin/env node\n'))
  assert.ok(output.indexOf('/* worker polyfill */') < output.indexOf('runWorker();'))
  assert.doesNotThrow(() => new Script(output))
  assert.ok(output.endsWith(script.slice(script.indexOf('runWorker();'))))
})

test('worker injection retains preceding directives and comments before use strict', async () => {
  const script = '\'custom\';\n// before strict\n"use strict" /* before semicolon */;\nrunWorker();'
  const strictStart = script.indexOf('"use strict"')
  const strictEnd = script.indexOf(';', strictStart) + 1
  const harness = loadWebRequest()
  const filter = await sendWorkerScript(harness, [new TextEncoder().encode(script)])
  await filter.done

  const output = new TextDecoder().decode(filter.output())
  assert.ok(output.startsWith(script.slice(0, strictEnd)))
  assert.ok(output.indexOf('/* worker polyfill */') > output.indexOf('"use strict";'))
  assert.doesNotThrow(() => new Script(output))
  assert.ok(output.endsWith('runWorker();'))
})

test('worker injection preserves custom directives without use strict', async () => {
  const script = '"use asm";\n"custom";\nrunWorker();'
  const directiveEnd = script.indexOf('"custom";') + '"custom";'.length
  const harness = loadWebRequest()
  const filter = await sendWorkerScript(harness, [new TextEncoder().encode(script)])
  await filter.done

  const output = new TextDecoder().decode(filter.output())
  assert.ok(output.startsWith(script.slice(0, directiveEnd)))
  assert.ok(output.indexOf('"custom";') < output.indexOf('/* worker polyfill */'))
  assert.ok(output.indexOf('/* worker polyfill */') < output.indexOf('runWorker();'))
  assert.doesNotThrow(() => new Script(output))
})

test('worker injection preserves directives after use strict', async () => {
  const script = '"use strict";\n"custom";\nrunWorker();'
  const prologueEnd = script.indexOf('runWorker();')
  const harness = loadWebRequest()
  const filter = await sendWorkerScript(harness, [new TextEncoder().encode(script)])
  await filter.done

  const output = new TextDecoder().decode(filter.output())
  assert.ok(output.startsWith(script.slice(0, prologueEnd)))
  assert.ok(output.indexOf('"custom";') < output.indexOf('/* worker polyfill */'))
  assert.ok(output.indexOf('/* worker polyfill */') < output.indexOf('runWorker();'))
  assert.doesNotThrow(() => new Script(output))
})

test('worker injection passes through invalid directive prefixes and logs the reason', async () => {
  const script = '"use strict" /* unfinished'
  const bytes = new TextEncoder().encode(script)
  const harness = loadWebRequest()
  const filter = await sendWorkerScript(harness, [bytes])
  await filter.done

  assert.deepEqual([...filter.output()], [...bytes])
  const diagnostic = harness.debugLogs.find(
    ([message]) => message === 'worker source parser rejected an invalid prefix'
  )
  assert.ok(diagnostic)
  assert.equal(diagnostic[1].reason, 'unterminated-comment')
  assert.equal(diagnostic[1].sourceSnippet, script)
  assert.equal(diagnostic[1].truncated, false)
})

for (const separator of ['\u2028', '\u2029']) {
  test(`worker injection preserves literal line separator ${separator.codePointAt(0).toString(16)}`, async () => {
    const literal = `"hello${separator}world";`
    const script = `"use strict";\n${literal}\nrunWorker();`
    const prologueEnd = script.indexOf('runWorker();')
    const harness = loadWebRequest()
    const filter = await sendWorkerScript(harness, [new TextEncoder().encode(script)])
    await filter.done

    const output = new TextDecoder().decode(filter.output())
    const bundleIndex = output.indexOf('/* worker polyfill */')
    assert.ok(output.startsWith(script.slice(0, prologueEnd)))
    assert.ok(output.indexOf(literal) < bundleIndex)
    assert.ok(bundleIndex < output.indexOf('runWorker();'))
    assert.doesNotThrow(() => new Script(output))
  })
}
