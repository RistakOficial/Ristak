import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  Clock3,
  Copy,
  GitBranch,
  LayoutGrid,
  MoreHorizontal,
  Shuffle,
  StickyNote,
  Target,
  Maximize,
  Minus,
  Plus,
  StretchHorizontal,
  StretchVertical,
  Trash2,
  X
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { WhatsAppIcon, MessengerIcon, InstagramIcon } from './BrandIcons'
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

/** Sugerencias de la tarjeta "Elegir primer paso" (automatización vacía) */
const FIRST_STEP_CONTENT = [
  { type: 'channel-whatsapp', label: 'WhatsApp', icon: WhatsAppIcon, color: '#25D366' },
  { type: 'channel-messenger', label: 'Messenger', icon: MessengerIcon, color: '#0084FF' },
  { type: 'channel-instagram', label: 'Instagram', icon: InstagramIcon, color: '#E4405F' }
]

const FIRST_STEP_LOGIC = [
  { type: 'logic-condition', label: 'Condición', icon: GitBranch, color: '#8b5cf6' },
  { type: 'logic-wait', label: 'Esperar', icon: Clock3, color: '#f59e0b' },
  { type: 'randomizer', label: 'Aleatorizador', icon: Shuffle, color: '#6366f1' },
  { type: 'logic-goal', label: 'Evento objetivo', icon: Target, color: '#10b981' }
]

export interface CanvasActions {
  onSelectNode: (nodeId: string | null) => void
  /** Shift/Cmd + clic sobre un nodo alterna su selección */
  onToggleSelect: (nodeId: string) => void
  /** Selección por caja (Shift + arrastrar) */
  onMarqueeSelect: (nodeIds: string[]) => void
  onSelectEdge: (edgeId: string | null) => void
  onMoveNode: (nodeId: string, position: { x: number; y: number }, commit: boolean) => void
  /** Mueve un grupo de nodos seleccionados a la vez */
  onMoveNodes: (positions: Record<string, { x: number; y: number }>, commit: boolean) => void
  onConnect: (sourceNodeId: string, sourceHandle: string, targetNodeId: string) => void
  onInvalidConnection: (reason: string) => void
  /** Crea el primer paso desde la tarjeta fantasma de bienvenida */
  onCreateFirstStep?: (type: string, position: { x: number; y: number }) => void
  onDeleteEdge: (edgeId: string) => void
  onDeleteNode: (node: AutomationNode) => void
  onDuplicateNode: (node: AutomationNode) => void
  /** Alt + arrastrar: duplica el paso y devuelve la copia para arrastrarla */
  onDuplicateNodeForDrag: (node: AutomationNode) => AutomationNode | null
  onOpenConfig: (node: AutomationNode, anchor: { x: number; y: number }) => void
  onPatchConfig: (node: AutomationNode, patch: Record<string, unknown>, openConfig?: boolean) => void
  onRequestPicker: (request: PickerRequest) => void
  onAddTrigger: (node: AutomationNode, anchor: { x: number; y: number }) => void
  onEditTrigger: (node: AutomationNode, triggerId: string, anchor: { x: number; y: number }) => void
  onRemoveTrigger: (node: AutomationNode, triggerId: string) => void
  onViewportChange: (viewport: AutomationViewport) => void
  /** Barra contextual de selección múltiple */
  onDeleteSelected: () => void
  onDuplicateSelected: () => void
  onAlignSelected: (axis: 'horizontal' | 'vertical') => void
  onDistributeSelected: (axis: 'horizontal' | 'vertical') => void
  onClearSelection: () => void
  /** Botón "Ordenar flujo" (recibe las alturas medidas de los nodos) */
  onAutoLayout: (heights: Record<string, number>) => void
  /** Crea un post-it en el centro visible del canvas */
  onAddStickyNote: (position: { x: number; y: number }) => void
}

interface AutomationCanvasProps {
  nodes: AutomationNode[]
  edges: AutomationEdge[]
  selectedNodeId: string | null
  /** Selección múltiple (incluye al nodo primario cuando hay varios) */
  multiSelectedIds: Set<string>
  selectedEdgeId: string | null
  nodeErrors: Record<string, string[]>
  initialViewport: AutomationViewport
  /** Flecha fantasma hacia el punto donde se soltó el conector */
  pendingEdge?: PendingEdge | null
  /** Incrementa para centrar el flujo desde fuera (tras ordenar) */
  fitSignal?: number
  /** Contactos activos por nodo (badges con silueta) */
  nodeStats?: Record<string, number>
  /** Oculta la tarjeta "Elegir primer paso" (cuando el selector está abierto) */
  hideFirstStepGhost?: boolean
  actions: CanvasActions
  children?: React.ReactNode
}

interface DragState {
  nodeId: string
  pointerStart: { x: number; y: number }
  nodeStart: { x: number; y: number }
  /** Posiciones originales del grupo cuando se arrastran varios nodos */
  groupStart: Record<string, { x: number; y: number }> | null
  moved: boolean
  /** Shift/Cmd al iniciar: el clic alterna selección, no abre configuración */
  withModifier: boolean
}

interface ConnectionDraft {
  sourceNodeId: string
  sourceHandle: string
  from: { x: number; y: number }
  to: { x: number; y: number }
  moved: boolean
  hoveredNodeId: string | null
}

interface MarqueeState {
  start: { x: number; y: number }
  end: { x: number; y: number }
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

/** ¿El evento ocurrió dentro de un contenedor interactivo (globos, inputs…)? */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest?.('[data-automation-interactive="true"]'))
}

export const AutomationCanvas: React.FC<AutomationCanvasProps> = ({
  nodes,
  edges,
  selectedNodeId,
  multiSelectedIds,
  selectedEdgeId,
  nodeErrors,
  initialViewport,
  pendingEdge,
  fitSignal,
  nodeStats,
  hideFirstStepGhost,
  actions,
  children
}) => {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<AutomationViewport>(initialViewport)
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport

  const [panning, setPanning] = useState(false)
  const panStateRef = useRef<{
    pointer: { x: number; y: number }
    pan: { x: number; y: number }
    moved: boolean
  } | null>(null)

  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef(drag)
  dragRef.current = drag

  const [draft, setDraft] = useState<ConnectionDraft | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft

  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  const marqueeRef = useRef(marquee)
  marqueeRef.current = marquee

  const [layouts, setLayouts] = useState<Record<string, NodeHandleLayout>>({})
  const layoutsRef = useRef(layouts)
  layoutsRef.current = layouts

  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const edgesRef = useRef(edges)
  edgesRef.current = edges
  const multiSelectedRef = useRef(multiSelectedIds)
  multiSelectedRef.current = multiSelectedIds

  const setAndReportViewport = useCallback(
    (next: AutomationViewport) => {
      viewportRef.current = next
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
  // Interacciones globales (pan, marquee, arrastre de nodos, conexión)
  // ------------------------------------------------------------------
  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const panState = panStateRef.current
      if (panState) {
        // Redondeado a píxeles enteros: evita texto borroso durante el pan
        const dx = event.clientX - panState.pointer.x
        const dy = event.clientY - panState.pointer.y
        const moved = panState.moved || Math.hypot(dx, dy) > 3
        if (moved !== panState.moved) {
          panStateRef.current = { ...panState, moved }
        }
        setAndReportViewport({
          x: Math.round(panState.pan.x + dx),
          y: Math.round(panState.pan.y + dy),
          zoom: viewportRef.current.zoom
        })
        return
      }

      const currentMarquee = marqueeRef.current
      if (currentMarquee) {
        setMarquee({ ...currentMarquee, end: clientToWorld(event.clientX, event.clientY) })
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
        if (currentDrag.groupStart) {
          // Arrastre de grupo: todos los nodos seleccionados se mueven juntos
          const positions: Record<string, { x: number; y: number }> = {}
          Object.entries(currentDrag.groupStart).forEach(([nodeId, start]) => {
            positions[nodeId] = { x: Math.round(start.x + dx), y: Math.round(start.y + dy) }
          })
          actions.onMoveNodes(positions, false)
        } else {
          actions.onMoveNode(
            currentDrag.nodeId,
            { x: Math.round(currentDrag.nodeStart.x + dx), y: Math.round(currentDrag.nodeStart.y + dy) },
            false
          )
        }
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
        const panState = panStateRef.current
        panStateRef.current = null
        setPanning(false)
        actions.onViewportChange(viewportRef.current)
        if (!panState.moved) {
          actions.onSelectNode(null)
          actions.onSelectEdge(null)
        }
        return
      }

      const currentMarquee = marqueeRef.current
      if (currentMarquee) {
        setMarquee(null)
        const minX = Math.min(currentMarquee.start.x, currentMarquee.end.x)
        const maxX = Math.max(currentMarquee.start.x, currentMarquee.end.x)
        const minY = Math.min(currentMarquee.start.y, currentMarquee.end.y)
        const maxY = Math.max(currentMarquee.start.y, currentMarquee.end.y)
        const hits = nodesRef.current
          .filter((node) => {
            const layout = layoutsRef.current[node.id]
            const width = layout?.width || NODE_WIDTH
            const height = layout?.height || 160
            return (
              node.position.x < maxX &&
              node.position.x + width > minX &&
              node.position.y < maxY &&
              node.position.y + height > minY
            )
          })
          .map((node) => node.id)
        actions.onMarqueeSelect(hits)
        return
      }

      const currentDrag = dragRef.current
      if (currentDrag) {
        setDrag(null)
        if (currentDrag.moved) {
          if (currentDrag.groupStart) {
            const positions: Record<string, { x: number; y: number }> = {}
            Object.keys(currentDrag.groupStart).forEach((nodeId) => {
              const node = nodesRef.current.find((candidate) => candidate.id === nodeId)
              if (node) positions[nodeId] = node.position
            })
            actions.onMoveNodes(positions, true)
          } else {
            const node = nodesRef.current.find((candidate) => candidate.id === currentDrag.nodeId)
            if (node) actions.onMoveNode(currentDrag.nodeId, node.position, true)
          }
        } else if (!currentDrag.withModifier) {
          // Clic simple sobre el evento: abre su configuración junto a la cajita
          const node = nodesRef.current.find((candidate) => candidate.id === currentDrag.nodeId)
          if (node) {
            const layout = layoutsRef.current[node.id]
            const { x, y, zoom } = viewportRef.current
            actions.onOpenConfig(node, {
              x: (node.position.x + (layout?.width || NODE_WIDTH)) * zoom + x + 36,
              y: node.position.y * zoom + y
            })
          }
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
  }, [actions, clientToEditor, clientToWorld, setAndReportViewport])

  // ------------------------------------------------------------------
  // Handlers de la superficie
  // ------------------------------------------------------------------
  const handleCanvasPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) return
    if (isInteractiveTarget(event.target)) return

    // Shift + arrastrar sobre el fondo = caja de selección (sin pan)
    if (event.shiftKey) {
      const start = clientToWorld(event.clientX, event.clientY)
      setMarquee({ start, end: start })
      return
    }

    panStateRef.current = {
      pointer: { x: event.clientX, y: event.clientY },
      pan: { x: viewportRef.current.x, y: viewportRef.current.y },
      moved: false
    }
    setPanning(true)
  }

  const handleCanvasDoubleClick = (event: React.MouseEvent) => {
    const editorPoint = clientToEditor(event.clientX, event.clientY)
    const worldPoint = clientToWorld(event.clientX, event.clientY)
    actions.onRequestPicker({ anchor: editorPoint, worldPoint })
  }

  // Un clic selecciona; mantener y arrastrar mueve el nodo (o el grupo).
  // Los elementos interactivos internos nunca inician drag.
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

    // Alt + arrastrar = duplicar: la copia nace en el mismo punto y es la
    // que se arrastra (el original se queda donde estaba)
    if (event.altKey) {
      const copy = actions.onDuplicateNodeForDrag(node)
      if (copy) {
        setDrag({
          nodeId: copy.id,
          pointerStart: { x: event.clientX, y: event.clientY },
          nodeStart: { ...copy.position },
          groupStart: null,
          moved: false,
          withModifier: true
        })
      }
      return
    }

    const group = multiSelectedRef.current
    const isGroupDrag = group.size > 1 && group.has(node.id)
    const groupStart: Record<string, { x: number; y: number }> | null = isGroupDrag
      ? Object.fromEntries(
          nodesRef.current
            .filter((candidate) => group.has(candidate.id))
            .map((candidate) => [candidate.id, { ...candidate.position }])
        )
      : null

    setDrag({
      nodeId: node.id,
      pointerStart: { x: event.clientX, y: event.clientY },
      nodeStart: { ...node.position },
      groupStart,
      moved: false,
      withModifier: event.shiftKey || event.metaKey || event.ctrlKey
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
  // Controles de zoom + ordenar flujo
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

  // Centrar al recibir la señal externa (después de "Ordenar flujo")
  const lastFitSignal = useRef(fitSignal)
  useEffect(() => {
    if (fitSignal !== undefined && fitSignal !== lastFitSignal.current) {
      lastFitSignal.current = fitSignal
      const timer = window.setTimeout(fitView, 80)
      return () => window.clearTimeout(timer)
    }
  }, [fitSignal, fitView])

  const handleAutoLayout = () => {
    const heights: Record<string, number> = {}
    Object.entries(layoutsRef.current).forEach(([nodeId, layout]) => {
      heights[nodeId] = layout.height
    })
    actions.onAutoLayout(heights)
  }

  const handleAddStickyNote = () => {
    const viewport = viewportRef.current
    const bounds = getBounds()
    actions.onAddStickyNote({
      x: (bounds.width / 2 - viewport.x) / viewport.zoom - NODE_WIDTH / 2,
      y: (bounds.height / 2 - viewport.y) / viewport.zoom - 70
    })
  }

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

  // Tarjeta fantasma "Elegir primer paso": solo en automatizaciones vacías
  const startNodeOnly = nodes.length === 1 && nodes[0].type === 'start' && edges.length === 0 ? nodes[0] : null
  const firstStepGhost = useMemo(() => {
    if (!startNodeOnly || !actions.onCreateFirstStep || hideFirstStepGhost) return null
    const layout = layouts[startNodeOnly.id]
    const sx = startNodeOnly.position.x + (layout?.width || NODE_WIDTH)
    const sy = startNodeOnly.position.y + (layout?.outputs.out ?? 40)
    const x = startNodeOnly.position.x + (layout?.width || NODE_WIDTH) + 190
    const y = startNodeOnly.position.y - 24
    return { x, y, geometry: edgePath(sx, sy, x - 6, y + 34) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startNodeOnly, layouts, hideFirstStepGhost])

  // "Otros": reemplaza la tarjeta fantasma por el selector completo de pasos,
  // conectado a la tarjeta inicial (igual que el globo del doble clic)
  const openFirstStepPicker = () => {
    if (!firstStepGhost || !startNodeOnly) return
    const { x, y, zoom } = viewportRef.current
    actions.onRequestPicker({
      anchor: { x: firstStepGhost.x * zoom + x, y: firstStepGhost.y * zoom + y },
      worldPoint: { x: firstStepGhost.x, y: firstStepGhost.y + 24 },
      source: { nodeId: startNodeOnly.id, handle: 'out' }
    })
  }

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

  // ------------------------------------------------------------------
  // Barra contextual de selección múltiple (sobre el grupo seleccionado)
  // ------------------------------------------------------------------
  const multiToolbar = useMemo(() => {
    if (multiSelectedIds.size < 2) return null
    const selected = nodes.filter((node) => multiSelectedIds.has(node.id))
    if (selected.length < 2) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    selected.forEach((node) => {
      const layout = layouts[node.id]
      minX = Math.min(minX, node.position.x)
      maxX = Math.max(maxX, node.position.x + (layout?.width || NODE_WIDTH))
      minY = Math.min(minY, node.position.y)
    })
    const { x, y, zoom } = viewport
    const screenX = ((minX + maxX) / 2) * zoom + x
    const screenY = minY * zoom + y - 52
    const bounds = getBounds()
    return {
      count: selected.length,
      left: Math.max(180, Math.min(screenX, bounds.width - 180)),
      top: Math.max(12, Math.min(screenY, bounds.height - 60))
    }
  }, [multiSelectedIds, nodes, layouts, viewport, getBounds])

  const marqueeRect = marquee
    ? {
        left: Math.min(marquee.start.x, marquee.end.x),
        top: Math.min(marquee.start.y, marquee.end.y),
        width: Math.abs(marquee.end.x - marquee.start.x),
        height: Math.abs(marquee.end.y - marquee.start.y)
      }
    : null

  return (
    <div ref={wrapRef} data-automation-canvas-wrap className={styles.canvasWrap}>
      <div
        className={cn(styles.canvas, panning && styles.canvasPanning, draft && styles.canvasConnecting)}
        style={{
          // Al alejarse los puntos se desvanecen (en vez de juntarse y ensuciar la vista)
          backgroundImage: `radial-gradient(rgba(148, 163, 184, ${
            (0.16 * Math.min(1, Math.max(0, (viewport.zoom - 0.4) / 0.3))).toFixed(3)
          }) 1px, transparent 1px)`,
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
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                {/* Triángulo relleno */}
                <path d="M 0 0.5 L 9.5 5 L 0 9.5 Z" fill="rgba(100, 116, 139, 0.95)" />
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
            {firstStepGhost && (
              <path className={styles.edgeDraft} d={firstStepGhost.geometry.path} markerEnd="url(#automation-arrow)" />
            )}
          </svg>

          {/* Tarjeta fantasma: primeros pasos sugeridos */}
          {firstStepGhost && (
            <div
              className={styles.firstStepGhost}
              style={{ left: firstStepGhost.x, top: firstStepGhost.y }}
              data-automation-interactive="true"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className={styles.firstStepTitle}>Elegir primer paso 👇</div>
              <div className={styles.firstStepSection}>Contenido</div>
              {FIRST_STEP_CONTENT.map((item) => (
                <button
                  key={item.type}
                  type="button"
                  className={styles.firstStepItem}
                  onClick={() =>
                    actions.onCreateFirstStep?.(item.type, { x: firstStepGhost.x, y: firstStepGhost.y })
                  }
                >
                  <span className={styles.firstStepIcon} style={{ color: item.color }}>
                    <item.icon size={16} />
                  </span>
                  {item.label}
                </button>
              ))}
              <div className={styles.firstStepSection}>Lógico</div>
              {FIRST_STEP_LOGIC.map((item) => (
                <button
                  key={item.type}
                  type="button"
                  className={styles.firstStepItem}
                  onClick={() =>
                    actions.onCreateFirstStep?.(item.type, { x: firstStepGhost.x, y: firstStepGhost.y })
                  }
                >
                  <span className={styles.firstStepIcon} style={{ color: item.color }}>
                    <item.icon size={15} />
                  </span>
                  {item.label}
                </button>
              ))}
              <div className={styles.firstStepSection}>Más</div>
              <button type="button" className={styles.firstStepItem} onClick={openFirstStepPicker}>
                <span className={styles.firstStepIcon} style={{ color: 'var(--color-text-tertiary)' }}>
                  <MoreHorizontal size={15} />
                </span>
                Otros…
              </button>
            </div>
          )}

          {/* Caja de selección (Shift + arrastrar) */}
          {marqueeRect && (
            <div
              className={styles.selectionMarquee}
              style={{
                left: marqueeRect.left,
                top: marqueeRect.top,
                width: marqueeRect.width,
                height: marqueeRect.height
              }}
            />
          )}

          {nodes.map((node) => (
            <AutomationNodeCard
              key={node.id}
              node={node}
              selected={selectedNodeId === node.id || multiSelectedIds.has(node.id)}
              dragging={Boolean(
                drag?.moved && (drag.nodeId === node.id || drag.groupStart?.[node.id])
              )}
              errors={nodeErrors[node.id]}
              dropState={dropStateFor(node)}
              connectedOutputs={connectedOutputsByNode.get(node.id) || emptyOutputs}
              activeContacts={nodeStats?.[node.id] || 0}
              zoom={viewport.zoom}
              onMeasure={handleMeasure}
              onPointerDownCard={handleNodeCardPointerDown}
              onSelect={(selected, event) => {
                if (event && (event.shiftKey || event.metaKey || event.ctrlKey)) {
                  actions.onToggleSelect(selected.id)
                } else if (!multiSelectedIds.has(selected.id)) {
                  actions.onSelectNode(selected.id)
                }
              }}
              onOpenConfig={(target) => {
                const layout = layoutsRef.current[target.id]
                const { x, y, zoom } = viewportRef.current
                actions.onOpenConfig(target, {
                  x: (target.position.x + (layout?.width || NODE_WIDTH)) * zoom + x + 14,
                  y: target.position.y * zoom + y
                })
              }}
              onPatchConfig={actions.onPatchConfig}
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

        {/* Barra contextual de selección múltiple */}
        {multiToolbar && (
          <div
            className={styles.multiToolbar}
            data-automation-interactive="true"
            style={{ left: multiToolbar.left, top: multiToolbar.top }}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <span className={styles.multiToolbarCount}>
              {multiToolbar.count} elementos seleccionados
            </span>
            <span className={styles.multiToolbarDivider} />
            <button type="button" className={styles.multiToolbarButton} title="Alinear horizontalmente" onClick={() => actions.onAlignSelected('horizontal')}>
              <AlignCenterHorizontal size={13} />
            </button>
            <button type="button" className={styles.multiToolbarButton} title="Alinear verticalmente" onClick={() => actions.onAlignSelected('vertical')}>
              <AlignCenterVertical size={13} />
            </button>
            <button type="button" className={styles.multiToolbarButton} title="Distribuir horizontalmente" onClick={() => actions.onDistributeSelected('horizontal')}>
              <StretchHorizontal size={13} />
            </button>
            <button type="button" className={styles.multiToolbarButton} title="Distribuir verticalmente" onClick={() => actions.onDistributeSelected('vertical')}>
              <StretchVertical size={13} />
            </button>
            <span className={styles.multiToolbarDivider} />
            <button type="button" className={styles.multiToolbarButton} title="Duplicar seleccionados" onClick={actions.onDuplicateSelected}>
              <Copy size={13} />
            </button>
            <button
              type="button"
              className={cn(styles.multiToolbarButton, styles.multiToolbarDanger)}
              title="Eliminar seleccionados"
              onClick={actions.onDeleteSelected}
            >
              <Trash2 size={13} />
            </button>
            <span className={styles.multiToolbarDivider} />
            <button type="button" className={styles.multiToolbarButton} title="Cancelar selección (Esc)" onClick={actions.onClearSelection}>
              <X size={13} />
            </button>
          </div>
        )}

        {/* Herramientas del canvas */}
        <div className={styles.canvasTools} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className={styles.canvasToolButton}
            title="Agregar post-it"
            onClick={handleAddStickyNote}
          >
            <StickyNote size={14} />
          </button>
          <div className={styles.zoomControls}>
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
            <button
              type="button"
              className={styles.zoomButton}
              title="Ordenar flujo (alinea los pasos de izquierda a derecha)"
              onClick={handleAutoLayout}
            >
              <LayoutGrid size={13} />
            </button>
          </div>
        </div>

        {children}
      </div>
    </div>
  )
}
