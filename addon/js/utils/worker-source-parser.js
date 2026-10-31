;(function () {
  const webhid = globalThis.webhid

  /**
   * Failure reasons returned while parsing a worker source prefix.
   * @typedef {'unterminated-comment'|'unterminated-string'|'invalid-escape'|'invalid-syntax'|'unsupported-syntax'} WorkerSourceParseReason
   */

  /**
   * Result of parsing a cumulative worker source buffer.
   * @typedef {{state: 'ready', insertionOffset: number}|{state: 'pending'}|{state: 'invalid', reason: WorkerSourceParseReason}} WorkerSourceParseResult
   */

  /**
   * Finds a safe insertion offset after the worker script's directive prologue.
   * @param {string} source
   * @param {boolean} [eof=true]
   * @returns {WorkerSourceParseResult}
   */
  function parseWorkerSource(source, eof = true) {
    const pending = { state: 'pending' }
    const invalid = (reason) => ({ state: 'invalid', reason })
    const ready = (insertionOffset) => ({ state: 'ready', insertionOffset })
    const isLineBreak = (ch) => ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029'
    const isHexDigit = (ch) => {
      if (ch === undefined) return false
      const code = ch.charCodeAt(0)
      return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102)
    }
    const isUnsupportedSyntax = (ch) => ch === '@' || ch === '#'

    const skipTrivia = (start) => {
      let index = start
      let newline = false
      let lineStart = start === 0 || isLineBreak(source[start - 1])

      while (index < source.length) {
        const ch = source[index]
        if (ch.trim() === '') {
          if (isLineBreak(ch)) newline = lineStart = true
          index++
          continue
        }

        const hashbang =
          source.startsWith('#!', index) &&
          (index === 0 || (index === 1 && source.charCodeAt(0) === 0xfeff))
        const singleLine =
          hashbang ||
          source.startsWith('//', index) ||
          (lineStart && (source.startsWith('<!--', index) || source.startsWith('-->', index)))

        if (singleLine) {
          while (index < source.length && !isLineBreak(source[index])) index++
          continue
        }

        if (source.startsWith('/*', index)) {
          const end = source.indexOf('*/', index + 2)
          if (end === -1) return eof ? invalid('unterminated-comment') : pending
          for (let cursor = index + 2; cursor < end; cursor++) {
            if (isLineBreak(source[cursor])) newline = lineStart = true
          }
          index = end + 2
          continue
        }

        if (
          !eof &&
          ((ch === '/' && index + 1 === source.length) ||
            (lineStart &&
              ('<!--'.startsWith(source.slice(index)) || '-->'.startsWith(source.slice(index)))) ||
            ((index === 0 || (index === 1 && source.charCodeAt(0) === 0xfeff)) &&
              ch === '#' &&
              index + 1 === source.length))
        ) {
          return pending
        }
        break
      }

      if (!eof && index === source.length) return pending
      return { index, newline }
    }

    const readStringLiteral = (start) => {
      const quote = source[start]
      if (quote !== '"' && quote !== "'") return null

      for (let index = start + 1; index < source.length; index++) {
        if (source[index] === quote) return index + 1
        if (source[index] === '\n' || source[index] === '\r') return invalid('invalid-syntax')
        if (source[index] !== '\\') continue

        const escapeIndex = index + 1
        const escaped = source[escapeIndex]
        if (escaped === undefined) return eof ? invalid('unterminated-string') : pending

        if (escaped === 'x') {
          for (let cursor = escapeIndex + 1; cursor < escapeIndex + 3; cursor++) {
            if (cursor >= source.length) return eof ? invalid('invalid-escape') : pending
            if (!isHexDigit(source[cursor])) return invalid('invalid-escape')
          }
          index = escapeIndex + 2
          continue
        }

        if (escaped === 'u') {
          const brace = escapeIndex + 1
          if (source[brace] === '{') {
            let cursor = brace + 1
            let digits = 0
            let codePoint = 0
            while (cursor < source.length && isHexDigit(source[cursor])) {
              digits++
              codePoint = codePoint * 16 + Number.parseInt(source[cursor], 16)
              cursor++
            }
            if (cursor === source.length) return eof ? invalid('invalid-escape') : pending
            if (source[cursor] !== '}' || digits === 0 || digits > 6 || codePoint > 0x10ffff) {
              return invalid('invalid-escape')
            }
            index = cursor
            continue
          }

          for (let cursor = brace; cursor < brace + 4; cursor++) {
            if (cursor >= source.length) return eof ? invalid('invalid-escape') : pending
            if (!isHexDigit(source[cursor])) return invalid('invalid-escape')
          }
          index = brace + 3
          continue
        }

        if (isLineBreak(escaped)) {
          index =
            escaped === '\r' && source[escapeIndex + 1] === '\n' ? escapeIndex + 1 : escapeIndex
          continue
        }

        index = escapeIndex
      }

      return eof ? invalid('unterminated-string') : pending
    }

    const isIdentifierPart = (ch) => {
      if (ch === undefined) return false
      const code = ch.charCodeAt(0)
      return (
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        ch === '_' ||
        ch === '$' ||
        ch === '\\' ||
        code >= 128
      )
    }

    const isKeywordAt = (start, keyword) =>
      source.startsWith(keyword, start) && !isIdentifierPart(source[start + keyword.length])

    const scanAfterLiteral = (start) => {
      const next = skipTrivia(start)
      if (next.state) return next
      const { index, newline } = next
      const ch = source[index]
      if (ch === undefined) return { kind: 'eof', index }
      if (ch === ';') return { kind: 'semicolon', index }
      if (ch === '}') return { kind: 'right-brace', index }
      if (isUnsupportedSyntax(ch)) return invalid('unsupported-syntax')

      if (!eof && newline) {
        const remainder = source.slice(index)
        if (
          remainder === '+' ||
          remainder === '-' ||
          remainder === '!' ||
          'in'.startsWith(remainder) ||
          'instanceof'.startsWith(remainder)
        ) {
          return pending
        }
        if (remainder === 'in' || remainder === 'instanceof') return pending
      }

      if (!eof && ch === '!' && index + 1 === source.length) return pending

      const pair = source.slice(index, index + 2)
      let kind = 'other'
      if (pair === '++' || pair === '--') {
        if (!newline) return invalid('invalid-syntax')
      } else if (ch === '!') {
        if (source[index + 1] === '=') kind = 'continuation'
      } else if (pair === '=>') {
        return invalid('invalid-syntax')
      } else if (
        ch === '+' ||
        ch === '-' ||
        ch === '*' ||
        ch === '/' ||
        ch === '%' ||
        ch === '<' ||
        ch === '>' ||
        ch === '=' ||
        ch === '&' ||
        ch === '|' ||
        ch === '^' ||
        ch === '?' ||
        ch === '.' ||
        ch === '(' ||
        ch === '[' ||
        ch === ',' ||
        ch === '`'
      ) {
        kind = 'continuation'
      } else if (isKeywordAt(index, 'instanceof') || isKeywordAt(index, 'in')) {
        kind = 'continuation'
      }
      return { kind, index, newline }
    }

    const expressionStatement = (start) => {
      const literalEnd = readStringLiteral(start)
      if (literalEnd === null || literalEnd.state) return literalEnd

      const token = scanAfterLiteral(literalEnd)
      if (token.state) return token
      if (token.kind === 'continuation') return null
      if (token.kind === 'semicolon') {
        return { literalEnd, statementEnd: token.index + 1 }
      }
      if (token.kind === 'other' && !token.newline) return invalid('invalid-syntax')
      if (token.kind === 'eof' || token.kind === 'right-brace' || token.newline) {
        return { literalEnd, statementEnd: literalEnd }
      }
      return null
    }

    let index = 0
    while (true) {
      const next = skipTrivia(index)
      if (next.state) return next
      if (next.index >= source.length) return ready(next.index)

      const statement = expressionStatement(next.index)
      if (statement === null) {
        return isUnsupportedSyntax(source[next.index])
          ? invalid('unsupported-syntax')
          : ready(next.index)
      }
      if (statement.state) return statement
      index = statement.statementEnd
    }
  }

  webhid.export('parseWorkerSource', parseWorkerSource)
})()
