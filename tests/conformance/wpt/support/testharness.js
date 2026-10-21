const testResults = []
const completionCallbacks = []
const isWorkerContext = typeof document === 'undefined'
let pageLoaded = isWorkerContext
let workerFinished = false
let completionSent = false
let pendingTestCount = 0

function getHarnessStatus() {
  const failure = testResults.find((testResult) => testResult.status !== 0)
  return {
    status: failure ? 1 : 0,
    message: failure ? failure.message : null
  }
}

function completeIfReady() {
  if (completionSent || pendingTestCount !== 0) return
  if (isWorkerContext ? !workerFinished : !pageLoaded) return

  completionSent = true
  const status = getHarnessStatus()
  for (const callback of completionCallbacks) callback(testResults, status)
  if (isWorkerContext) {
    globalThis.postMessage({ type: 'wpt-test-complete', tests: testResults, status })
  }
}

function createTest(name) {
  pendingTestCount += 1
  const testResult = { name, status: 0, message: '' }
  let finished = false
  const timer = setTimeout(() => finish(new Error(`Timed out: ${name}`)), 20000)

  function finish(error) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    if (error) {
      testResult.status = 1
      testResult.message = error instanceof Error ? error.message : String(error)
    }
    testResults.push(testResult)
    pendingTestCount -= 1
    completeIfReady()
  }

  const testObject = {
    done: () => finish(),
    step_func: (callback) => function (...args) {
      if (finished) return
      try {
        return callback.apply(this, args)
      } catch (error) {
        finish(error)
      }
    },
    step_func_done: (callback) => function (...args) {
      if (finished) return
      try {
        const value = callback.apply(this, args)
        finish()
        return value
      } catch (error) {
        finish(error)
      }
    }
  }

  return { testObject, finish }
}

function promiseTest(callback, name) {
  const test = createTest(name)
  Promise.resolve()
    .then(() => callback(test.testObject))
    .then(() => test.finish(), (error) => test.finish(error))
}

function asyncTest(callback, name) {
  const test = createTest(name)
  try {
    callback(test.testObject)
  } catch (error) {
    test.finish(error)
  }
  return test.testObject
}

function fetchTestsFromWorker(worker) {
  pendingTestCount += 1
  let finished = false
  const timer = setTimeout(() => finish([
    { name: 'Worker test harness', status: 1, message: 'Timed out waiting for worker results' }
  ]), 20000)

  function finish(workerResults, workerStatus) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    testResults.push(...workerResults)
    if (workerStatus && workerStatus.status !== 0 && !workerResults.some((result) => result.status !== 0)) {
      testResults.push({
        name: 'Worker test harness',
        status: 1,
        message: workerStatus.message || 'Worker test harness failed'
      })
    }
    pendingTestCount -= 1
    completeIfReady()
  }

  worker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'wpt-test-complete') {
      finish(event.data.tests || [], event.data.status)
    }
  })
  worker.addEventListener('error', (event) => {
    finish([{ name: 'Worker test harness', status: 1, message: event.message }])
  })
}

function addCompletionCallback(callback) {
  completionCallbacks.push(callback)
  if (completionSent) callback(testResults, getHarnessStatus())
}

function assertTrue(actual, message = '') {
  if (actual !== true) throw new Error(message || `Expected true, received ${actual}`)
}

function assertFalse(actual, message = '') {
  if (actual !== false) throw new Error(message || `Expected false, received ${actual}`)
}

function assertEquals(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(message || `Expected ${String(expected)}, received ${String(actual)}`)
  }
}

function assertUnreached(message = 'Reached an unexpected code path') {
  throw new Error(message)
}

function done() {
  workerFinished = true
  completeIfReady()
}

Object.assign(globalThis, {
  add_completion_callback: addCompletionCallback,
  async_test: asyncTest,
  assert_equals: assertEquals,
  assert_false: assertFalse,
  assert_true: assertTrue,
  assert_unreached: assertUnreached,
  done,
  fetch_tests_from_worker: fetchTestsFromWorker,
  promise_test: promiseTest
})

if (!isWorkerContext) {
  globalThis.addEventListener('load', () => {
    pageLoaded = true
    completeIfReady()
  }, { once: true })
}
