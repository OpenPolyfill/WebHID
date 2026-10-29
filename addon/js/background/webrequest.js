;(function () {
  const webhid = globalThis.webhid
  const logger = webhid.import('logger')
  const isChromium = webhid.import('isChromium')
  const { workerPolyfillSites, permissionsPolicy, frameDelegations, shadowArms } =
    webhid.import('bgState')
  const { ensureWorkerBundle, ensureWorkerPolyfillBundle } = webhid.import('bgBundle')
  const {
    parseCspForWorkerSpawn,
    rewriteCspValue,
    rewriteCspForBlob,
    urlOrigin,
    frameKey,
    documentFrameKey,
    allowInlineScript
  } = webhid.import('bgCsp')
  const loadSiteSettings = webhid.import('loadSiteSettings')
  const bundleFiles = webhid.import('bundleFiles')

  const isMv2 = browser.runtime.getManifest().manifest_version === 2

  let mv2ScriptHashPromise = null
  /**
   * CSP hash token ('sha256-…') of the exact MV2 MAIN-world bundle text the
   * content-script injector injects, so strict page CSPs can allow it.
   * @returns {Promise<string|null>}
   */
  function mv2ScriptHashToken() {
    if (!mv2ScriptHashPromise) {
      mv2ScriptHashPromise = (async () => {
        const texts = await Promise.all(
          bundleFiles.mv2MainWorld.map((f) =>
            fetch(browser.runtime.getURL(f)).then((r) => r.text())
          )
        )
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(texts.join(';\n'))
        )
        return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`
      })().catch((e) => {
        logger.debug('mv2 script hash failed', e)
        mv2ScriptHashPromise = null
        return null
      })
    }
    return mv2ScriptHashPromise
  }

  /**
   * Maps the CSP response headers through `rewrite`, returning a new header
   * array when any value changed.
   * @param {object[]} headers
   * @param {(value: string) => string|null} rewrite
   * @returns {object[]|null}
   */
  function rewriteCspHeaders(headers, rewrite) {
    let changed = false
    const out = headers.map((h) => {
      if (h.name.toLowerCase() !== 'content-security-policy') return h
      const value = rewrite(h.value || '')
      if (value === null || value === h.value) return h
      changed = true
      return { name: h.name, value }
    })
    return changed ? out : null
  }

  /**
   * Redirect targets that continue a shadow-URL chain. Firefox keeps the same
   * requestId across a redirect chain, so the follow-up request cannot be told
   * apart by id; the onBeforeRequest listener matches it by URL instead and
   * keeps treating it as shadow. The chain is followed to the end: the browser
   * itself aborts after its own redirect limit (~20), which also bounds this
   * set.
   * @type {Set<string>}
   */
  const shadowRedirectTargets = new Set()

  /** @type {Map<number, {
   * dest: string|null,
   * shadow?: boolean,
   * destinationReady?: Promise<void>,
   * destinationResolved?: boolean,
   * resolveDestination?: () => void
   * }>} */
  const scriptDest = new Map()
  /** True when Firefox sends Fetch Metadata request headers. */
  let fetchMetadataSupported = true
  /** Resolves after the current Firefox version is known. */
  let browserInfoReady = Promise.resolve()

  /**
   * Resolves a script's destination metadata once request headers are available.
   * @param {object} record
   * @returns {void}
   */
  function resolveScriptDestination(record) {
    if (!record || record.destinationResolved || !record.resolveDestination) return
    record.destinationResolved = true
    record.resolveDestination()
  }

  /**
   * Firefox's default Accept header for top-level document navigations, keyed
   * by the first Firefox major version that introduced each value. Source:
   * MDN "List of default Accept values" (navigation row).
   * @type {Array<[number, string]>}
   */
  const NAVIGATION_ACCEPT_BY_VERSION = [
    [132, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
    [
      128,
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8'
    ],
    [92, 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8']
  ]

  /** Accept header matching the current Firefox's navigation default. */
  let navigationAccept = NAVIGATION_ACCEPT_BY_VERSION[0][1]

  /**
   * Sets a request header, replacing an existing header of the same name
   * (case-insensitively) or appending a new one.
   * @param {object[]} headers
   * @param {string} name
   * @param {string} value
   * @returns {object[]}
   */
  function setRequestHeader(headers, name, value) {
    const existing = headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
    if (existing) existing.value = value
    else headers.push({ name, value })
    return headers
  }

  /**
   * Strips the fragment from a URL string.
   * @param {string} u
   * @returns {string}
   */
  function stripFragment(u) {
    const i = u.indexOf('#')
    return i === -1 ? u : u.slice(0, i)
  }

  /**
   * Compares two URLs ignoring their fragment. Firefox strips fragments from
   * the worker-script request URL but keeps them in documentUrl, so a page at
   * "/page#sec" spawning `new Worker(location.href)` would otherwise never
   * match the shadow-URL check.
   * @param {string} a
   * @param {string} b
   * @returns {boolean}
   */
  function sameUrlModuloFragment(a, b) {
    return stripFragment(a) === stripFragment(b)
  }

  /**
   * Checks whether a shadow arm is pending for the request's tab+document,
   * without consuming it. Consumption happens in handleShadowUrl's onstart,
   * so page scripts whose URL merely equals the document URL never steal the
   * arm from the polyfill's data-worker spawn.
   * @param {object} details
   * @returns {boolean}
   */
  function hasShadowArm(details) {
    if (details.tabId === undefined || details.documentUrl === undefined) return false
    const key = `${details.tabId}:${stripFragment(details.documentUrl)}`
    const arm = shadowArms.get(key)
    if (!arm || Date.now() - arm.at > 3000) {
      if (arm) shadowArms.delete(key)
      return false
    }
    return true
  }

  /**
   * Consumes one shadow arm for the request's tab+document.
   * @param {object} details
   * @returns {boolean}
   */
  function consumeShadowArm(details) {
    if (details.tabId === undefined || details.documentUrl === undefined) return false
    const key = `${details.tabId}:${stripFragment(details.documentUrl)}`
    const arm = shadowArms.get(key)
    if (!arm) return false
    if (arm.count <= 1) shadowArms.delete(key)
    else shadowArms.set(key, { count: arm.count - 1, at: arm.at })
    return true
  }

  /**
   * Serves the worker bundle for the polyfill's own `new Worker(location.href)`
   * self-request (the shadow URL). When Sec-Fetch-Dest is observable and is not
   * "worker", the request is a page script whose URL merely equals the document
   * URL, and the response passes through untouched. Server redirects on the
   * shadow URL are followed to the end of the chain, with each hop treated the
   * same way.
   * @param {object} details
   * @returns {object | undefined}
   */
  function handleShadowUrl(details) {
    const record = { dest: null, shadow: true }
    scriptDest.set(details.requestId, record)
    const filter = browser.webRequest.filterResponseData(details.requestId)
    const enc = new TextEncoder()
    filter.onstart = () => {
      if (record.dest !== null && record.dest !== 'worker') {
        filter.disconnect()
        scriptDest.delete(details.requestId)
        return
      }
      consumeShadowArm(details)
      ensureWorkerBundle().then((bundle) => {
        if (bundle) filter.write(enc.encode(bundle))
        else
          filter.write(
            enc.encode("self.postMessage({ type: 'error', error: 'worker bundle not ready' });")
          )
        filter.close()
        scriptDest.delete(details.requestId)
      })
    }
    return {}
  }

  /**
   * Finds the end of a JavaScript directive prologue without treating text in
   * comments or compound string expressions as directives.
   * @param {string} source
   * @param {boolean} eof
   * @returns {{offset: number, invalid?: boolean}|null}
   */
  function workerDirectivePrologue(source, eof) {
    const isLineTerminator = (char) =>
      char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029'
    const skipTrivia = (start) => {
      let index = start
      let lineTerminator = false
      while (index < source.length) {
        if (/\s/.test(source[index]) || source[index] === '\uFEFF') {
          if (isLineTerminator(source[index])) lineTerminator = true
          index++
          continue
        }
        const lineStart = index === 0 || isLineTerminator(source[index - 1])
        const hashbangStart =
          source.startsWith('#!', index) &&
          (index === 0 || (index === 1 && source.charCodeAt(0) === 0xfeff))
        const htmlCommentStart =
          lineStart && (source.startsWith('<!--', index) || source.startsWith('-->', index))
        if (source.startsWith('//', index) || hashbangStart || htmlCommentStart) {
          const prefixLength = source.startsWith('<!--', index)
            ? 4
            : source.startsWith('-->', index)
              ? 3
              : 2
          let end = index + prefixLength
          while (end < source.length && !isLineTerminator(source[end])) end++
          if (end === source.length && !eof) return null
          if (end < source.length) {
            lineTerminator = true
            if (source[end] === '\r' && source[end + 1] === '\n') end++
            index = end + 1
          } else {
            index = end
          }
          continue
        }
        if (source.startsWith('/*', index)) {
          const end = source.indexOf('*/', index + 2)
          if (end === -1) return eof ? { invalid: true } : null
          if (/[\r\n\u2028\u2029]/.test(source.slice(index + 2, end))) {
            lineTerminator = true
          }
          index = end + 2
          continue
        }
        break
      }
      return { index, lineTerminator }
    }

    let index = 0
    while (true) {
      const trivia = skipTrivia(index)
      if (!trivia || trivia.invalid) return trivia
      const start = trivia.index
      if (start === source.length) return eof ? { offset: start } : null
      const quote = source[start]
      if (quote !== '"' && quote !== "'") return { offset: start }

      let end = start + 1
      let validString = true
      while (end < source.length && source[end] !== quote) {
        if (isLineTerminator(source[end])) {
          validString = false
          break
        }
        if (source[end] === '\\') {
          end++
          if (end === source.length) break
          if (source[end] === '\r' && source[end + 1] === '\n') end++
        }
        end++
      }
      if (!validString) return { offset: start }
      if (end === source.length || source[end] !== quote) {
        return eof ? { invalid: true } : null
      }

      const directiveEnd = end + 1
      const after = skipTrivia(directiveEnd)
      if (!after || after.invalid) return after
      if (after.index < source.length && source[after.index] === ';') {
        index = after.index + 1
        continue
      }
      if (after.index === source.length) {
        if (!eof) return null
        return { offset: after.index }
      }
      if (after.lineTerminator) {
        const nextToken = source.slice(after.index)
        const nextChar = nextToken[0]
        const nextPair = nextToken.slice(0, 2)
        const expressionContinues =
          (nextChar === '+' && nextPair !== '++') ||
          (nextChar === '-' && nextPair !== '--') ||
          '*/%<>&|^?,.[(`'.includes(nextChar) ||
          nextPair === '==' ||
          nextPair === '!=' ||
          /^(?:in|instanceof)\b/.test(nextToken)
        if (expressionContinues) return { offset: start }
        index = directiveEnd
        continue
      }
      return { offset: start }
    }
  }

  /**
   * Prefixes the opt-in worker-polyfill bundle into dedicated worker scripts
   * when workerPolyfillEnabled is on. It waits for destination metadata before
   * deciding, since response data can arrive before onBeforeSendHeaders.
   * Firefox 90 and newer supply Sec-Fetch-Dest. Older versions keep the legacy
   * inject-everything fallback when that header is absent.
   * @param {object} details
   * @param {{workerPolyfillEnabled: boolean}} settings
   * @returns {object | undefined}
   */
  function handleInjection(details, settings) {
    let origin = null
    try {
      origin = new URL(details.url).origin
    } catch {
      void 0
    }
    if (!settings.workerPolyfillEnabled && (!origin || !workerPolyfillSites.has(origin))) return

    let resolveDestination
    const destinationReady = new Promise((resolve) => {
      resolveDestination = resolve
    })
    const record = {
      dest: null,
      destinationReady,
      destinationResolved: false,
      resolveDestination
    }
    scriptDest.set(details.requestId, record)
    const filter = browser.webRequest.filterResponseData(details.requestId)
    const enc = new TextEncoder()
    const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    const rawChunks = []
    let sourceText = ''
    let phase = 'buffering'
    let ended = false
    let invalidUtf8 = false
    let evaluation = Promise.resolve()
    let setupPromise = null

    /**
     * Waits for request metadata and resolves whether this response is a worker.
     * @returns {Promise<{isWorkerScope: boolean, bundle: string|null}>}
     */
    function setup() {
      if (!setupPromise) {
        setupPromise = (async () => {
          await record.destinationReady
          await browserInfoReady
          const isWorkerScope =
            record.dest === 'worker' || (record.dest === null && !fetchMetadataSupported)
          return {
            isWorkerScope,
            bundle: isWorkerScope ? await ensureWorkerPolyfillBundle() : null
          }
        })()
      }
      return setupPromise
    }

    /** @returns {void} */
    function writeBuffered() {
      for (const chunk of rawChunks) filter.write(chunk)
      rawChunks.length = 0
      phase = 'passthrough'
    }

    /**
     * Checks the buffered source bytes against their decoded prefix.
     * @param {Uint8Array} expected
     * @returns {boolean}
     */
    function matchesRawPrefix(expected) {
      let offset = 0
      for (const chunk of rawChunks) {
        const count = Math.min(chunk.byteLength, expected.byteLength - offset)
        for (let i = 0; i < count; i++) {
          if (chunk[i] !== expected[offset + i]) return false
        }
        offset += count
        if (offset === expected.byteLength) return true
      }
      return offset === expected.byteLength
    }

    /**
     * Writes the original chunks with the bundle inserted at a byte offset.
     * @param {number} byteOffset
     * @param {string} bundle
     * @returns {void}
     */
    function writeWithBundle(byteOffset, bundle) {
      const bundleBytes = enc.encode('\n;\n' + bundle + '\n;\n')
      let remaining = byteOffset
      let inserted = false
      for (const chunk of rawChunks) {
        if (!inserted && remaining <= chunk.byteLength) {
          if (remaining > 0) filter.write(chunk.subarray(0, remaining))
          filter.write(bundleBytes)
          if (remaining < chunk.byteLength) filter.write(chunk.subarray(remaining))
          inserted = true
        } else if (inserted) {
          filter.write(chunk)
        } else {
          filter.write(chunk)
          remaining -= chunk.byteLength
        }
      }
      if (!inserted) filter.write(bundleBytes)
      rawChunks.length = 0
      phase = 'passthrough'
    }

    /** @returns {void} */
    function evaluateBuffered() {
      evaluation = evaluation
        .then(async () => {
          if (phase !== 'buffering') return
          if (invalidUtf8) {
            writeBuffered()
            return
          }
          const { isWorkerScope, bundle } = await setup()
          if (phase !== 'buffering') return
          if (!isWorkerScope || !bundle) {
            writeBuffered()
            return
          }
          const prologue = workerDirectivePrologue(sourceText, ended)
          if (!prologue) return
          if (prologue.invalid) {
            writeBuffered()
            return
          }
          const rawPrefix = enc.encode(sourceText.slice(0, prologue.offset))
          if (!matchesRawPrefix(rawPrefix)) {
            writeBuffered()
            return
          }
          writeWithBundle(rawPrefix.byteLength, bundle)
        })
        .catch((error) => {
          logger.debug('worker script injection failed; passing through original response', error)
          if (phase === 'buffering') writeBuffered()
        })
    }

    filter.ondata = (event) => {
      if (phase === 'passthrough') {
        filter.write(event.data)
        return
      }
      if (phase !== 'buffering') return
      const chunk = new Uint8Array(event.data)
      rawChunks.push(chunk)
      try {
        sourceText += dec.decode(chunk, { stream: true })
      } catch {
        invalidUtf8 = true
      }
      evaluateBuffered()
    }
    filter.onstop = () => {
      resolveScriptDestination(record)
      ended = true
      if (!invalidUtf8) {
        try {
          sourceText += dec.decode()
        } catch {
          invalidUtf8 = true
        }
      }
      evaluateBuffered()
      evaluation.then(() => {
        if (phase === 'buffering') writeBuffered()
        if (phase !== 'done') {
          filter.close()
          phase = 'done'
          scriptDest.delete(details.requestId)
        }
      })
    }
    filter.onerror = () => {
      resolveScriptDestination(record)
      phase = 'done'
      scriptDest.delete(details.requestId)
      try {
        filter.close()
      } catch {
        void 0
      }
    }
    return {}
  }


  /**
   * Rewrites an in-document CSP `<meta>` tag in place when the worker spawn
   * needs a blob fallback, and records the analyzed policy for the bridge.
   * @param {object} details
   * @param {{workerSpawnMode: string}} settings
   * @returns {void}
   */
  function handleMetaCsp(details, settings) {
    const filter = browser.webRequest.filterResponseData(details.requestId)
    const enc = new TextEncoder()
    const scanDecoder = new TextDecoder('utf-8', { ignoreBOM: true })
    const rawChunks = []
    const pendingChunks = []
    let scanText = ''
    let gaveUp = false
    let processed = false
    let disconnected = false

    const origin = urlOrigin(details.url)
    const modePromise = resolveSiteSpawnMode(origin, settings)

    /**
     * Writes each buffered chunk to the response filter.
     * @param {Uint8Array[]} chunks
     * @returns {void}
     */
    function writeChunks(chunks) {
      for (const chunk of chunks) filter.write(chunk)
    }

    /** @returns {void} */
    function disconnectWithBufferedData() {
      if (disconnected) return
      disconnected = true
      writeChunks(rawChunks)
      writeChunks(pendingChunks)
      rawChunks.length = 0
      pendingChunks.length = 0
      filter.disconnect()
    }

    /**
     * Checks that a decoded prefix matches the original response bytes.
     * @param {Uint8Array[]} chunks
     * @param {Uint8Array} expected
     * @returns {boolean}
     */
    function rawPrefixMatches(chunks, expected) {
      let offset = 0
      for (const chunk of chunks) {
        const count = Math.min(chunk.byteLength, expected.byteLength - offset)
        for (let i = 0; i < count; i++) {
          if (chunk[i] !== expected[offset + i]) return false
        }
        offset += count
        if (offset === expected.byteLength) return true
      }
      return offset === expected.byteLength
    }

    /**
     * Writes a rewritten head followed by the untouched response bytes.
     * @param {string} rewrittenHead
     * @param {number} sourcePrefixLength
     * @param {Uint8Array[]} chunks
     * @returns {void}
     */
    function writeRewrittenHead(rewrittenHead, sourcePrefixLength, chunks) {
      filter.write(enc.encode(rewrittenHead))
      let remaining = sourcePrefixLength
      for (const chunk of chunks) {
        if (remaining >= chunk.byteLength) {
          remaining -= chunk.byteLength
          continue
        }
        filter.write(chunk.subarray(remaining))
        remaining = 0
      }
    }

    /**
     * @param {boolean} eof
     * @returns {Promise<void>}
     */
    async function process(eof) {
      if (processed || disconnected) return
      const headEnd = scanText.search(/<\/head>/i)
      if (headEnd === -1 && !eof && !gaveUp) return
      processed = true
      if (headEnd === -1 && gaveUp) {
        disconnectWithBufferedData()
        return
      }
      try {
        const mode = await modePromise
        const scriptHashToken = isMv2 ? await mv2ScriptHashToken() : null
        const chunks = rawChunks.concat(pendingChunks)
        const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
        let html = ''
        for (const chunk of chunks) html += decoder.decode(chunk, { stream: true })
        html += decoder.decode()
        const matchedHeadEnd = html.search(/<\/head>/i)
        const end = matchedHeadEnd === -1 ? html.length : matchedHeadEnd
        const head = html.slice(0, end)
        const metaInfos = []
        let anyChange = false
        const rewrittenHead = head.replace(/<meta\s[^>]*>/gi, (tag) => {
          if (!/http-equiv\s*=\s*["']?\s*content-security-policy\s*["']?/i.test(tag)) return tag
          const contentMatch = tag.match(/\bcontent\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)
          if (!contentMatch) return tag
          const quote =
            contentMatch[2] !== undefined ? '"' : contentMatch[3] !== undefined ? "'" : ''
          const csp = contentMatch[2] ?? contentMatch[3] ?? contentMatch[4] ?? ''
          const info = parseCspForWorkerSpawn([csp], mode, origin)
          if (!info) return tag
          metaInfos.push(info)
          let value = csp
          let changed = false
          if (mode === 'blob' && info.needsBlobFallback) {
            const { value: v, modified } = rewriteCspValue(value, info)
            if (modified) {
              value = v
              changed = true
            }
          }
          if (scriptHashToken) {
            const v = allowInlineScript(value, scriptHashToken)
            if (v !== null) {
              value = v
              changed = true
            }
          }
          if (!changed) return tag
          anyChange = true
          return tag.replace(contentMatch[0], 'content=' + (quote || '"') + value + (quote || '"'))
        })

        if (metaInfos.length) {
          const key = `csp:${frameKey(details.tabId, details.frameId, origin)}`
          browser.storage.session
            .get(key)
            .then((r) => {
              const existing = r[key]
              const merged = {
                workerSrc: metaInfos[0].workerSrc ?? existing?.workerSrc,
                connectSrc: metaInfos[0].connectSrc ?? existing?.connectSrc,
                workerSrcBlocked:
                  metaInfos.some((i) => i.workerSrcBlocked) || !!existing?.workerSrcBlocked,
                connectSrcBlocked:
                  metaInfos.some((i) => i.connectSrcBlocked) || !!existing?.connectSrcBlocked,
                hasTrustedTypesRequire:
                  metaInfos.some((i) => i.hasTrustedTypesRequire) ||
                  !!existing?.hasTrustedTypesRequire,
                shadowBlocked: metaInfos.some((i) => i.shadowBlocked) || !!existing?.shadowBlocked,
                metaShadowBlocked:
                  metaInfos.some((i) => i.shadowBlocked) || !!existing?.metaShadowBlocked,
                headerShadowBlocked: !!existing?.headerShadowBlocked,
                needsBlobFallback:
                  metaInfos.some((i) => i.needsBlobFallback) || !!existing?.needsBlobFallback
              }
              browser.storage.session.set({ [key]: merged }).catch(() => {})
            })
            .catch(() => {})
        }

        if (!anyChange) {
          disconnectWithBufferedData()
          return
        }
        const sourcePrefix = enc.encode(html.slice(0, end))
        if (!rawPrefixMatches(chunks, sourcePrefix)) {
          disconnectWithBufferedData()
          return
        }
        disconnected = true
        writeRewrittenHead(rewrittenHead, sourcePrefix.byteLength, chunks)
        rawChunks.length = 0
        pendingChunks.length = 0
        filter.disconnect()
      } catch {
        disconnectWithBufferedData()
      }
    }

    filter.ondata = (event) => {
      if (disconnected) return
      const chunk = new Uint8Array(event.data)
      if (processed) {
        pendingChunks.push(chunk)
        return
      }
      rawChunks.push(chunk)
      if (scanText.length < 262144) {
        scanText += scanDecoder.decode(chunk, { stream: true })
      } else {
        gaveUp = true
      }
      process(false)
    }
    filter.onstop = () => {
      if (!processed) scanText += scanDecoder.decode()
      process(true)
    }
    filter.onerror = () => {
      try {
        filter.disconnect()
      } catch {
        return
      }
    }
  }

  /**
   * Records the resolved per-frame spawn mode, preferring the per-site
   * override.
   * @param {string} origin
   * @param {{workerSpawnMode: string}} settings
   * @returns {Promise<string>}
   */
  async function resolveSiteSpawnMode(origin, settings) {
    let mode = settings.workerSpawnMode
    if (!origin) return mode
    const site = await loadSiteSettings(origin).catch(() => ({}))
    if (site.workerSpawnMode !== undefined) {
      mode = site.workerSpawnMode
    }
    return mode
  }

  /**
   * Stores the frame's effective CSP info in session storage so the bridge can
   * pre-flight its worker spawn, rewriting the header for MV2 blob fallback.
   * @param {object} details
   * @param {{workerSpawnMode: string}} settings
   * @returns {Promise<object | undefined>}
   */
  async function storeFrameCspInfo(details, settings) {
    const cspValues = (details.responseHeaders || [])
      .filter((h) => h.name.toLowerCase() === 'content-security-policy')
      .map((h) => h.value || '')

    const origin = urlOrigin(details.url)
    const key = `csp:${frameKey(details.tabId, details.frameId, origin)}`

    const siteSpawnMode = await resolveSiteSpawnMode(origin, settings)

    const cspInfo = parseCspForWorkerSpawn(cspValues, siteSpawnMode, origin)
    if (cspInfo) cspInfo.headerShadowBlocked = cspInfo.shadowBlocked
    let modified = null
    if (isMv2 && cspValues.length) {
      const token = await mv2ScriptHashToken()
      let headers = details.responseHeaders
      if (cspInfo && cspInfo.needsBlobFallback) {
        const blob = rewriteCspForBlob(headers, cspInfo)
        if (blob) {
          headers = blob
          cspInfo.rewrittenCsp = blob
            .filter((h) => h.name.toLowerCase() === 'content-security-policy')
            .map((h) => h.value)
        }
      }
      if (token) {
        const inline = rewriteCspHeaders(headers, (value) => allowInlineScript(value, token))
        if (inline) modified = inline
      }
      if (!modified && headers !== details.responseHeaders) modified = headers
    }
    if (cspInfo) {
      browser.storage.session
        .set({ [key]: cspInfo })
        .catch((e) => logger.debug('csp session store failed', e))
    } else {
      browser.storage.session.remove(key).catch(() => {})
    }
    return modified
  }

  /**
   * Parses one `hid` declaration from a Permissions-Policy header into an
   * allowlist descriptor:
   *   { kind: 'all' }                    for `*`
   *   { kind: 'none', origins: [] }      for `()` or malformed values
   *   { kind: 'list', origins: [] }      explicit origins (self resolved
   *                                      by the caller against the origin)
   * Unknown tokens contribute nothing; malformed values fail closed (do not
   * silently broaden access).
   * @param {string} value
   * @returns {{kind: 'all'|'none'|'list', origins: string[]}}
   */
  function parseHidPolicy(value) {
    const v = value.trim()
    if (v === '*') return { kind: 'all', origins: [] }
    if (v === 'self') return { kind: 'list', origins: ['self'] }
    if (!v.startsWith('(') || !v.endsWith(')')) return { kind: 'none', origins: [] }
    const inner = v.slice(1, -1).trim()
    if (inner === '') return { kind: 'none', origins: [] }
    const origins = []
    let sawStar = false
    let sawSelf = false
    for (const raw of inner.split(/\s+/)) {
      const token = raw.replace(/^['"]|['"]$/g, '')
      if (token === '*') sawStar = true
      else if (token === 'self') sawSelf = true
      else {
        try {
          const origin = new URL(token).origin
          if (origin !== 'null' && !origins.includes(origin)) origins.push(origin)
        } catch {
          // Unrecognized token: contributes nothing.
        }
      }
    }
    if (sawStar) return { kind: 'all', origins: [] }
    if (sawSelf) origins.push('self')
    if (origins.length === 0) return { kind: 'none', origins: [] }
    return { kind: 'list', origins }
  }

  /**
   * Intersects two allowlists. Deny dominates: any `none` yields `none`.
   * @param {{kind: string, origins: string[]}} a
   * @param {{kind: string, origins: string[]}} b
   * @returns {{kind: 'all'|'none'|'list', origins: string[]}}
   */
  function intersectAllowlists(a, b) {
    if (a.kind === 'none' || b.kind === 'none') return { kind: 'none', origins: [] }
    if (a.kind === 'all') return b
    if (b.kind === 'all') return a
    const origins = a.origins.filter((o) => b.origins.includes(o))
    return origins.length
      ? { kind: 'list', origins }
      : { kind: 'none', origins: [] }
  }

  /**
   * Whether `origin` is inside an allowlist. `self` tokens are resolved
   * against the owning frame's origin at store time, so lists here contain
   * concrete origins only.
   * @param {{kind: string, origins: string[]}} list
   * @param {string} origin
   * @returns {boolean}
   */
  function listAllows(list, origin) {
    if (list.kind === 'all') return true
    if (list.kind !== 'list') return false
    return list.origins.includes(origin)
  }

  /**
   * Records a frame document's own `hid` policy and its effective policy
   * resolved down the exact browser frame ancestry.
   * @param {object} details
   * @returns {void}
   */
  function storePermissionsPolicy(details) {
    const origin = urlOrigin(details.url)
    const documentId =
      typeof details.documentId === 'string' && details.documentId ? details.documentId : ''
    const parentFrameId =
      Number.isInteger(details.parentFrameId) && details.parentFrameId >= 0
        ? details.parentFrameId
        : -1
    const parentDocumentId =
      typeof details.parentDocumentId === 'string' && details.parentDocumentId
        ? details.parentDocumentId
        : ''
    const parentKey =
      parentFrameId >= 0 && parentDocumentId
        ? documentFrameKey(details.tabId, parentFrameId, parentDocumentId)
        : null
    const headers = (details.responseHeaders || [])
      .filter((h) => h.name.toLowerCase() === 'permissions-policy')
      .map((h) => h.value || '')
    let self = { kind: 'all', origins: [] }
    const declarations = []
    for (const ph of headers) {
      for (const raw of ph.split(',')) {
        const eq = raw.indexOf('=')
        if (eq === -1) continue
        const feature = raw.slice(0, eq).trim().toLowerCase()
        if (feature !== 'hid') continue
        declarations.push(parseHidPolicy(raw.slice(eq + 1)))
      }
    }
    if (declarations.length) {
      self = declarations.reduce(intersectAllowlists)
      if (self.kind === 'list') {
        self = {
          kind: 'list',
          origins: self.origins.map((o) => (o === 'self' ? origin : o))
        }
      }
    }
    let effective = self
    if (self.kind !== 'none') {
      let parent = parentKey ? permissionsPolicy.get(parentKey) : null
      if (!parent && parentKey) {
        const pendingParentKey = documentFrameKey(details.tabId, parentFrameId, '')
        parent = permissionsPolicy.get(pendingParentKey) || null
        if (parent) {
          permissionsPolicy.delete(pendingParentKey)
          parent.documentId = parentDocumentId
          permissionsPolicy.set(parentKey, parent)
        }
      }
      const parentEffective = parent ? parent.effective : { kind: 'all', origins: [] }
      if (!listAllows(parentEffective, origin)) {
        effective = { kind: 'none', origins: [] }
      }
    }
    const key = documentFrameKey(details.tabId, details.frameId, documentId)
    permissionsPolicy.set(key, {
      tabId: details.tabId,
      frameId: details.frameId,
      documentId,
      origin,
      url: details.url,
      parentFrameId,
      parentDocumentId,
      parentKey,
      self,
      effective
    })
    logger.debug('Permissions-Policy stored: ' + key + ' hid=' + JSON.stringify(effective))
  }
  /**
   * @param {number} tabId
   * @param {number} frameId
   * @returns {void}
   */
  function clearPolicyFrame(tabId, frameId) {
    const prefix = `${tabId}:${frameId}:`
    for (const store of [permissionsPolicy, frameDelegations]) {
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) store.delete(key)
      }
    }
  }
  /**
   * @param {number} tabId
   * @returns {void}
   */
  function clearPolicyTab(tabId) {
    const prefix = `${tabId}:`
    for (const store of [permissionsPolicy, frameDelegations]) {
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) store.delete(key)
      }
    }
  }

  /**
   * Registers all webRequest listeners used by the background page.
   * @param {{workerSpawnMode: string, workerPolyfillEnabled: boolean}} settings
   * @returns {void}
   */
  function registerWebRequestHandlers(settings) {
    if (isChromium) {
      browser.webRequest.onHeadersReceived.addListener(
        (details) => {
          storePermissionsPolicy(details)
        },
        { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
        ['responseHeaders']
      )
      browser.webRequest.onBeforeRequest.addListener(
        (details) => {
          if (details.tabId === undefined || details.frameId === undefined) return
          if (details.type === 'main_frame') clearPolicyTab(details.tabId)
          else clearPolicyFrame(details.tabId, details.frameId)
        },
        { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] }
      )
      return
    }
    browserInfoReady = browser.runtime
      .getBrowserInfo()
      .then((info) => {
        const major = Number.parseInt(info.version, 10)
        fetchMetadataSupported = major >= 90
        for (const [since, value] of NAVIGATION_ACCEPT_BY_VERSION) {
          if (major >= since) {
            navigationAccept = value
            break
          }
        }
      })
      .catch(() => {})

    browser.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        const record = scriptDest.get(details.requestId)
        if (!record) return
        const header = (details.requestHeaders || []).find(
          (h) => h.name.toLowerCase() === 'sec-fetch-dest'
        )
        record.dest = header && header.value ? header.value : null
        resolveScriptDestination(record)
        if (!record.shadow || record.dest !== 'worker') return
        const headers = details.requestHeaders || (details.requestHeaders = [])
        setRequestHeader(headers, 'Sec-Fetch-Dest', 'document')
        setRequestHeader(headers, 'Sec-Fetch-Mode', 'navigate')
        setRequestHeader(headers, 'Sec-Fetch-Site', 'none')
        setRequestHeader(headers, 'Sec-Fetch-User', '?1')
        setRequestHeader(headers, 'Accept', navigationAccept)
        return { requestHeaders: headers }
      },
      { urls: ['<all_urls>'], types: ['script'] },
      ['blocking', 'requestHeaders']
    )

    browser.webRequest.onBeforeRedirect.addListener(
      (details) => {
        const record = scriptDest.get(details.requestId)
        if (!record || !record.shadow || !details.redirectUrl) return
        if (stripFragment(details.redirectUrl) === stripFragment(details.url)) return
        scriptDest.delete(details.requestId)
        shadowRedirectTargets.add(stripFragment(details.redirectUrl))
      },
      { urls: ['<all_urls>'], types: ['script'] }
    )

    browser.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (details.type !== 'script') return
        const urlKey = stripFragment(details.url)
        if (shadowRedirectTargets.has(urlKey)) {
          shadowRedirectTargets.delete(urlKey)
          return handleShadowUrl(details)
        }
        const isShadowUrl =
          details.documentUrl !== undefined &&
          sameUrlModuloFragment(details.url, details.documentUrl)
        if (isShadowUrl && hasShadowArm(details)) return handleShadowUrl(details)
        return handleInjection(details, settings)
      },
      { urls: ['<all_urls>'], types: ['script'] },
      ['blocking']
    )

    browser.webRequest.onErrorOccurred.addListener(
      (details) => {
        const record = scriptDest.get(details.requestId)
        resolveScriptDestination(record)
        scriptDest.delete(details.requestId)
      },
      { urls: ['<all_urls>'], types: ['script'] }
    )

    browser.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (details.type !== 'main_frame' && details.type !== 'sub_frame') return
        handleMetaCsp(details, settings)
      },
      { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
      ['blocking']
    )

    browser.webRequest.onHeadersReceived.addListener(
      (details) => {
        if (
          details.type !== 'script' ||
          details.documentUrl === undefined ||
          !sameUrlModuloFragment(details.url, details.documentUrl)
        )
          return
        const record = scriptDest.get(details.requestId)
        if (record && record.dest !== null && record.dest !== 'worker') return
        const headers = details.responseHeaders.filter(
          (h) =>
            !/^(content-security-policy|content-type|content-length|content-disposition|x-content-type-options)$/i.test(
              h.name
            )
        )
        headers.push({ name: 'Content-Type', value: 'application/javascript' })
        return { responseHeaders: headers }
      },
      { urls: ['<all_urls>'], types: ['script'] },
      ['blocking', 'responseHeaders']
    )

    browser.webRequest.onHeadersReceived.addListener(
      (details) => {
        storePermissionsPolicy(details)
        return {}
      },
      { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
      ['blocking', 'responseHeaders']
    )

    browser.webRequest.onHeadersReceived.addListener(
      async (details) => {
        if (details.type !== 'main_frame' && details.type !== 'sub_frame') return
        const modified = await storeFrameCspInfo(details, settings)
        if (modified) return { responseHeaders: modified }
      },
      { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
      ['blocking', 'responseHeaders']
    )

    browser.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (details.tabId === undefined || details.frameId === undefined) return
        if (details.type === 'main_frame') clearPolicyTab(details.tabId)
        else clearPolicyFrame(details.tabId, details.frameId)
        const key = `${details.tabId}:${details.frameId}`
        browser.storage.session
          .get(null)
          .then((all) => {
            const keys = Object.keys(all).filter((k) => k.startsWith(`csp:${key}:`))
            if (keys.length) browser.storage.session.remove(keys).catch(() => {})
          })
          .catch(() => {})
      },
      { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] }
    )
  }

  webhid.export('registerWebRequestHandlers', registerWebRequestHandlers)
  webhid.export('stripFragment', stripFragment)
})()
