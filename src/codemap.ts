import dagre from '@dagrejs/dagre'
import type { CodeMap, FolderEntry, FunctionEntry } from '../shared/types'
import { NODE_W, type Pt } from './layout'

export const FUNCTIONS_SHOWN = 8
export const FOLDER_H = 72
export const FILE_BASE_H = 46
export const FN_ROW_H = 30
export const FILE_NOTE_H = 20

export type Counts = { files: number; functions: number }

export type CodeNodeData =
  | { kind: 'folder'; name: string; path: string; counts: Counts }
  | { kind: 'codefile'; name: string; path: string; functions: FunctionEntry[] }

export type CodeNode = { id: string; data: CodeNodeData; height: number }

export type Crumb = { label: string; path: string }

export function baseName(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}

export function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

export function folderIndex(map: CodeMap): Map<string, FolderEntry> {
  return new Map(map.folders.map((f) => [f.path, f]))
}

export function subtreeCounts(index: Map<string, FolderEntry>, path: string): Counts {
  const queue = [path]
  const seen = new Set(queue)
  let files = 0
  let functions = 0

  while (queue.length > 0) {
    const entry = index.get(queue.shift() as string)
    if (!entry) continue
    for (const file of entry.files) {
      files += 1
      functions += file.functions.length
    }
    for (const child of entry.folders) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }

  return { files, functions }
}

export function heightOf(data: CodeNodeData): number {
  if (data.kind === 'folder') return FOLDER_H
  const shown = Math.min(data.functions.length, FUNCTIONS_SHOWN)
  const note = data.functions.length === 0 || data.functions.length > FUNCTIONS_SHOWN ? FILE_NOTE_H : 0
  return FILE_BASE_H + shown * FN_ROW_H + note
}

export function worldNodes(index: Map<string, FolderEntry>, path: string): CodeNode[] {
  const entry = index.get(path)
  if (!entry) return []

  const folders: CodeNodeData[] = entry.folders.map((child) => ({
    kind: 'folder',
    name: baseName(child),
    path: child,
    counts: subtreeCounts(index, child)
  }))

  const files: CodeNodeData[] = entry.files.map((file) => ({
    kind: 'codefile',
    name: baseName(file.path),
    path: file.path,
    functions: file.functions
  }))

  return [...folders, ...files].map((data) => ({ id: `${data.kind}:${data.path}`, data, height: heightOf(data) }))
}

export function crumbs(rootLabel: string, path: string): Crumb[] {
  const trail: Crumb[] = [{ label: rootLabel, path: '' }]
  let walked = ''
  for (const segment of path.split('/').filter(Boolean)) {
    walked = walked === '' ? segment : `${walked}/${segment}`
    trail.push({ label: segment, path: walked })
  }
  return trail
}

export function columnsFor(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(count)))
}

export function codePositions(nodes: CodeNode[]): Map<string, Pt> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', ranksep: 44, nodesep: 30, marginx: 40, marginy: 40 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: n.height })

  // column-chains
  const columns = columnsFor(nodes.length)
  for (const [i, n] of nodes.entries()) {
    const above = nodes[i - columns]
    if (above) g.setEdge(above.id, n.id)
  }

  dagre.layout(g)

  return new Map(
    nodes.map((n) => {
      const at = g.node(n.id)
      return [n.id, { x: at.x - NODE_W / 2, y: at.y - n.height / 2 }]
    })
  )
}
