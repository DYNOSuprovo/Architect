import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { ReactFlow, Background, Controls, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { CodeMap } from '../shared/types'
import {
  codePositions,
  folderIndex,
  worldNodes,
  FUNCTIONS_SHOWN,
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

function card(kind: string, picked: boolean) {
  return picked ? `node code-node ${kind} picked` : `node code-node ${kind}`
}

function dots() {
  return getComputedStyle(document.documentElement).getPropertyValue('--dots').trim()
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

const nodeTypes = { folder: FolderNode, codefile: FileNode }

export default function CodeCanvas({ map, path, theme, onEnter, onUp }: CodeCanvasProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const color = useMemo(() => dots(), [theme])

  const nodes = useMemo(() => {
    const logical = worldNodes(folderIndex(map), path)
    const at = codePositions(logical)

    return logical.map<Node<CodeNodeData>>((n) => ({
      id: n.id,
      type: n.data.kind,
      draggable: false,
      deletable: false,
      position: at.get(n.id) ?? { x: 0, y: 0 },
      style: { height: n.height },
      data: n.data
    }))
  }, [map, path])

  useEffect(() => setSelectedId(null), [path])

  const selected = nodes.find((n) => n.id === selectedId)?.data ?? null

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
        <ReactFlow
          key={path}
          nodes={nodes}
          edges={[]}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          zoomOnDoubleClick={false}
          fitView
          fitViewOptions={{ padding: 0.14 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_event, node) => setSelectedId(node.id)}
          onNodeDoubleClick={(_event, node) => {
            if (node.data.kind === 'folder') onEnter(node.data.path)
          }}
          onPaneClick={close}
        >
          <Background gap={26} size={1} color={color} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </Picked.Provider>
      {nodes.length === 0 && <div className="empty-state code-empty">This folder is empty</div>}
      {selected && <CodeInspector key={selectedId} node={selected} onClose={close} />}
    </div>
  )
}
