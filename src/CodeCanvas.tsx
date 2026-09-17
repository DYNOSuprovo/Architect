import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  type Edge,
  type Node,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { CodeMap } from '../shared/types'
import {
  callPositions,
  codePositions,
  fileIndex,
  fnNodeId,
  folderIndex,
  functionEdges,
  functionNodes,
  hiddenLines,
  widthOf,
  worldNodes,
  FUNCTIONS_SHOWN,
  SOURCE_LINES_SHOWN,
  type CodeNode,
  type CodeNodeData
} from './codemap'
import { CodeInspector } from './Inspector'

type CodeCanvasProps = {
  map: CodeMap
  path: string
  theme: string
  onEnter: (path: string) => void
  onUp: () => void
}

const Picked = createContext<string | null>(null)
const Sources = createContext<Map<string, string> | null>(null)

function card(kind: string, picked: boolean) {
  return picked ? `node code-node ${kind} picked` : `node code-node ${kind}`
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function plural(n: number, one: string) {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

function FolderNode({ id, data }: NodeProps<Node<CodeNodeData>>) {
  const className = card('code-folder', useContext(Picked) === id)
  if (data.kind !== 'folder') return null
  return (
    <div className={className}>
      <div className="node-head">
        <span className="node-id">{data.name}</span>
        <span className="node-role">folder</span>
      </div>
      <div className="code-counts">
        {plural(data.counts.files, 'file')} · {plural(data.counts.functions, 'function')}
      </div>
      <div className="code-hint">double-click to open</div>
    </div>
  )
}

function FileNode({ id, data }: NodeProps<Node<CodeNodeData>>) {
  const className = card('code-file', useContext(Picked) === id)
  if (data.kind !== 'codefile') return null
  const shown = data.functions.slice(0, FUNCTIONS_SHOWN)
  const hidden = data.functions.length - shown.length

  return (
    <div className={className}>
      <div className="node-head">
        <span className="node-id">{data.name}</span>
        <span className="node-role">file</span>
      </div>
      {data.functions.length === 0 ? (
        <div className="code-note">no functions</div>
      ) : (
        <div className="code-fns">
          {shown.map((fn, i) => (
            <div key={`${i}:${fn.name}`} className="code-fn">
              <span className="code-fn-name">{fn.name}</span>
              {fn.description !== '' && <span className="code-fn-desc">{fn.description}</span>}
            </div>
          ))}
        </div>
      )}
      {hidden > 0 && <div className="code-note">+{hidden} more</div>}
    </div>
  )
}

function Source({ id, from, to }: { id: string; from: number; to: number }) {
  const loaded = useContext(Sources)
  if (!loaded) return <div className="code-src code-src-idle">loading source…</div>

  const text = loaded.get(id) ?? ''
  if (text === '') return <div className="code-src code-src-idle">source unavailable</div>

  const lines = text.replace(/\n$/, '').split('\n')
  const shown = lines.slice(0, SOURCE_LINES_SHOWN)
  const hidden = hiddenLines({ line: from, endLine: to }, shown.length)

  return (
    <>
      <pre className="code-src">
        {shown.map((line, i) => (
          <div key={i} className="code-src-line">
            <span className="code-src-no">{from + i}</span>
            <span className="code-src-text">{line === '' ? ' ' : line}</span>
          </div>
        ))}
      </pre>
      {hidden > 0 && <div className="code-note">+{hidden} more lines</div>}
    </>
  )
}

function FunctionNode({ id, data }: NodeProps<Node<CodeNodeData>>) {
  const className = card('code-fnnode', useContext(Picked) === id)
  if (data.kind !== 'codefn') return null

  return (
    <div className={className}>
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
      <div className="node-head">
        <span className="node-id code-fn-name">{data.name}</span>
        <span className="node-role">
          {data.line}–{data.endLine}
        </span>
      </div>
      {data.description !== '' && <div className="code-fn-desc code-fn-lead">{data.description}</div>}
      <Source id={id} from={data.line} to={data.endLine} />
    </div>
  )
}

const nodeTypes = { folder: FolderNode, codefile: FileNode, codefn: FunctionNode }

function toFlow(logical: CodeNode[], at: Map<string, { x: number; y: number }>): Node<CodeNodeData>[] {
  return logical.map((n) => ({
    id: n.id,
    type: n.data.kind,
    draggable: false,
    deletable: false,
    position: at.get(n.id) ?? { x: 0, y: 0 },
    style: { width: widthOf(n.data), height: n.height },
    data: n.data
  }))
}

export default function CodeCanvas({ map, path, theme, onEnter, onUp }: CodeCanvasProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sources, setSources] = useState<Map<string, string> | null>(null)

  const colors = useMemo(() => ({ dots: cssVar('--dots'), ink: cssVar('--ink') }), [theme])

  const file = useMemo(() => fileIndex(map).get(path) ?? null, [map, path])

  const world = useMemo(() => {
    if (file) {
      const logical = functionNodes(file)
      const links = functionEdges(file)
      return { nodes: toFlow(logical, callPositions(logical, links)), links }
    }
    const logical = worldNodes(folderIndex(map), path)
    return { nodes: toFlow(logical, codePositions(logical)), links: [] }
  }, [map, path, file])

  const edges = useMemo<Edge[]>(
    () =>
      world.links.map((l) => ({
        id: l.id,
        source: l.source,
        target: l.target,
        markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: colors.ink },
        style: { stroke: colors.ink, strokeWidth: 1.4 }
      })),
    [world, colors]
  )

  useEffect(() => {
    setSources(null)
    if (!file) return
    let live = true
    Promise.all(
      file.functions.map((fn) =>
        window.architect.readSource(map.root, file.path, fn.line, fn.endLine).catch(() => '')
      )
    ).then((texts) => {
      if (!live) return
      setSources(new Map(file.functions.map((fn, i) => [fnNodeId(file.path, i, fn.name), texts[i] ?? ''])))
    })
    return () => {
      live = false
    }
  }, [map.root, file])

  useEffect(() => setSelectedId(null), [path])

  const selected = world.nodes.find((n) => n.id === selectedId)?.data ?? null

  const close = useCallback(() => setSelectedId(null), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (selectedId) setSelectedId(null)
      else onUp()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, onUp])

  return (
    <div className="canvas-stage">
      <Picked.Provider value={selectedId}>
        <Sources.Provider value={sources}>
          <ReactFlow
            key={path}
            nodes={world.nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            zoomOnDoubleClick={false}
            fitView
            fitViewOptions={{ padding: 0.14 }}
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_event, node) => setSelectedId(node.id)}
            onNodeDoubleClick={(_event, node) => {
              if (node.data.kind !== 'codefn') onEnter(node.data.path)
            }}
            onPaneClick={close}
          >
            <Background gap={26} size={1} color={colors.dots} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </Sources.Provider>
      </Picked.Provider>
      {world.nodes.length === 0 && (
        <div className="empty-state code-empty">{file ? 'This file has no functions' : 'This folder is empty'}</div>
      )}
      {selected && (
        <CodeInspector
          key={selectedId}
          node={selected}
          source={selectedId === null ? null : (sources?.get(selectedId) ?? null)}
          onClose={close}
        />
      )}
    </div>
  )
}
