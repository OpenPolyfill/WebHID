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
  const filter = sendWorkerScript(harness, chunks)
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
  const filter = sendWorkerScript(harness, [new TextEncoder().encode(script)])
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
  const filter = sendWorkerScript(harness, [new TextEncoder().encode(script)])
  await filter.done

  const output = new TextDecoder().decode(filter.output())
  assert.ok(output.indexOf('/* worker polyfill */') < output.indexOf('"use strict"'))
  assert.doesNotThrow(() => new Script(output))
  assert.ok(output.endsWith(script))
})
