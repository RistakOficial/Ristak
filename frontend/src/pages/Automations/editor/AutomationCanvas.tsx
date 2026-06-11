import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { cn } from '@/utils/cn'
import type {
  AutomationEdge,
  AutomationNode,
  AutomationViewport
} from '@/services/automationsService'
import { AutomationNodeCard, type NodeHandleLayout } from './AutomationNodeCard'
import { canConnect, edgePath, MAX_ZOOM, MIN_ZOOM, NODE_WIDTH } from './flowUtils'
import styles from './AutomationEditor.module.css'

export interface PickerRequest {
  /** Posición del globo relativa al contenedor del editor (px de pantalla) */
  anchor: { x: number; y: number }
  /** Punto del canvas (coordenadas del mundo) donde crear el nodo */
  worldPoint: { x: number; y: number }
  /** Conexión pendiente si el globo se abrió desde una salida */
  source?: { nodeId: string; handle: string }
}

/** Conexión pendiente mientras el selector está abierto tras soltar en el fondo */
export interface PendingEdge {
  source: { nodeId: string; handle: string }
  point: { x: number; y: number }
}

export interface CanvasActions {
  onSelectNode: (nodeId: string | null) => void
  onSelectEdge: (edgeId: string | null) => void
  onMoveNode: (nodeId: string, position: { x: number; y: number }, commit: boolean) => void
  onConnect: (sourceNodeId: string, sourceHandle: string, targetNodeId: string) => void
  onInvalidConnection: (reason: string) => void
  onDeleteEdge: (edgeId: string) => void
  onDeleteNode: (node: AutomationNode) => void
  onDuplicateNode: (node: AutomationNode) => void
  onOpenConfig: (node: AutomationNode, anchor: { x: number; y: number }) => void
  onRequestPicker: (request: PickerRequest) => void
  onAddTrigger: (node: AutomationNode, anchor: { x: number; y: number }) => void
  onEditTrigger: (node: AutomationNode, triggerId: string, anchor: { x: number; y: number }) => void
  onRemoveTrigger: (node: AutomationNode, triggerId: string) => void
  onViewportChange: (viewport: AutomationViewport) => void
}

interface AutomationCanvasProps {
  nodes: AutomationNode[]
  edges: AutomationEdge[]
  selectedNodeId: string | null
  selectedEdgeId: string | null
  nodeErrors: Record<string, string[]>
  initialViewport: AutomationViewport
  /** Flecha fantasma hacia el punto donde se soltó el conector */
  pendingEdge?: PendingEdge | null
  actions: CanvasActions
  children?: React.ReactNode
}

/** ¿El evento ocurrió dentro de un contenedor interactivo (globos, inputs…)? */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest?.('[data-automation-interactive="true"]'))
}

interface DragState {
  nodeId: string
  pointerStart: { x: number; y: number }
  nodeStart: { x: number; y: number }
  moved: boolean
}

interface ConnectionDraft {
  sourceNodeId: string
  sourceHandle: string
  from: { x: number; y: number }
  to: { x: number; y: number }
  moved: boolean
  hoveredNodeId: string | null
}

const layoutsEqual = (a: NodeHandleLayout | undefined, b: NodeHandleLayout): boolean => {
  if (!a) return false
  if (Math.abs(a.width - b.width) > 0.5 || Math.abs(a.height - b.height) > 0.5) return false
  if (Math.abs(a.inputY - b.inputY) > 0.5) return false
  const aKeys = Object.keys(a.outputs)
  const bKeys = Object.keys(b.outputs)
  if (aKeys.length !== bKeys.length) return false
  return bKeys.every((key) => Math.abs((a.outputs[key] ?? -1) - b.outputs[key]) <= 0.5)
}

export const AutomationCanvas: React.FC<AutomationCanvasProps> = ({
  nodes,
  edges,
  selectedNodeId,
  selectedEdgeId,
  nodeErrors,
  initialViewport,
  pendingEdge,
  actions,
  children
}) => {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<AutomationViewport>(initialViewport)
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport

  const [panning, setPanning] = useState(false)
  const panStateRef = useRef<{ pointer: { x: number; y: number }; pan: { x: number; y: number } } | null>(null)

  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef(drag)
  dragRef.current = drag

  const [draft, setDraft] = useState<ConnectionDraft | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft

  const [layouts, setLayouts] = useState<Record<string, NodeHandleLayout>>({})
  const layoutsRef = useRef(layouts)
  layoutsRef.current = layouts

  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const edgesRef = useRef(edges)
  edgesRef.current = edges

  const setAndReportViewport = useCallback(
    (next: AutomationViewport) => {
      setViewport(next)
      actions.onViewportChange(next)
    },
    [actions]
  )

  const clientToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect()
    const { x, y, zoom } = viewportRef.current
    return {
      x: (clientX - (rect?.left || 0) - x) / zoom,
      y: (clientY - (rect?.top || 0) - y) / zoom
    }
  }, [])

  const clientToEditor = useCallback((clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect()
    return { x: clientX - (rect?.left || 0), y: clientY - (rect?.top || 0) }
  }, [])

  const getBounds = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect()
    return { width: rect?.width || 800, height: rect?.height || 600 }
  }, [])

  const handleMeasure = useCallback((nodeId: string, layout: NodeHandleLayout) => {
    if (layoutsEqual(layoutsRef.current[nodeId], layout)) return
    setLayouts((current) => ({ ...current, [nodeId]: layout }))
  }, [])

  // ------------------------------------------------------------------
  // Zoom con rueda / pinch (listener nativo: React registra wheel pasivo)
  // ------------------------------------------------------------------
  useEffect(() => {
    const element = wrapRef.current
    if (!element) return

    const handleWheel = (event: WheelEvent) => {
      // El scroll dentro de globos, selectores e inputs es scroll interno:
      // el canvas no se mueve ni hace zoom.
      if (isInteractiveTarget(event.target)) return

      event.preventDefault()
      const { x, y, zoom } = viewportRef.current

      if (event.ctrlKey || event.metaKey) {
        // Pinch o Ctrl+rueda: zoom hacia el cursor
        const rect = element.getBoundingClientRect()
        const cursorX = event.clientX - rect.left
        const cursorY = event.clientY - rect.top
        const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * (1 - event.deltaY * 0.01)))
        const worldX = (cursorX - x) / zoom
        const worldY = (cursorY - y) / zoom
        setAndReportViewport({
          x: Math.round(cursorX - worldX * nextZoom),
          y: Math.round(cursorY - worldY * nextZoom),
          zoom: nextZoom
        })
      } else {
        // Desplazamiento con dos dedos / rueda: pan (redondeado para nitidez)
        setAndReportViewport({ x: Math.round(x - event.deltaX), y: Math.round(y - event.deltaY), zoom })
      }
    }

    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [setAndReportViewport])

  // ------------------------------------------------------------------
  // Interacciones globales (pan, arrastre de nodos, conexión)
  // ------------------------------------------------------------------
  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const panState = panStateRef.current
      if (panState) {
        // Redondeado a píxeles enteros: evita texto borroso durante el pan
        setViewport({
          x: Math.round(panState.pan.x + (event.clientX - panState.pointer.x)),
          y: Math.round(panState.pan.y + (event.clientY - panState.pointer.y)),
          zoom: viewportRef.current.zoom
        })
        return
      }

      const currentDrag = dragRef.current
      if (currentDrag) {
        const zoom = viewportRef.current.zoom
        const dx = (event.clientX - currentDrag.pointerStart.x) / zoom
        const dy = (event.clientY - currentDrag.pointerStart.y) / zoom
        const moved = currentDrag.moved || Math.abs(dx) > 2 || Math.abs(dy) > 2
        if (moved !== currentDrag.moved) {
          setDrag({ ...currentDrag, moved })
          dragRef.current = { ...currentDrag, moved }
        }
        actions.onMoveNode(
          currentDrag.nodeId,
          { x: Math.round(currentDrag.nodeStart.x + dx), y: Math.round(currentDrag.nodeStart.y + dy) },
          false
        )
        return
      }

      const currentDraft = draftRef.current
      if (currentDraft) {
        const world = clientToWorld(event.clientX, event.clientY)
        const element = document.elementFromPoint(event.clientX, event.clientY)
        const nodeElement = element?.closest('[data-automation-node]') as HTMLElement | null
        const hoveredNodeId = nodeElement?.dataset.automationNode || null
        setDraft({
          ...currentDraft,
          to: world,
          moved:
            currentDraft.moved ||
            Math.hypot(world.x - currentDraft.from.x, world.y - currentDraft.from.y) > 8,
          hoveredNodeId: hoveredNodeId === currentDraft.sourceNodeId ? null : hoveredNodeId
        })
      }
    }

    const handleUp = (event: PointerEvent) => {
      if (panStateRef.current) {
        panStateRef.current = null
        setPanning(false)
        actions.onViewportChange(viewportRef.current)
        return
      }

      const currentDrag = dragRef.current
      if (currentDrag) {
        setDrag(null)
        if (currentDrag.moved) {
          const node = nodesRef.current.find((candidate) => candidate.id === currentDrag.nodeId)
          if (node) actions.onMoveNode(currentDrag.nodeId, node.position, true)
        }
        return
      }

      const currentDraft = draftRef.current
      if (currentDraft) {
        setDraft(null)
        const { sourceNodeId, sourceHandle, hoveredNodeId, moved } = currentDraft

        if (hoveredNodeId) {
          const check = canConnect(nodesRef.current, edgesRef.current, sourceNodeId, sourceHandle, hoveredNodeId)
          if (check.valid) {
            actions.onConnect(sourceNodeId, sourceHandle, hoveredNodeId)
          } else if (check.reason) {
            actions.onInvalidConnection(check.reason)
          }
          return
        }

        // Soltar en el fondo (o clic simple): abrir el globo "Siguiente paso"
        const editorPoint = clientToEditor(event.clientX, event.clientY)
        const worldPoint = moved
          ? clientToWorld(event.clientX, event.clientY)
          : (() => {
              const source = nodesRef.current.find((candidate) => candidate.id === sourceNodeId)
              return source
                ? { x: source.position.x + NODE_WIDTH + 140, y: source.position.y }
                : clientToWorld(event.clientX, event.clientY)
            })()
        actions.onRequestPicker({
          anchor: { x: editorPoint.x + 10, y: editorPoint.y - 20 },
          worldPoint,
          source: { nodeId: sourceNodeId, handle: sourceHandle }
        })
      }
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [actions, clientToEditor, clientToWorld])

  // ------------------------------------------------------------------
  // Handlers de la superficie
  // ------------------------------------------------------------------
  const handleCanvasPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) return
    if (isInteractiveTarget(event.target)) return
    actions.onSelectNode(null)
    actions.onSelectEdge(null)
    panStateRef.current = {
      pointer: { x: event.clientX, y: event.clientY },
      pan: { x: viewportRef.current.x, y: viewportRef.current.y }
    }
    setPanning(true)
  }

  const handleCanvasDoubleClick = (event: React.MouseEvent) => {
    const editorPoint = clientToEditor(event.clientX, event.clientY)
    const worldPoint = clientToWorld(event.clientX, event.clientY)
    actions.onRequestPicker({ anchor: editorPoint, worldPoint })
  }

  // Un clic selecciona; mantener y arrastrar mueve el nodo. Los elementos
  // interactivos internos (botones, inputs, conectores) nunca inician drag.
  const handleNodeCardPointerDown = (event: React.PointerEvent, node: AutomationNode) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (
      target?.closest(
        'button, input, textarea, select, [data-handle-out], [data-handle-in], [data-automation-interactive="true"]'
      )
    ) {
      return
    }
    setDrag({
      nodeId: node.id,
      pointerStart: { x: event.clientX, y: event.clientY },
      nodeStart: { ...node.position },
      moved: false
    })
  }

  const handleStartConnection = (event: React.PointerEvent, node: AutomationNode, handleId: string) => {
    const layout = layoutsRef.current[node.id]
    const from = {
      x: node.position.x + (layout?.width || NODE_WIDTH),
      y: node.position.y + (layout?.outputs[handleId] ?? 40)
    }
    setDraft({
      sourceNodeId: node.id,
      sourceHandle: handleId,
      from,
      to: clientToWorld(event.clientX, event.clientY),
      moved: false,
      hoveredNodeId: null
    })
  }

  // ------------------------------------------------------------------
  // Controles de zoom
  // ------------------------------------------------------------------
  const zoomBy = (factor: number) => {
    const bounds = getBounds()
    const { x, y, zoom } = viewportRef.current
    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor))
    const centerX = bounds.width / 2
    const centerY = bounds.height / 2
    const worldX = (centerX - x) / zoom
    const worldY = (centerY - y) / zoom
    setAndReportViewport({
      x: Math.round(centerX - worldX * nextZoom),
      y: Math.round(centerY - worldY * nextZoom),
      zoom: nextZoom
    })
  }

  const fitView = useCallback(() => {
    if (nodesRef.current.length === 0) return
    const bounds = getBounds()
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    nodesRef.current.forEach((node) => {
      const layout = layoutsRef.current[node.id]
      minX = Math.min(minX, node.position.x)
      minY = Math.min(minY, node.position.y)
      maxX = Math.max(maxX, node.position.x + (layout?.width || NODE_WIDTH))
      maxY = Math.max(maxY, node.position.y + (layout?.height || 160))
    })
    const padding = 70
    const width = Math.max(1, maxX - minX)
    const height = Math.max(1, maxY - minY)
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((bounds.width - padding * 2) / width, (bounds.height - padding * 2) / height, 1))
    )
    setAndReportViewport({
      x: Math.round((bounds.width - width * zoom) / 2 - minX * zoom),
      y: Math.round((bounds.height - height * zoom) / 2 - minY * zoom),
      zoom
    })
  }, [getBounds, setAndReportViewport])

  // ------------------------------------------------------------------
  // Geometría de las conexiones
  // ------------------------------------------------------------------
  const edgeGeometries = useMemo(() => {
    return edges
      .map((edge) => {
        const source = nodes.find((node) => node.id === edge.sourceNodeId)
        const target = nodes.find((node) => node.id === edge.targetNodeId)
        if (!source || !target) return null
        const sourceLayout = layouts[source.id]
        const targetLayout = layouts[target.id]
        const sx = source.position.x + (sourceLayout?.width || NODE_WIDTH)
        const sy = source.position.y + (sourceLayout?.outputs[edge.sourceHandle || 'out'] ?? 40)
        const tx = target.position.x
        const ty = target.position.y + (targetLayout?.inputY ?? 24)
        return { edge, geometry: edgePath(sx, sy, tx, ty) }
      })
      .filter((item): item is { edge: AutomationEdge; geometry: ReturnType<typeof edgePath> } => Boolean(item))
  }, [edges, nodes, layouts])

  const connectedOutputsByNode = useMemo(() => {
    const map = new Map<string, Set<string>>()
    edges.forEach((edge) => {
      const set = map.get(edge.sourceNodeId) || new Set<string>()
      set.add(edge.sourceHandle || 'out')
      map.set(edge.sourceNodeId, set)
    })
    return map
  }, [edges])

  const emptyOutputs = useMemo(() => new Set<string>(), [])

  const draftGeometry = draft ? edgePath(draft.from.x, draft.from.y, draft.to.x, draft.to.y) : null

  // Flecha fantasma: del conector de origen al punto exacto donde se soltó,
  // visible mientras el selector de pasos está abierto.
  const pendingGeometry = useMemo(() => {
    if (!pendingEdge) return null
    const source = nodes.find((node) => node.id === pendingEdge.source.nodeId)
    if (!source) return null
    const layout = layouts[source.id]
    const sx = source.position.x + (layout?.width || NODE_WIDTH)
    const sy = source.position.y + (layout?.outputs[pendingEdge.source.handle] ?? 40)
    return edgePath(sx, sy, pendingEdge.point.x, pendingEdge.point.y)
  }, [pendingEdge, nodes, layouts])

  const dropStateFor = (node: AutomationNode): 'target' | 'forbidden' | null => {
    if (!draft || !draft.hoveredNodeId || draft.hoveredNodeId !== node.id) return null
    const check = canConnect(nodes, edges, draft.sourceNodeId, draft.sourceHandle, node.id)
    return check.valid ? 'target' : 'forbidden'
  }

  return (
    <div ref={wrapRef} data-automation-canvas-wrap className={styles.canvasWrap}>
      <div
        className={cn(styles.canvas, panning && styles.canvasPanning, draft && styles.canvasConnecting)}
        style={{
          backgroundSize: `${22 * viewport.zoom}px ${22 * viewport.zoom}px`,
          backgroundPosition: `${viewport.x}px ${viewport.y}px`
        }}
        onPointerDown={handleCanvasPointerDown}
        onDoubleClick={handleCanvasDoubleClick}
      >
        <div
          className={styles.canvasInner}
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}
        >
          <svg className={styles.edgesSvg}>
            <defs>
              <marker
                id="automation-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 8 5 L 0 9" fill="none" stroke="rgba(100,116,139,0.9)" strokeWidth="1.6" strokeLinecap="round" />
              </marker>
            </defs>

            {edgeGeometries.map(({ edge, geometry }) => (
              <g
                key={edge.id}
                className={cn(styles.edgeGroup, selectedEdgeId === edge.id && styles.edgeSelected)}
              >
                <path
                  className={styles.edgeHit}
                  d={geometry.path}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    actions.onSelectEdge(edge.id)
                  }}
                />
                <path
                  className={styles.edgePath}
                  d={geometry.path}
                  markerEnd="url(#automation-arrow)"
                />
                {edge.label && (
                  <text className={styles.edgeLabel} x={geometry.midX} y={geometry.midY - 8} textAnchor="middle">
                    {edge.label}
                  </text>
                )}
                <g
                  className={styles.edgeDelete}
                  transform={`translate(${geometry.midX}, ${geometry.midY})`}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    actions.onDeleteEdge(edge.id)
                  }}
                >
                  <title>Eliminar conexión</title>
                  <circle className={styles.edgeDeleteCircle} r="9" />
                  <path className={styles.edgeDeleteX} d="M -3 -3 L 3 3 M 3 -3 L -3 3" />
                </g>
              </g>
            ))}

            {draftGeometry && <path className={styles.edgeDraft} d={draftGeometry.path} markerEnd="url(#automation-arrow)" />}

            {pendingGeometry && pendingEdge && (
              <g>
                <path className={styles.edgeDraft} d={pendingGeometry.path} markerEnd="url(#automation-arrow)" />
                <circle
                  className={styles.pendingTargetDot}
                  cx={pendingEdge.point.x}
                  cy={pendingEdge.point.y}
                  r="7"
                />
              </g>
            )}
          </svg>

          {nodes.map((node) => (
            <AutomationNodeCard
              key={node.id}
              node={node}
              selected={selectedNodeId === node.id}
              dragging={drag?.nodeId === node.id && drag.moved}
              errors={nodeErrors[node.id]}
              dropState={dropStateFor(node)}
              connectedOutputs={connectedOutputsByNode.get(node.id) || emptyOutputs}
              zoom={viewport.zoom}
              onMeasure={handleMeasure}
              onPointerDownCard={handleNodeCardPointerDown}
              onSelect={(selected) => actions.onSelectNode(selected.id)}
              onOpenConfig={(target) => {
                const layout = layoutsRef.current[target.id]
                const { x, y, zoom } = viewportRef.current
                actions.onOpenConfig(target, {
                  x: (target.position.x + (layout?.width || NODE_WIDTH)) * zoom + x + 14,
                  y: target.position.y * zoom + y
                })
              }}
              onDuplicate={actions.onDuplicateNode}
              onDelete={actions.onDeleteNode}
              onStartConnection={handleStartConnection}
              onAddTrigger={(target, rect) => {
                const editorPoint = clientToEditor(rect.right, rect.top)
                actions.onAddTrigger(target, { x: editorPoint.x + 16, y: editorPoint.y - 40 })
              }}
              onEditTrigger={(target, triggerId, rect) => {
                const editorPoint = clientToEditor(rect.right, rect.top)
                actions.onEditTrigger(target, triggerId, { x: editorPoint.x + 16, y: editorPoint.y - 40 })
              }}
              onRemoveTrigger={actions.onRemoveTrigger}
            />
          ))}
        </div>

        {/* Controles de zoom */}
        <div className={styles.zoomControls} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
          <button type="button" className={styles.zoomButton} title="Acercar" onClick={() => zoomBy(1.2)}>
            <Plus size={14} />
          </button>
          <span className={styles.zoomLevel}>{Math.round(viewport.zoom * 100)}%</span>
          <button type="button" className={styles.zoomButton} title="Alejar" onClick={() => zoomBy(1 / 1.2)}>
            <Minus size={14} />
          </button>
          <button type="button" className={styles.zoomButton} title="Centrar flujo" onClick={fitView}>
            <Maximize size={13} />
          </button>
        </div>

        {children}
      </div>
    </div>
  )
}
