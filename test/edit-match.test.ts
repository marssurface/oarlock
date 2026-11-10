import assert from 'node:assert/strict'
import test from 'node:test'
import { replacePlan, resolveEdit, shiftIndent } from '../src/core/edit-match.ts'

test('exact matches win and report a usable span', () => {
  const plan = resolveEdit('const a = 1\n', 'a = 1')
  assert.equal(plan.fuzzy, false)
  assert.equal(plan.count, 1)
  assert.equal(plan.start, 6)
  assert.equal(plan.end, 11)

  const duplicate = resolveEdit('a a a', 'a')
  assert.equal(duplicate.count, 3)
  assert.equal(duplicate.fuzzy, false)
  assert.equal(duplicate.start, undefined)

  // Exact hits short-circuit the fallback: a fuzzy-identical copy elsewhere
  // does not make the edit ambiguous.
  const text = 'const x = 1;\n    const  x = 1;\n'
  const exact = resolveEdit(text, 'const x = 1;')
  assert.equal(exact.count, 1)
  assert.equal(exact.fuzzy, false)
})

test('empty, missing and too-short snippets refuse before fuzzy', () => {
  assert.equal(resolveEdit('abc', '').reason, 'empty')
  assert.equal(resolveEdit('abc', 'zzz').reason, 'too-short')
  assert.equal(resolveEdit('abc', 'zzz').count, 0)
  const longMissing = resolveEdit('abc', 'nothing like this exists')
  assert.equal(longMissing.reason, 'not-found')
})

test('whitespace-tolerant fallback matches whole lines and shifted indentation', () => {
  const file = 'function foo() {\n    if (x) {\n        return true\n    }\n}\n'
  const oldString = 'if (x) {\n    return true\n}'
  const plan = resolveEdit(file, oldString)
  assert.equal(plan.fuzzy, true)
  assert.equal(plan.count, 1)
  assert.ok(plan.start !== undefined && plan.end !== undefined)
  assert.deepEqual(plan.indent, { uniform: { mode: 'add', text: '    ' } })

  const next = replacePlan(file, plan, 'if (x) {\n  return false\n}')
  assert.equal(
    next,
    'function foo() {\n    if (x) {\n      return false\n    }\n}\n',
    'replacement lines follow the file indentation',
  )
})

test('per-line deltas keep each line when the snippet mixes indentation levels', () => {
  const file = 'outer() {\n  const alpha = 1\n      const beta = 2\n}\n'
  const plan = resolveEdit(file, 'const alpha = 1\nconst beta = 2')
  assert.equal(plan.fuzzy, true)
  assert.deepEqual(plan.indent?.uniform, { mode: 'add', text: '  ' })
  assert.deepEqual(plan.indent?.lines, [
    { mode: 'add', text: '  ' },
    { mode: 'add', text: '      ' },
  ])

  // Same line count: every line keeps its own delta, so a replacement written
  // with flat indentation lands at the file's real indentation.
  assert.equal(
    replacePlan(file, plan, 'const alpha = 3\nconst beta = 4'),
    'outer() {\n  const alpha = 3\n      const beta = 4\n}\n',
  )
  // Different line count: fall back to the uniform delta rather than guess.
  assert.equal(replacePlan(file, plan, 'one\ntwo\nthree'), 'outer() {\n  one\n  two\n  three\n}\n')
})

test('trailing whitespace and CRLF line endings normalize without losing CRLF', () => {
  const file = 'alpha value \r\nbeta line\r\ngamma line\r\n'
  const oldString = 'alpha value\nbeta line\ngamma line\n'
  const plan = resolveEdit(file, oldString)
  assert.equal(plan.fuzzy, true)
  assert.equal(plan.count, 1)

  const next = replacePlan(file, plan, 'A\nB\nC')
  assert.equal(next, 'A\r\nB\r\nC\r\n')
})

test('interior whitespace differences are not fuzzy-equal', () => {
  const file = 'const x = 1;\n'
  const plan = resolveEdit(file, 'const  x = 1;')
  assert.equal(plan.count, 0)
  assert.equal(plan.fuzzy, false)
  assert.equal(plan.reason, 'not-found')
})

test('a short snippet never matches inside a longer line', () => {
  const file = 'const value = target\n'
  const plan = resolveEdit(file, '    value = target')
  assert.equal(plan.count, 0, 'fuzzy matching must start and end at line boundaries')
})

test('fuzzy ambiguity reports every candidate and refuses to guess', () => {
  const file = 'if (x) {\n  a\n}\nif (x) {\n    a\n}\n'
  const plan = resolveEdit(file, 'if (x) {\n a\n}')
  assert.equal(plan.fuzzy, true)
  assert.equal(plan.count, 2)
  assert.equal(plan.start, undefined)
})

test('mixed or tab-vs-space indentation is not force-adjusted', () => {
  const file = '\tconst total = 1\n'
  const plan = resolveEdit(file, '    const total = 1')
  assert.equal(plan.fuzzy, true)
  assert.equal(plan.count, 1)
  assert.equal(plan.indent, undefined, 'tab vs space is left to new_string')
})

test('shiftIndent only touches non-blank lines', () => {
  assert.equal(shiftIndent('a\n\n  b', { mode: 'add', text: '  ' }), '  a\n\n    b')
  assert.equal(shiftIndent('  a\n    b', { mode: 'remove', text: '  ' }), 'a\n  b')
})
