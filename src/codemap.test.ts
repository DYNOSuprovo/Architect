import { describe, expect, it } from 'vitest'
import type { CodeMap, FolderEntry, FunctionEntry } from '../shared/types'
import {
  baseName,
  codePositions,
  columnsFor,
  crumbs,
  folderIndex,
  heightOf,
  parentOf,
  subtreeCounts,
  worldNodes,
  FILE_BASE_H,
  FILE_NOTE_H,
  FN_ROW_H,
  FOLDER_H,
  FUNCTIONS_SHOWN,
  type CodeNode
} from './codemap'
import { NODE_W } from './layout'

function fns(count: number): FunctionEntry[] {
  return Array.from({ length: count }, (_, i) => ({ name: `fn${i}`, line: i + 1, description: '' }))
}

function map(folders: FolderEntry[]): CodeMap {
  return { root: '/repo', scannedAt: 0, folders }
}

const tree = map([
  { path: '', folders: ['src', 'mcp'], files: [{ path: 'index.ts', functions: fns(1) }] },
  { path: 'src', folders: ['src/ui'], files: [{ path: 'src/app.ts', functions: fns(3) }] },
  { path: 'src/ui', folders: [], files: [{ path: 'src/ui/Button.tsx', functions: fns(2) }] },
  { path: 'mcp', folders: [], files: [] }
])

describe('paths', () => {
  it('takes the last segment as a name', () => {
    expect(baseName('src/ui/Button.tsx')).toBe('Button.tsx')
    expect(baseName('src')).toBe('src')
    expect(baseName('')).toBe('')
  })

  it('walks one level up, stopping at the root', () => {
    expect(parentOf('src/ui/panels')).toBe('src/ui')
    expect(parentOf('src')).toBe('')
    expect(parentOf('')).toBe('')
  })
})

describe('folderIndex', () => {
  it('looks a folder up by path without walking', () => {
    const index = folderIndex(tree)
    expect(index.get('src/ui')?.files).toHaveLength(1)
    expect(index.get('')?.folders).toEqual(['src', 'mcp'])
    expect(index.get('nope')).toBeUndefined()
  })
})

describe('subtreeCounts', () => {
  const index = folderIndex(tree)

  it('counts the whole subtree, not the immediate children', () => {
    expect(subtreeCounts(index, '')).toEqual({ files: 3, functions: 6 })
    expect(subtreeCounts(index, 'src')).toEqual({ files: 2, functions: 5 })
    expect(subtreeCounts(index, 'src/ui')).toEqual({ files: 1, functions: 2 })
  })

  it('is zero for an empty folder and for an unknown path', () => {
    expect(subtreeCounts(index, 'mcp')).toEqual({ files: 0, functions: 0 })
    expect(subtreeCounts(index, 'ghost')).toEqual({ files: 0, functions: 0 })
  })

  it('terminates on a folder graph that points back at itself', () => {
    const cyclic = folderIndex(
      map([
        { path: 'a', folders: ['b'], files: [{ path: 'a/one.ts', functions: fns(1) }] },
        { path: 'b', folders: ['a'], files: [{ path: 'b/two.ts', functions: fns(2) }] }
      ])
    )
    expect(subtreeCounts(cyclic, 'a')).toEqual({ files: 2, functions: 3 })
  })
})

describe('heightOf', () => {
  it('is fixed for a folder', () => {
    expect(heightOf({ kind: 'folder', name: 'src', path: 'src', counts: { files: 1, functions: 1 } })).toBe(FOLDER_H)
  })

  it('grows one row per function', () => {
    const at = (count: number) => heightOf({ kind: 'codefile', name: 'a.ts', path: 'a.ts', functions: fns(count) })
    expect(at(1)).toBe(FILE_BASE_H + FN_ROW_H)
    expect(at(4)).toBe(FILE_BASE_H + 4 * FN_ROW_H)
    expect(at(FUNCTIONS_SHOWN)).toBe(FILE_BASE_H + FUNCTIONS_SHOWN * FN_ROW_H)
  })

  it('caps the rows and adds one note line past the cap', () => {
    const at = (count: number) => heightOf({ kind: 'codefile', name: 'a.ts', path: 'a.ts', functions: fns(count) })
    expect(at(FUNCTIONS_SHOWN + 1)).toBe(FILE_BASE_H + FUNCTIONS_SHOWN * FN_ROW_H + FILE_NOTE_H)
    expect(at(40)).toBe(at(FUNCTIONS_SHOWN + 1))
  })

  it('leaves room for the empty note when there are no functions', () => {
    expect(heightOf({ kind: 'codefile', name: 'a.ts', path: 'a.ts', functions: [] })).toBe(FILE_BASE_H + FILE_NOTE_H)
  })

  it('does not change when a description is empty', () => {
    const described = heightOf({
      kind: 'codefile',
      name: 'a.ts',
      path: 'a.ts',
      functions: [{ name: 'run', line: 1, description: 'Does the thing.' }]
    })
    const bare = heightOf({
      kind: 'codefile',
      name: 'a.ts',
      path: 'a.ts',
      functions: [{ name: 'run', line: 1, description: '' }]
    })
    expect(bare).toBe(described)
  })
})

describe('worldNodes', () => {
  const index = folderIndex(tree)

  it('lists immediate folders before immediate files', () => {
    const nodes = worldNodes(index, '')
    expect(nodes.map((n) => n.data.kind)).toEqual(['folder', 'folder', 'codefile'])
    expect(nodes.map((n) => n.data.name)).toEqual(['src', 'mcp', 'index.ts'])
  })

  it('carries subtree counts on folder nodes', () => {
    const src = worldNodes(index, '')[0]
    expect(src?.data.kind === 'folder' && src.data.counts).toEqual({ files: 2, functions: 5 })
  })

  it('gives every node a unique id and its own height', () => {
    const nodes = worldNodes(index, 'src')
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length)
    expect(nodes.every((n) => n.height === heightOf(n.data))).toBe(true)
  })

  it('is empty for a folder that is not in the map', () => {
    expect(worldNodes(index, 'ghost')).toEqual([])
  })
})

describe('crumbs', () => {
  it('starts at the root and adds one clickable segment per level', () => {
    expect(crumbs('Architect', 'src/ui/panels')).toEqual([
      { label: 'Architect', path: '' },
      { label: 'src', path: 'src' },
      { label: 'ui', path: 'src/ui' },
      { label: 'panels', path: 'src/ui/panels' }
    ])
  })

  it('is just the root at the top level', () => {
    expect(crumbs('Architect', '')).toEqual([{ label: 'Architect', path: '' }])
  })
})

describe('codePositions', () => {
  const nodes = (heights: number[]): CodeNode[] =>
    heights.map((height, i) => ({
      id: `n${i}`,
      data: { kind: 'codefile', name: `n${i}`, path: `n${i}`, functions: [] },
      height
    }))

  it('places every node', () => {
    const at = codePositions(nodes([60, 200, 90, 300, 60]))
    expect(at.size).toBe(5)
  })

  it('is empty for an empty world', () => {
    expect(codePositions([]).size).toBe(0)
  })

  it('never overlaps two cards of very different heights', () => {
    const list = nodes([60, 400, 90, 320, 70, 500, 120, 80, 260])
    const at = codePositions(list)
    const boxes = list.map((n) => {
      const p = at.get(n.id) ?? { x: 0, y: 0 }
      return { x: p.x, y: p.y, w: NODE_W, h: n.height }
    })

    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
        expect(apart).toBe(true)
      }
    }
  })
})

describe('columnsFor', () => {
  it('keeps the world roughly square', () => {
    expect(columnsFor(0)).toBe(1)
    expect(columnsFor(1)).toBe(1)
    expect(columnsFor(4)).toBe(2)
    expect(columnsFor(5)).toBe(3)
    expect(columnsFor(9)).toBe(3)
  })
})
