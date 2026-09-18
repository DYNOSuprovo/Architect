import { describe, expect, it } from 'vitest'
import type { Architecture } from '../shared/types'
import {
  build,
  clampInspectorWidth,
  dependency,
  HANDLE_IN,
  HANDLE_OUT,
  folderName,
  heightOf,
  positions,
  roleOf,
  statusOf,
  NODE_BADGES_H,
  NODE_BASE_H,
  NODE_PURPOSE_H,
  NODE_W,
  INSPECTOR_MAX_W,
  INSPECTOR_MIN_W,
  INSPECTOR_SHARE,
  INSPECTOR_W,
  type NodeData
} from './layout'

function architecture(components: string[], edges: [string, string][]): Architecture {
  return {
    title: 'Test',
    summary: '',
    components: components.map((id) => ({ id, purpose: '', owns: [] })),
    edges: edges.map(([from, to]) => ({ from, to })),
    forbidden: [],
    packages: []
  }
}

function layout(a: Architecture) {
  const { nodes, links } = build(a, [])
  return positions(nodes, links)
}

describe('roleOf', () => {
  const a = architecture(['ui', 'api', 'db'], [
    ['ui', 'api'],
    ['api', 'db']
  ])

  it('calls a component nothing depends on an entry', () => {
    expect(roleOf('ui', a.edges)).toBe('entry')
  })

  it('calls a component that depends on nothing a foundation', () => {
    expect(roleOf('db', a.edges)).toBe('foundation')
  })

  it('leaves everything between unlabelled', () => {
    expect(roleOf('api', a.edges)).toBe('middle')
  })

  it('treats a component with no edges at all as an entry', () => {
    expect(roleOf('alone', [])).toBe('entry')
  })
})

describe('folderName', () => {
  it('uses the last path segment', () => {
    expect(folderName('/Users/x/repo/reporter/bot')).toBe('bot')
  })

  it('ignores a trailing separator', () => {
    expect(folderName('/Users/x/repo/reporter/bot/')).toBe('bot')
  })

  it('handles windows separators', () => {
    expect(folderName('C:\\Users\\x\\bot')).toBe('bot')
  })

  it('falls back to the root itself when there is no segment', () => {
    expect(folderName('/')).toBe('/')
  })
})

describe('statusOf', () => {
  const data = (over: Partial<NodeData>): NodeData => ({
    kind: 'component',
    label: 'a',
    purpose: '',
    owns: [],
    ghost: false,
    role: 'middle',
    badges: [],
    ...over
  })

  it('reports the role of a drawn component', () => {
    expect(statusOf(data({ role: 'entry' }))).toBe('entry')
  })

  it('reports a ghost as proposed', () => {
    expect(statusOf(data({ ghost: true }))).toBe('proposed')
  })

  it('reports an unowned file proposal as having no owner', () => {
    expect(statusOf(data({ kind: 'file', ghost: true, unassigned: true }))).toBe('no owner')
  })
})

describe('ranking', () => {
  it('puts a dependency one rank below its dependent instead of at the deepest rank', () => {
    const a = architecture(['ui', 'api', 'db', 'worker'], [
      ['ui', 'api'],
      ['api', 'db'],
      ['worker', 'db']
    ])

    const at = layout(a)
    expect(at.get('worker')!.y).toBe(at.get('api')!.y)
    expect(at.get('worker')!.y).toBeGreaterThan(at.get('ui')!.y)
  })

  it('lets a shallow foundation sit directly under the thing that needs it', () => {
    const a = architecture(['ui', 'api', 'db', 'config'], [
      ['ui', 'api'],
      ['ui', 'config'],
      ['api', 'db']
    ])

    const at = layout(a)
    expect(at.get('config')!.y).toBe(at.get('api')!.y)
    expect(at.get('config')!.y).toBeLessThan(at.get('db')!.y)
  })

  it('never stretches an edge across more than one gap in a plain chain', () => {
    const a = architecture(['ui', 'api', 'db', 'worker'], [
      ['ui', 'api'],
      ['api', 'db'],
      ['worker', 'db']
    ])

    const at = layout(a)
    const rows = [...new Set([...at.values()].map((p) => p.y))].sort((x, y) => x - y)
    const rank = (id: string) => rows.indexOf(at.get(id)!.y)
    for (const [from, to] of [['ui', 'api'], ['api', 'db'], ['worker', 'db']] as [string, string][]) {
      expect(rank(to) - rank(from)).toBe(1)
    }
  })

  it('keeps entries above the components that depend on them', () => {
    const a = architecture(['ui', 'api', 'db'], [
      ['ui', 'api'],
      ['api', 'db']
    ])

    const at = layout(a)
    expect(at.get('ui')!.y).toBeLessThan(at.get('api')!.y)
    expect(at.get('api')!.y).toBeLessThan(at.get('db')!.y)
  })

  it('starts the top rank at zero so every project opens at the same offset', () => {
    const a = architecture(['ui', 'api'], [['ui', 'api']])
    expect(layout(a).get('ui')!.y).toBe(0)
  })

  it('lays out an architecture with no components without throwing', () => {
    expect(layout(architecture([], [])).size).toBe(0)
  })

  it('lays out a cycle without throwing', () => {
    const a = architecture(['a', 'b'], [
      ['a', 'b'],
      ['b', 'a']
    ])
    expect(layout(a).size).toBe(2)
  })

  it('is deterministic: the same architecture lays out identically twice', () => {
    const a = architecture(['ui', 'api', 'db', 'worker'], [
      ['ui', 'api'],
      ['api', 'db'],
      ['worker', 'db']
    ])

    expect([...layout(a).entries()]).toEqual([...layout(a).entries()])
  })
})

describe('heightOf', () => {
  const data = (over: Partial<NodeData>): NodeData => ({
    kind: 'component',
    label: 'a',
    purpose: '',
    owns: [],
    ghost: false,
    role: 'middle',
    badges: [],
    ...over
  })

  it('is just the head when there is nothing else to draw', () => {
    expect(heightOf(data({}))).toBe(NODE_BASE_H)
  })

  it('adds one clamped purpose block however long the purpose is', () => {
    const short = heightOf(data({ purpose: 'hi' }))
    expect(short).toBe(NODE_BASE_H + NODE_PURPOSE_H)
    expect(heightOf(data({ purpose: 'word '.repeat(400) }))).toBe(short)
  })

  it('adds one badge row however many badges there are', () => {
    const one = heightOf(data({ badges: ['zod'] }))
    expect(one).toBe(NODE_BASE_H + NODE_BADGES_H)
    expect(heightOf(data({ badges: ['zod', 'pg', 'express', 'chokidar'] }))).toBe(one)
  })

  it('ignores owns, which the card no longer draws', () => {
    expect(heightOf(data({ owns: ['src/**', 'migrations/*.sql'] }))).toBe(NODE_BASE_H)
  })

  it('stays under the function card it sits beside', () => {
    expect(heightOf(data({ purpose: 'p', badges: ['zod'] }))).toBeLessThan(NODE_W)
  })
})

describe('reserved geometry', () => {
  it('reserves exactly the card each node renders', () => {
    const a: Architecture = {
      title: 'T',
      summary: '',
      forbidden: [],
      packages: [],
      components: [
        { id: 'ui', purpose: 'draws', owns: ['src/ui/**'] },
        { id: 'db', purpose: '', owns: [] }
      ],
      edges: [{ from: 'ui', to: 'db' }]
    }

    const { nodes, links } = build(a, [
      {
        id: 'p1',
        projectRoot: '/r',
        proposal: { kind: 'package', name: 'zod', component: 'ui' },
        rationale: '',
        createdAt: 0
      }
    ])
    const at = positions(nodes, links)
    const ui = nodes.find((n) => n.id === 'ui')!
    const db = nodes.find((n) => n.id === 'db')!

    expect(heightOf(ui.data)).toBe(NODE_BASE_H + NODE_PURPOSE_H + NODE_BADGES_H)
    expect(heightOf(db.data)).toBe(NODE_BASE_H)
    expect(at.get('db')!.y - (at.get('ui')!.y + heightOf(ui.data))).toBeGreaterThan(0)
  })

  it('leaves no node overlapping another', () => {
    const a = architecture(['ui', 'cli', 'api', 'auth', 'db', 'cache', 'log'], [
      ['ui', 'api'],
      ['cli', 'api'],
      ['ui', 'auth'],
      ['api', 'db'],
      ['auth', 'db'],
      ['api', 'cache'],
      ['db', 'log'],
      ['cache', 'log']
    ])

    const { nodes, links } = build(a, [])
    const boxes = nodes.map((n) => {
      const p = positions(nodes, links).get(n.id)!
      return { x0: p.x, x1: p.x + NODE_W, y0: p.y, y1: p.y + heightOf(n.data) }
    })

    for (const [i, b] of boxes.entries()) {
      for (const c of boxes.slice(i + 1)) {
        expect(b.x1 <= c.x0 || c.x1 <= b.x0 || b.y1 <= c.y0 || c.y1 <= b.y0).toBe(true)
      }
    }
  })
})

describe('clampInspectorWidth', () => {
  it('keeps a width the user picked', () => {
    expect(clampInspectorWidth(640, 1600)).toBe(640)
  })

  it('holds the bounds at both ends', () => {
    expect(clampInspectorWidth(0, 1600)).toBe(INSPECTOR_MIN_W)
    expect(clampInspectorWidth(-9000, 1600)).toBe(INSPECTOR_MIN_W)
    expect(clampInspectorWidth(9000, 4000)).toBe(INSPECTOR_MAX_W)
  })

  it('never takes the whole canvas', () => {
    for (const stage of [200, 420, 1000, 2400]) {
      expect(clampInspectorWidth(9000, stage)).toBeLessThanOrEqual(stage * INSPECTOR_SHARE)
      expect(clampInspectorWidth(300, stage)).toBeLessThanOrEqual(stage * INSPECTOR_SHARE)
    }
    expect(clampInspectorWidth(9000, 1000)).toBe(1000 * INSPECTOR_SHARE)
  })

  it('gives up its minimum before it covers a tiny canvas', () => {
    expect(clampInspectorWidth(9000, 200)).toBe(140)
    expect(clampInspectorWidth(10, 200)).toBe(140)
  })

  it('falls back to the default on a value storage cannot give back', () => {
    expect(clampInspectorWidth(NaN, 1600)).toBe(INSPECTOR_W)
    expect(clampInspectorWidth(Number('abc'), 1600)).toBe(INSPECTOR_W)
    expect(clampInspectorWidth(Infinity, 1600)).toBe(INSPECTOR_W)
    expect(clampInspectorWidth(NaN, 600)).toBe(clampInspectorWidth(INSPECTOR_W, 600))
    expect(clampInspectorWidth(NaN, 200)).toBe(140)
  })

  it('rounds to a whole pixel', () => {
    expect(clampInspectorWidth(640.4, 1600)).toBe(640)
    expect(Number.isInteger(clampInspectorWidth(512.7, 1600))).toBe(true)
  })

  it('survives a viewport it cannot measure', () => {
    expect(clampInspectorWidth(9000, NaN)).toBe(INSPECTOR_MAX_W)
  })
})

describe('dependency', () => {
  it('reads a top-down drag as source depends on target', () => {
    const link = dependency({ source: 'ui', target: 'api', sourceHandle: HANDLE_OUT, targetHandle: HANDLE_IN })
    expect(link).toEqual({ from: 'ui', to: 'api' })
  })

  it('flips a bottom-up drag so the dependency is not reversed', () => {
    const link = dependency({ source: 'api', target: 'ui', sourceHandle: HANDLE_IN, targetHandle: HANDLE_OUT })
    expect(link).toEqual({ from: 'ui', to: 'api' })
  })

  it('refuses an ambiguous pair of matching handles', () => {
    expect(dependency({ source: 'a', target: 'b', sourceHandle: HANDLE_OUT, targetHandle: HANDLE_OUT })).toBeNull()
    expect(dependency({ source: 'a', target: 'b', sourceHandle: HANDLE_IN, targetHandle: HANDLE_IN })).toBeNull()
  })

  it('refuses a drag with no handle identity', () => {
    expect(dependency({ source: 'a', target: 'b', sourceHandle: null, targetHandle: null })).toBeNull()
  })
})
