;(function () {
  const webhid = globalThis.webhid

  /**
   * Finds a safe insertion offset after the worker script's directive prologue.
   * @param {string} source
   * @param {boolean} [eof=true]
   * @returns {{insertionOffset: number|null|undefined}}
   */
  function parseWorkerSource(source, eof = true) {
    const pending = { insertionOffset: null }
    const invalid = { insertionOffset: undefined }
    const isLineBreak = (ch) => ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029'

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
          if (end === -1) return eof ? { invalid: true } : { pending: true }
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
          return { pending: true }
        }
        break
      }

      if (!eof && index === source.length) return { pending: true }
      return { index, newline }
    }

    const readStringLiteral = (start) => {
      const quote = source[start]
      if (quote !== '"' && quote !== "'") return null
      for (let index = start + 1; index < source.length; index++) {
        if (source[index] === quote) return index + 1
        if (isLineBreak(source[index])) return 'invalid'
        if (source[index] === '\\') {
          index++
          if (source[index] === '\r' && source[index + 1] === '\n') index++
        }
      }
      return eof ? 'invalid' : 'pending'
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
      if (next.pending) return { kind: 'pending' }
      if (next.invalid) return { kind: 'invalid' }
      const { index, newline } = next
      const ch = source[index]
      if (ch === undefined) return { kind: 'eof', index }
      if (ch === ';') return { kind: 'semicolon', index }
      if (ch === '}') return { kind: 'right-brace', index }

      if (!eof && newline) {
        const remainder = source.slice(index)
        if (
          remainder === '+' ||
          remainder === '-' ||
          remainder === '!' ||
          'in'.startsWith(remainder) ||
          'instanceof'.startsWith(remainder)
        ) {
          return { kind: 'pending' }
        }
        if (remainder === 'in' || remainder === 'instanceof') {
          return { kind: 'pending' }
        }
      }

      const pair = source.slice(index, index + 2)
      let kind = 'other'
      if (pair === '++' || pair === '--') {
        kind = newline ? 'other' : 'continuation'
      } else if (ch === '!') {
        if (source[index + 1] === '=') kind = 'continuation'
      } else if (pair === '=>') {
        kind = 'other'
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
      if (literalEnd === 'pending') return 'pending'
      if (literalEnd === 'invalid') return 'invalid'
      if (literalEnd === null) return null
      const token = scanAfterLiteral(literalEnd)
      if (token.kind === 'pending') return 'pending'
      if (token.kind === 'invalid') return 'invalid'
      if (token.kind === 'continuation') return null
      if (token.kind === 'semicolon') {
        return { literalEnd, statementEnd: token.index + 1 }
      }
      if (token.kind === 'eof' || token.kind === 'right-brace' || token.newline) {
        return { literalEnd, statementEnd: literalEnd }
      }
      return null
    }

    let index = 0
    while (true) {
      const next = skipTrivia(index)
      if (next.pending) return pending
      if (next.invalid) return invalid
      if (next.index >= source.length) {
        return { insertionOffset: next.index }
      }
      const statement = expressionStatement(next.index)
      if (statement === 'pending') return pending
      if (statement === 'invalid') return invalid
      if (!statement) return { insertionOffset: next.index }
      index = statement.statementEnd
    }
  }

  webhid.export('parseWorkerSource', parseWorkerSource)
})()
