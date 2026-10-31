import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const source = readFileSync(
  new URL('../../addon/js/utils/webtransport.js', import.meta.url),
  'utf8'
)

function makeStream(read, write) {
  let readCount = 0
  const reader = {
    cancelled: false,
    read() {
      return read(readCount++)
    },
    cancel() {
      this.cancelled = true
      return Promise.resolve()
    }
  }
  const writer = {
    writes: [],
    closed: false,
    write(chunk) {
      this.writes.push(chunk)
      return write ? write(chunk, this.writes.length - 1) : Promise.resolve()
    },
    close() {
      this.closed = true
      return Promise.resolve()
    }
  }
  return {
    stream: {
      readable: { getReader: () => reader },
      writable: { getWriter: () => writer }
    },
    reader,
    writer
  }
}

function loadCreateWtTransport(plans) {
  const exports = {}
  const timers = []
  const instances = []
  const logger = {
    debug() {},
    warn() {},
    error() {},
    applyLevel() {}
  }
  class FakeWebTransport {
    constructor(url, options) {
      const plan = plans.shift()
      if (!plan) throw new Error('missing WebTransport test plan')
      this.url = url
      this.options = options
      this.plan = plan
      this.closeCalls = 0
      instances.push(this)
      this.ready = plan.ready.promise
      this.closed = plan.closed.promise
    }

    close() {
      this.closeCalls++
    }

    createBidirectionalStream() {
      return this.plan.streamPromise
    }
  }
  const setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false, fired: false }
    timers.push(timer)
    return timer
  }
  const clearTimeout = (timer) => {
    if (timer) timer.cleared = true
  }
  const types = {
    Uint8Array: {
      constructor: Uint8Array,
      proto: {
        methods: {
          set: (target, source, offset) => Uint8Array.prototype.set.call(target, source, offset),
          subarray: (target, start, end) => Uint8Array.prototype.subarray.call(target, start, end)
        }
      }
    },
    DataView: {
      constructor: DataView,
      proto: {
        methods: {
          getUint32: (view, offset, littleEndian) =>
            DataView.prototype.getUint32.call(view, offset, littleEndian),
          setUint32: (view, offset, value, littleEndian) =>
            DataView.prototype.setUint32.call(view, offset, value, littleEndian)
        }
      }
    },
    TextEncoder: { constructor: TextEncoder },
    WebTransport: {
      constructor: FakeWebTransport,
      proto: {
        methods: {
          close: (connection) => connection.close(),
          createBidirectionalStream: (connection) => connection.createBidirectionalStream()
        },
        getters: {
          ready: (connection) => connection.ready,
          closed: (connection) => connection.closed
        }
      }
    },
    Promise: {
      proto: {
        methods: {
          then: (promise, onFulfilled, onRejected) =>
            Promise.prototype.then.call(promise, onFulfilled, onRejected),
          catch: (promise, onRejected) => Promise.prototype.catch.call(promise, onRejected)
        }
      }
    },
    ReadableStream: {
      proto: { methods: { getReader: (stream) => stream.getReader() } }
    },
    ReadableStreamDefaultReader: {
      proto: {
        methods: {
          read: (reader) => reader.read(),
          cancel: (reader) => reader.cancel()
        }
      }
    },
    WritableStream: {
      proto: { methods: { getWriter: (stream) => stream.getWriter() } }
    },
    WritableStreamDefaultWriter: {
      proto: {
        methods: {
          write: (writer, chunk) => writer.write(chunk),
          close: (writer) => writer.close()
        }
      }
    },
    String: {
      proto: {
        methods: {
          substr: (value, start, length) => String.prototype.substr.call(value, start, length)
        }
      }
    }
  }
  const pristine = {
    types,
    host: {
      timers: { setTimeout, clearTimeout },
      parseInt,
      mathMin: Math.min
    }
  }
  const webhid = {
    import(name) {
      if (name === 'pristine') return pristine
      if (name === 'logger') return logger
      throw new Error('unexpected import: ' + name)
    },
    export(name, value) {
      exports[name] = value
    }
  }
  const context = { webhid }
  context.globalThis = context
  runInNewContext(source, context)
  return { createWtTransport: exports.createWtTransport, timers, connections: instances }
}

function runTimer(timers, delay) {
  const timer = timers.find((entry) => !entry.cleared && !entry.fired && entry.delay === delay)
  assert.ok(timer, `expected a pending ${delay}ms timer`)
  timer.fired = true
  timer.callback()
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('late WebTransport read and write callbacks cannot damage a reconnect', async () => {
  const oldReady = deferred()
  const oldClosed = deferred()
  const oldRead = deferred()
  const oldWrite = deferred()
  const oldStream = makeStream(
    (call) => (call === 0 ? oldRead.promise : Promise.resolve({ done: true })),
    (_chunk, call) => (call === 0 ? oldWrite.promise : Promise.resolve())
  )
  const newReady = deferred()
  const newClosed = deferred()
  const newRead = deferred()
  const newStream = makeStream(
    () => newRead.promise,
    () => Promise.resolve()
  )
  const plans = [
    { ready: oldReady, closed: oldClosed, streamPromise: Promise.resolve(oldStream.stream) },
    { ready: newReady, closed: newClosed, streamPromise: Promise.resolve(newStream.stream) }
  ]
  const harness = loadCreateWtTransport(plans)
  const binaryFrames = []
  const closedEvents = []
  let authFailures = 0
  const transport = harness.createWtTransport({
    onReady() {},
    onClosed: (event) => closedEvents.push(event),
    onAuthFailed: () => authFailures++,
    onBinary: (frame) => binaryFrames.push([...frame])
  })

  transport.connect({ wtPort: 8000, token: 'old' })
  oldReady.resolve()
  await flushPromises()
  assert.equal(transport.isOpen(), true)
  assert.equal(transport.send(new Uint8Array([0x21])), true)

  oldClosed.resolve({ reason: 'old connection closed' })
  await flushPromises()
  assert.equal(closedEvents.length, 1)
  assert.equal(closedEvents[0].willReconnect, true)

  runTimer(harness.timers, 500)
  newReady.resolve()
  await flushPromises()
  assert.equal(transport.isOpen(), true)

  oldRead.resolve({ value: new Uint8Array([1, 0, 0, 0, 0xaa]), done: false })
  oldWrite.reject(new Error('late write failure from old connection'))
  await flushPromises()

  assert.equal(transport.isOpen(), true)
  assert.equal(harness.connections[1].closeCalls, 0)
  assert.equal(authFailures, 0)
  assert.deepEqual(binaryFrames, [])

  transport.disconnect()
  assert.equal(newStream.reader.cancelled, true)
})

test('late ready rejection from a replaced WebTransport is ignored', async () => {
  const oldReady = deferred()
  const oldClosed = deferred()
  const newReady = deferred()
  const newClosed = deferred()
  const oldStream = makeStream(() => Promise.resolve({ done: true }))
  const newStream = makeStream(() => Promise.resolve({ done: true }))
  const harness = loadCreateWtTransport([
    { ready: oldReady, closed: oldClosed, streamPromise: Promise.resolve(oldStream.stream) },
    { ready: newReady, closed: newClosed, streamPromise: Promise.resolve(newStream.stream) }
  ])
  let authFailures = 0
  let readyCount = 0
  const transport = harness.createWtTransport({
    onReady: () => readyCount++,
    onClosed() {},
    onAuthFailed: () => authFailures++
  })

  transport.connect({ wtPort: 8000, token: 'old' })
  transport.connect({ wtPort: 8001, token: 'new' })
  newReady.resolve()
  await flushPromises()
  assert.equal(transport.isOpen(), true)

  oldReady.reject(new Error('late ready rejection'))
  oldClosed.resolve({ reason: 'old connection closed' })
  await flushPromises()

  assert.equal(transport.isOpen(), true)
  assert.equal(readyCount, 1)
  assert.equal(authFailures, 0)
  transport.disconnect()
})
