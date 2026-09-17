import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scan } from './scan'
import type { CodeMap, FolderEntry } from '../shared/types'

const roots: string[] = []

function fixture(files: Record<string, string>, dirs: string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-scan-'))
  roots.push(root)

  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true })

  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }

  return root
}

function folder(map: CodeMap, at: string): FolderEntry {
  const found = map.folders.find((f) => f.path === at)
  if (!found) throw new Error(`missing folder: ${at}`)
  return found
}

function names(map: CodeMap, file: string): string[] {
  const at = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
  const entry = folder(map, at).files.find((f) => f.path === file)
  if (!entry) throw new Error(`missing file: ${file}`)
  return entry.functions.map((f) => f.name)
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('scan', () => {
  it('returns the root folder with an empty path', async () => {
    const map = await scan(fixture({ 'a.ts': 'export const x = 1\n' }))

    expect(map.folders.map((f) => f.path)).toEqual([''])
    expect(folder(map, '').files.map((f) => f.path)).toEqual(['a.ts'])
  })

  it('flattens every folder for O(1) lookup', async () => {
    const map = await scan(fixture({ 'src/deep/nested/a.ts': '', 'src/b.ts': '' }))

    expect(map.folders.map((f) => f.path)).toEqual(['', 'src', 'src/deep', 'src/deep/nested'])
    expect(folder(map, 'src').folders).toEqual(['src/deep'])
    expect(folder(map, 'src').files.map((f) => f.path)).toEqual(['src/b.ts'])
    expect(folder(map, 'src/deep/nested').files.map((f) => f.path)).toEqual(['src/deep/nested/a.ts'])
  })

  it('keeps empty folders and files without functions', async () => {
    const map = await scan(fixture({ 'notes.ts': 'export const n = 1\n' }, ['empty', 'empty/deeper']))

    expect(folder(map, 'empty').files).toEqual([])
    expect(folder(map, 'empty').folders).toEqual(['empty/deeper'])
    expect(folder(map, 'empty/deeper').folders).toEqual([])
    expect(names(map, 'notes.ts')).toEqual([])
  })

  it('skips ignored and dot directories', async () => {
    const map = await scan(
      fixture({
        'node_modules/pkg/i.ts': 'export function nope() {}',
        'dist/o.js': 'function nope() {}',
        'out/o.js': 'function nope() {}',
        'build/o.js': 'function nope() {}',
        '.git/hooks/h.js': 'function nope() {}',
        '.architect/a.ts': 'function nope() {}',
        '.claude/c.ts': 'function nope() {}',
        '.secret/s.ts': 'function nope() {}',
        'src/keep.ts': 'export function keep() {}',
      }),
    )

    expect(map.folders.map((f) => f.path)).toEqual(['', 'src'])
    expect(names(map, 'src/keep.ts')).toEqual(['keep'])
  })

  it('skips binary files', async () => {
    const root = fixture({ 'a.ts': 'export function a() {}' })
    fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))

    const map = await scan(root)

    expect(folder(map, '').files.map((f) => f.path)).toEqual(['a.ts'])
  })

  it('lists non-parsed text files with no functions', async () => {
    const map = await scan(fixture({ 'readme.md': '# hi\n\nfunction fake() {}\n', 'a.ts': '' }))

    expect(names(map, 'readme.md')).toEqual([])
  })

  it('finds function declarations including nested and default', async () => {
    const map = await scan(
      fixture({
        'a.ts': [
          'export function top() {',
          '  function inner() {}',
          '  return inner',
          '}',
          'function* gen() {}',
          'async function load() {}',
          'async function* streamed() {}',
        ].join('\n'),
        'b.ts': 'export default function () {}',
        'c.ts': 'export default function named() {}',
      }),
    )

    expect(names(map, 'a.ts')).toEqual(['top', 'inner', 'gen', 'load', 'streamed'])
    expect(names(map, 'b.ts')).toEqual(['default'])
    expect(names(map, 'c.ts')).toEqual(['named'])
  })

  it('finds functions bound to variables', async () => {
    const map = await scan(
      fixture({
        'a.ts': [
          'const arrow = () => {}',
          'let expr = function () {}',
          'var named = function inner() {}',
          'const asyncArrow = async () => {}',
          'const genExpr = function* () {}',
          'const notAFunction = 4',
        ].join('\n'),
      }),
    )

    expect(names(map, 'a.ts')).toEqual(['arrow', 'expr', 'named', 'asyncArrow', 'genExpr'])
  })

  it('names class members after their class', async () => {
    const map = await scan(
      fixture({
        'a.ts': [
          'export class Store {',
          '  constructor() {}',
          '  save() {}',
          '  async load() {}',
          '  *walk() {}',
          '  get size() { return 0 }',
          '  set size(v: number) {}',
          '  bound = () => {}',
          '  static make() {}',
          '  #hidden() {}',
          '}',
          'const Anon = class {',
          '  run() {}',
          '}',
        ].join('\n'),
      }),
    )

    expect(names(map, 'a.ts')).toEqual([
      'Store.constructor',
      'Store.save',
      'Store.load',
      'Store.walk',
      'Store.size',
      'Store.size',
      'Store.bound',
      'Store.make',
      'Store.#hidden',
      'Anon.run',
    ])
  })

  it('names object literal methods and function properties', async () => {
    const map = await scan(
      fixture({
        'a.ts': [
          'export const api = {',
          '  get() {},',
          '  async post() {},',
          '  del: () => {},',
          "  'quoted': function () {},",
          '  [Symbol.iterator]: function () {},',
          '  plain: 3,',
          '}',
        ].join('\n'),
      }),
    )

    expect(names(map, 'a.ts')).toEqual(['api.get', 'api.post', 'api.del', 'api.quoted'])
  })

  it('reports 1-indexed declaration lines', async () => {
    const map = await scan(fixture({ 'a.ts': '\n\nexport function third() {}\n\nconst fifth = () => {}\n' }))

    const entry = folder(map, '').files[0]
    expect(entry?.functions).toEqual([
      { name: 'third', line: 3, description: '' },
      { name: 'fifth', line: 5, description: '' },
    ])
  })

  it('parses every supported extension', async () => {
    const map = await scan(
      fixture({
        'a.tsx': 'export const View = () => <div />',
        'b.jsx': 'export function View() { return <div /> }',
        'c.mjs': 'export function m() {}',
        'd.cjs': 'function c() {}',
        'e.js': 'const j = function () {}',
      }),
    )

    expect(names(map, 'a.tsx')).toEqual(['View'])
    expect(names(map, 'b.jsx')).toEqual(['View'])
    expect(names(map, 'c.mjs')).toEqual(['m'])
    expect(names(map, 'd.cjs')).toEqual(['c'])
    expect(names(map, 'e.js')).toEqual(['j'])
  })

  it('does not throw on broken files', async () => {
    const map = await scan(
      fixture({
        'broken.ts': 'export function ((( {{{ unterminated',
        'ok.ts': 'export function ok() {}',
      }),
    )

    expect(folder(map, '').files.map((f) => f.path)).toEqual(['broken.ts', 'ok.ts'])
    expect(names(map, 'ok.ts')).toEqual(['ok'])
  })

  it('handles an empty file', async () => {
    const map = await scan(fixture({ 'empty.ts': '' }))

    expect(names(map, 'empty.ts')).toEqual([])
  })

  it('lists no functions for ambient declaration files', async () => {
    const map = await scan(fixture({ 'types.d.ts': 'export declare function ambient(): void\n' }))

    expect(names(map, 'types.d.ts')).toEqual([])
  })

  it('skips build and asset directories', async () => {
    const map = await scan(
      fixture({
        'a.ts': 'export function a() {}',
        'coverage/c.ts': 'export function c() {}',
        'public/p.ts': 'export function p() {}',
        'vendor/v.ts': 'export function v() {}',
        '.next/n.ts': 'export function n() {}',
      }),
    )

    expect(map.folders.map((f) => f.path)).toEqual([''])
    expect(folder(map, '').files.map((f) => f.path)).toEqual(['a.ts'])
  })

  it('yields to the event loop while walking', async () => {
    const files: Record<string, string> = {}
    for (let n = 0; n < 120; n++) files[`f${n}.ts`] = `export function f${n}() {}`

    let ticks = 0
    let ticking = true
    const tick = () => {
      if (!ticking) return
      ticks += 1
      setImmediate(tick)
    }
    setImmediate(tick)

    const map = await scan(fixture(files))
    ticking = false

    expect(folder(map, '').files).toHaveLength(120)
    expect(ticks).toBeGreaterThan(0)
  })

  it('is deterministic across repeated scans', async () => {
    const root = fixture({
      'src/b.ts': 'export function b() {}\nexport const a = () => {}',
      'src/a.ts': 'export class C { m() {} }',
      'src/zz/z.ts': 'function z() {}',
      'readme.md': '# hi',
    })

    const first = await scan(root)
    const second = await scan(root)

    expect(first.folders).toEqual(second.folders)
    expect(first.root).toBe(root)
  })
})
