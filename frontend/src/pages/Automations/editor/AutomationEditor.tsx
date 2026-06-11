import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Archive,
  ArrowLeft,
  Check,
  CloudOff,
  Copy,
  Eye,
  Loader2,
  MoreVertical,
  Pause,
  Play,
  Plus,
  Redo2,
  Save,
  Trash2,
  Undo2,
  Zap
} from 'lucide-react'
import { cn } from '@/utils/cn'
import {
  Badge,
  Button,
  Modal,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import automationsService, {
  AUTOMATION_STATUS_LABELS,
  defaultFlowSettings,
  type Automation,
  type AutomationNode,
  type AutomationStatus,
  type AutomationViewport,
  type FlowSettings
} from '@/services/automationsService'
import { AutomationCanvas, type PendingEdge, type PickerRequest } from './AutomationCanvas'
import { StepPickerBubble, rememberRecentStep } from './StepPickerBubble'
import { NodeConfigBubble } from './NodeConfigBubble'
import { VariableCategoriesContext } from './composer/MessageComposer'
import { Settings as SettingsIcon } from 'lucide-react'
import {
  getNodeDefinition,
  type NodeDefinition,
  type NodeKind
} from './nodeRegistry'
import {
  autoLayoutFlow,
  canConnect,
  connectNodes,
  createNode,
  genId,
  getNodeOutputs,
  getStartTriggers,
  isStartNode,
  migrateLegacyFlow,
  nextNodePosition,
  NODE_WIDTH,
  pruneInvalidEdges,
  removeNode
} from './flowUtils'
import { AutomationLeftNav } from './AutomationLeftNav'
import { FlowSettingsPanel } from './FlowSettingsPanel'
import { createEditorState, editorReducer } from './editorState'
import { validateAutomationFlow } from './automationValidation'
import styles from './AutomationEditor.module.css'

// El AppShell escucha este evento (lo usa el editor de Sitios) para ocultar el
// header global y dar todo el alto de la pantalla al editor.
const EDITOR_ACTIVE_EVENT = 'ristak-sites-editor-active'

const STATUS_BADGE_VARIANT: Record<AutomationStatus, 'neutral' | 'success' | 'warning' | 'default'> = {
  draft: 'neutral',
  published: 'success',
  paused: 'warning',
  archived: 'default'
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

interface PickerState {
  kind: NodeKind
  /** anchored: globo cerca del punto · docked: panel amplio a la derecha */
  variant: 'anchored' | 'docked'
  anchor: { x: number; y: number }
  worldPoint: { x: number; y: number }
  /** Conexión obligada (el globo se abrió desde una salida) */
  source?: { nodeId: string; handle: string }
  /** Conexión opcional al nodo seleccionado (FAB / doble clic) */
  offerConnect?: { nodeId: string; handle: string } | null
  connectEnabled: boolean
  showStartStep: boolean
  /** Crear el nodo exactamente en worldPoint */
  placeAtWorldPoint: boolean
}

interface ConfigState {
  nodeId: string
  /** Si se está configurando un disparador dentro de la tarjeta inicial */
  triggerId?: string
  anchor: { x: number; y: number }
  /** Ya se registró un punto de historial en esta sesión de edición */
  committed: boolean
}

interface PreviewStep {
  key: string
  icon: NodeDefinition['icon'] | typeof Zap
  accent: string
  title: string
  detail?: string
  branch?: boolean
}

export const AutomationEditor: React.FC = () => {
  const { automationId = '' } = useParams()
  const navigate = useNavigate()
  const { showToast, showConfirm } = useNotification()

  const [automation, setAutomation] = useState<Automation | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [name, setName] = useState('')
  const [state, dispatch] = useReducer(editorReducer, createEditorState({ nodes: [], edges: [] }))
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set())
  const [flowSettings, setFlowSettings] = useState<FlowSettings>(defaultFlowSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [fitSignal, setFitSignal] = useState(0)
  const flowSettingsRef = useRef(flowSettings)
  flowSettingsRef.current = flowSettings
  const [config, setConfig] = useState<ConfigState | null>(null)
  const [nodeErrors, setNodeErrors] = useState<Record<string, string[]>>({})
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [statusBusy, setStatusBusy] = useState(false)

  const viewportRef = useRef<AutomationViewport>({ x: 0, y: 0, zoom: 1 })
  const viewportDirtyRef = useRef(false)
  const savedRevisionRef = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state
  const automationRef = useRef(automation)
  automationRef.current = automation
  const multiSelectedRefEditor = useRef(multiSelectedIds)
  multiSelectedRefEditor.current = multiSelectedIds

  // Tamaño real del canvas (los globos se posicionan dentro de él)
  const [canvasBounds, setCanvasBounds] = useState({ width: 1200, height: 700 })
  const canvasBoundsRef = useRef(canvasBounds)
  canvasBoundsRef.current = canvasBounds

  useEffect(() => {
    const measure = () => {
      const wrap = document.querySelector('[data-automation-canvas-wrap]')
      if (!wrap) return
      const rect = wrap.getBoundingClientRect()
      setCanvasBounds((current) =>
        Math.abs(current.width - rect.width) > 1 || Math.abs(current.height - rect.height) > 1
          ? { width: rect.width, height: rect.height }
          : current
      )
    }
    measure()
    window.addEventListener('resize', measure)
    const interval = window.setInterval(measure, 1200)
    return () => {
      window.removeEventListener('resize', measure)
      window.clearInterval(interval)
    }
  }, [automation])

  const { nodes, edges } = state.present

  // Variables congruentes con los disparadores del flujo (citas → Citas,
  // pagos → Pagos…). Contacto/personalizados/conversación siempre presentes.
  const variableCategories = useMemo(() => {
    const TRIGGER_CATEGORY_MAP: Record<string, string> = {
      'trigger-appointment-status': 'appointment',
      'trigger-appointment-booked': 'appointment',
      'trigger-payment-received': 'payment',
      'trigger-refund': 'payment',
      'trigger-form-submitted': 'form'
    }
    const startNode = nodes.find(isStartNode)
    const triggers = startNode ? getStartTriggers(startNode) : []
    const contextual = [
      ...new Set(
        triggers
          .map((trigger) => TRIGGER_CATEGORY_MAP[trigger.type])
          .filter((category): category is string => Boolean(category))
      )
    ]
    return [...contextual, 'contact', 'custom', 'conversation', 'automation']
  }, [nodes])

  // ------------------------------------------------------------------
  // Carga inicial + modo editor a pantalla completa
  // ------------------------------------------------------------------
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(EDITOR_ACTIVE_EVENT, { detail: { active: true, focusMode: false } })
    )
    return () => {
      window.dispatchEvent(
        new CustomEvent(EDITOR_ACTIVE_EVENT, { detail: { active: false, focusMode: false } })
      )
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    automationsService
      .getAutomation(automationId)
      .then((data) => {
        if (cancelled) return
        setAutomation(data)
        setName(data.name)
        viewportRef.current = data.flow.viewport || { x: 0, y: 0, zoom: 1 }
        setFlowSettings({ ...defaultFlowSettings(), ...(data.flow.settings || {}) })
        // Migra nodos de versiones anteriores (If/Else, Telegram, canales retirados)
        dispatch({
          type: 'init',
          flow: { nodes: migrateLegacyFlow(data.flow.nodes), edges: data.flow.edges }
        })
        savedRevisionRef.current = 0
        setSaveState('saved')
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [automationId])

  // ------------------------------------------------------------------
  // Guardado (autosave con debounce + manual + al salir)
  // ------------------------------------------------------------------
  const persistFlow = useCallback(async () => {
    const current = automationRef.current
    if (!current) return false
    const revision = stateRef.current.revision
    setSaveState('saving')
    try {
      await automationsService.updateAutomation(current.id, {
        flow: {
          nodes: stateRef.current.present.nodes,
          edges: stateRef.current.present.edges,
          viewport: viewportRef.current,
          settings: flowSettingsRef.current
        }
      })
      savedRevisionRef.current = revision
      viewportDirtyRef.current = false
      setSaveState(stateRef.current.revision === revision ? 'saved' : 'dirty')
      return true
    } catch {
      setSaveState('error')
      return false
    }
  }, [])

  useEffect(() => {
    if (!automation) return
    if (state.revision === savedRevisionRef.current && settingsRevision === 0) return
    setSaveState('dirty')
    setNodeErrors({})
    const timer = window.setTimeout(() => {
      void persistFlow()
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [automation, persistFlow, state.revision, settingsRevision])

  // Al desmontar: guardar lo pendiente sin bloquear la navegación
  useEffect(() => {
    return () => {
      const current = automationRef.current
      if (!current) return
      if (stateRef.current.revision !== savedRevisionRef.current || viewportDirtyRef.current) {
        void automationsService
          .updateAutomation(current.id, {
            flow: {
              nodes: stateRef.current.present.nodes,
              edges: stateRef.current.present.edges,
              viewport: viewportRef.current,
              settings: flowSettingsRef.current
            }
          })
          .catch(() => undefined)
      }
    }
  }, [])

  // ------------------------------------------------------------------
  // Helpers de mutación del flujo
  // ------------------------------------------------------------------
  const commitFlow = useCallback((nextNodes: AutomationNode[], nextEdges = stateRef.current.present.edges) => {
    dispatch({ type: 'commit', flow: { nodes: nextNodes, edges: pruneInvalidEdges(nextNodes, nextEdges) } })
  }, [])

  const updateNodeConfig = useCallback(
    (nodeId: string, nextConfig: Record<string, unknown>, withHistory: boolean) => {
      const current = stateRef.current.present
      const nextNodes = current.nodes.map((node) =>
        node.id === nodeId ? { ...node, config: nextConfig } : node
      )
      const flow = { nodes: nextNodes, edges: pruneInvalidEdges(nextNodes, current.edges) }
      dispatch({ type: withHistory ? 'commit' : 'replace', flow })
    },
    []
  )

  // ------------------------------------------------------------------
  // Selección / creación de pasos desde los globos
  // ------------------------------------------------------------------
  const openConfigForNode = useCallback((node: AutomationNode, anchor?: { x: number; y: number }) => {
    const viewport = viewportRef.current
    setConfig({
      nodeId: node.id,
      anchor: anchor || {
        x: (node.position.x + NODE_WIDTH) * viewport.zoom + viewport.x + 14,
        y: node.position.y * viewport.zoom + viewport.y
      },
      committed: false
    })
  }, [])

  const handlePickStep = useCallback(
    (definition: NodeDefinition) => {
      if (!picker) return
      rememberRecentStep(definition.type)

      const current = stateRef.current.present

      if (picker.kind === 'trigger') {
        // Añadir disparador a la tarjeta inicial "Cuando..."
        const startNode = current.nodes.find(isStartNode)
        if (!startNode) return
        const entry = { id: genId('trig'), type: definition.type, config: definition.defaultConfig() }
        const triggers = [...getStartTriggers(startNode), entry]
        const nextNodes = current.nodes.map((node) =>
          node.id === startNode.id ? { ...node, config: { ...node.config, triggers } } : node
        )
        commitFlow(nextNodes)
        setPicker(null)
        setSelectedNodeId(startNode.id)
        if (definition.fields.length > 0) {
          const viewport = viewportRef.current
          setConfig({
            nodeId: startNode.id,
            triggerId: entry.id,
            anchor: {
              x: (startNode.position.x + 320) * viewport.zoom + viewport.x + 14,
              y: startNode.position.y * viewport.zoom + viewport.y
            },
            committed: true
          })
        }
        return
      }

      // Crear un paso nuevo
      const source = picker.source || (picker.connectEnabled ? picker.offerConnect || undefined : undefined)
      const sourceNode = source ? current.nodes.find((node) => node.id === source.nodeId) : undefined

      // Con conexión pendiente, el conector de entrada del nodo nuevo cae
      // exactamente en el punto donde se soltó la flecha (entrada ≈ y+24).
      const position = picker.placeAtWorldPoint || !sourceNode
        ? picker.source
          ? { x: picker.worldPoint.x, y: picker.worldPoint.y - 24 }
          : picker.worldPoint
        : nextNodePosition(sourceNode, source?.handle || 'out', current.nodes)

      const node = createNode(definition.type, position)
      let nextEdges = current.edges

      if (source && sourceNode) {
        const check = canConnect(current.nodes, current.edges, source.nodeId, source.handle, node.id)
        // El nodo aún no existe en la lista: validamos contra la lista extendida
        const checkWithNode = check.valid
          ? check
          : canConnect([...current.nodes, node], current.edges, source.nodeId, source.handle, node.id)
        if (checkWithNode.valid) {
          const outputs = getNodeOutputs(sourceNode)
          const output = outputs.find((candidate) => candidate.id === source.handle)
          const label = source.handle === 'out' ? undefined : output?.label?.split(' · ')[0]
          nextEdges = connectNodes(current.edges, source.nodeId, source.handle, node.id, label)
        }
      }

      commitFlow([...current.nodes, node], nextEdges)
      setPicker(null)
      setSelectedNodeId(node.id)
      if (definition.fields.length > 0 || definition.configComponent) {
        openConfigForNode(node)
      }
    },
    [commitFlow, openConfigForNode, picker]
  )

  // ------------------------------------------------------------------
  // Acciones del canvas
  // ------------------------------------------------------------------
  const findFreeOutput = useCallback((node: AutomationNode): string | null => {
    const used = new Set(
      stateRef.current.present.edges
        .filter((edge) => edge.sourceNodeId === node.id)
        .map((edge) => edge.sourceHandle || 'out')
    )
    const free = getNodeOutputs(node).find((output) => !used.has(output.id))
    return free ? free.id : null
  }, [])

  const canvasActions = useMemo(
    () => ({
      onSelectNode: (nodeId: string | null) => {
        setSelectedNodeId(nodeId)
        setMultiSelectedIds(nodeId ? new Set([nodeId]) : new Set())
        if (nodeId === null) {
          setSelectedEdgeId(null)
          setPicker(null)
          setConfig(null)
        }
      },
      // Shift/Cmd + clic alterna el nodo dentro de la selección múltiple
      onToggleSelect: (nodeId: string) => {
        setMultiSelectedIds((current) => {
          const next = new Set(current)
          if (next.has(nodeId)) {
            next.delete(nodeId)
          } else {
            next.add(nodeId)
          }
          if (selectedNodeId && !next.has(selectedNodeId)) {
            // mantiene el primario dentro de la selección
            next.add(selectedNodeId)
          }
          return next
        })
        setSelectedNodeId(nodeId)
      },
      onMarqueeSelect: (nodeIds: string[]) => {
        setMultiSelectedIds(new Set(nodeIds))
        setSelectedNodeId(nodeIds[0] || null)
      },
      onSelectEdge: (edgeId: string | null) => setSelectedEdgeId(edgeId),
      onMoveNode: (nodeId: string, position: { x: number; y: number }, commitMove: boolean) => {
        const current = stateRef.current.present
        const nextNodes = current.nodes.map((node) =>
          node.id === nodeId ? { ...node, position } : node
        )
        dispatch({ type: commitMove ? 'commit' : 'replace', flow: { nodes: nextNodes, edges: current.edges } })
      },
      // Mueve todo el grupo seleccionado a la vez
      onMoveNodes: (positions: Record<string, { x: number; y: number }>, commitMove: boolean) => {
        const current = stateRef.current.present
        const nextNodes = current.nodes.map((node) =>
          positions[node.id] ? { ...node, position: positions[node.id] } : node
        )
        dispatch({ type: commitMove ? 'commit' : 'replace', flow: { nodes: nextNodes, edges: current.edges } })
      },
      // Parche de configuración directo desde la tarjeta (+ mensaje, + rama…)
      onPatchConfig: (node: AutomationNode, patch: Record<string, unknown>, openAfter?: boolean) => {
        const merged = { ...(node.config || {}), ...patch }
        updateNodeConfig(node.id, merged, true)
        if (openAfter) {
          const fresh = stateRef.current.present.nodes.find((candidate) => candidate.id === node.id)
          openConfigForNode(fresh ? { ...fresh, config: merged } : { ...node, config: merged })
        }
      },
      onConnect: (sourceNodeId: string, sourceHandle: string, targetNodeId: string) => {
        const current = stateRef.current.present
        const sourceNode = current.nodes.find((node) => node.id === sourceNodeId)
        const output = sourceNode
          ? getNodeOutputs(sourceNode).find((candidate) => candidate.id === sourceHandle)
          : undefined
        const label = sourceHandle === 'out' ? undefined : output?.label?.split(' · ')[0]
        dispatch({
          type: 'commit',
          flow: {
            nodes: current.nodes,
            edges: connectNodes(current.edges, sourceNodeId, sourceHandle, targetNodeId, label)
          }
        })
      },
      onInvalidConnection: (reason: string) => showToast('warning', 'Conexión no válida', reason),
      onDeleteEdge: (edgeId: string) => {
        const current = stateRef.current.present
        dispatch({
          type: 'commit',
          flow: { nodes: current.nodes, edges: current.edges.filter((edge) => edge.id !== edgeId) }
        })
        setSelectedEdgeId(null)
      },
      onDeleteNode: (node: AutomationNode) => {
        if (isStartNode(node)) return
        const current = stateRef.current.present
        const result = removeNode(current.nodes, current.edges, node.id)
        dispatch({ type: 'commit', flow: result })
        setSelectedNodeId(null)
        setConfig((value) => (value?.nodeId === node.id ? null : value))
      },
      onDuplicateNode: (node: AutomationNode) => {
        if (isStartNode(node)) return
        const current = stateRef.current.present
        const copy: AutomationNode = {
          ...node,
          id: genId('node'),
          position: { x: node.position.x + 40, y: node.position.y + 48 },
          config: JSON.parse(JSON.stringify(node.config || {}))
        }
        commitFlow([...current.nodes, copy])
        setSelectedNodeId(copy.id)
      },
      onOpenConfig: (node: AutomationNode, anchor: { x: number; y: number }) => {
        openConfigForNode(node, anchor)
      },
      onRequestPicker: (request: PickerRequest) => {
        setConfig(null)
        if (request.source) {
          setPicker({
            kind: 'action',
            variant: 'anchored',
            anchor: request.anchor,
            worldPoint: request.worldPoint,
            source: request.source,
            offerConnect: null,
            connectEnabled: true,
            showStartStep: false,
            placeAtWorldPoint: true
          })
          return
        }

        // Doble clic en el fondo: conectar opcionalmente con el nodo seleccionado
        const current = stateRef.current.present
        const selected = selectedNodeId
          ? current.nodes.find((node) => node.id === selectedNodeId)
          : undefined
        const freeHandle = selected ? findFreeOutput(selected) : null
        setPicker({
          kind: 'action',
          variant: 'anchored',
          anchor: request.anchor,
          worldPoint: request.worldPoint,
          offerConnect: selected && freeHandle ? { nodeId: selected.id, handle: freeHandle } : null,
          connectEnabled: Boolean(selected && freeHandle),
          showStartStep: true,
          placeAtWorldPoint: true
        })
      },
      onAddTrigger: (node: AutomationNode, anchor: { x: number; y: number }) => {
        setConfig(null)
        setSelectedNodeId(node.id)
        setPicker({
          kind: 'trigger',
          variant: 'anchored',
          anchor,
          worldPoint: node.position,
          connectEnabled: false,
          showStartStep: false,
          placeAtWorldPoint: false
        })
      },
      onEditTrigger: (node: AutomationNode, triggerId: string, anchor: { x: number; y: number }) => {
        setPicker(null)
        setSelectedNodeId(node.id)
        setConfig({ nodeId: node.id, triggerId, anchor, committed: false })
      },
      onRemoveTrigger: (node: AutomationNode, triggerId: string) => {
        const current = stateRef.current.present
        const triggers = getStartTriggers(node).filter((trigger) => trigger.id !== triggerId)
        const nextNodes = current.nodes.map((candidate) =>
          candidate.id === node.id
            ? { ...candidate, config: { ...candidate.config, triggers } }
            : candidate
        )
        commitFlow(nextNodes)
        setConfig((value) => (value?.triggerId === triggerId ? null : value))
      },
      onViewportChange: (viewport: AutomationViewport) => {
        viewportRef.current = viewport
        viewportDirtyRef.current = true
      },
      // ----------------- selección múltiple -----------------
      onClearSelection: () => {
        setMultiSelectedIds(new Set())
        setSelectedNodeId(null)
      },
      onDeleteSelected: () => {
        const ids = [...multiSelectedRefEditor.current].filter((id) => {
          const node = stateRef.current.present.nodes.find((candidate) => candidate.id === id)
          return node && !isStartNode(node)
        })
        if (ids.length === 0) return
        showConfirm(
          'Eliminar pasos seleccionados',
          `¿Eliminar ${ids.length} paso${ids.length > 1 ? 's' : ''} y sus conexiones? Puedes deshacer con Ctrl+Z.`,
          () => {
            const current = stateRef.current.present
            const idSet = new Set(ids)
            dispatch({
              type: 'commit',
              flow: {
                nodes: current.nodes.filter((node) => !idSet.has(node.id)),
                edges: current.edges.filter(
                  (edge) => !idSet.has(edge.sourceNodeId) && !idSet.has(edge.targetNodeId)
                )
              }
            })
            setMultiSelectedIds(new Set())
            setSelectedNodeId(null)
          },
          'Eliminar',
          'Cancelar'
        )
      },
      onDuplicateSelected: () => {
        const current = stateRef.current.present
        const selected = current.nodes.filter(
          (node) => multiSelectedRefEditor.current.has(node.id) && !isStartNode(node)
        )
        if (selected.length === 0) return
        const copies = selected.map((node) => ({
          ...node,
          id: genId('node'),
          position: { x: node.position.x + 48, y: node.position.y + 56 },
          config: JSON.parse(JSON.stringify(node.config || {}))
        }))
        dispatch({ type: 'commit', flow: { nodes: [...current.nodes, ...copies], edges: current.edges } })
        setMultiSelectedIds(new Set(copies.map((copy) => copy.id)))
        setSelectedNodeId(copies[0]?.id || null)
      },
      onAlignSelected: (axis: 'horizontal' | 'vertical') => {
        const current = stateRef.current.present
        const selected = current.nodes.filter((node) => multiSelectedRefEditor.current.has(node.id))
        if (selected.length < 2) return
        const minY = Math.min(...selected.map((node) => node.position.y))
        const minX = Math.min(...selected.map((node) => node.position.x))
        const nextNodes = current.nodes.map((node) =>
          multiSelectedRefEditor.current.has(node.id)
            ? {
                ...node,
                position:
                  axis === 'horizontal'
                    ? { x: node.position.x, y: minY }
                    : { x: minX, y: node.position.y }
              }
            : node
        )
        dispatch({ type: 'commit', flow: { nodes: nextNodes, edges: current.edges } })
      },
      onDistributeSelected: (axis: 'horizontal' | 'vertical') => {
        const current = stateRef.current.present
        const selected = current.nodes
          .filter((node) => multiSelectedRefEditor.current.has(node.id))
          .sort((a, b) => (axis === 'horizontal' ? a.position.x - b.position.x : a.position.y - b.position.y))
        if (selected.length < 3) return
        const first = selected[0]
        const last = selected[selected.length - 1]
        const start = axis === 'horizontal' ? first.position.x : first.position.y
        const end = axis === 'horizontal' ? last.position.x : last.position.y
        const step = (end - start) / (selected.length - 1)
        const positions = new Map(
          selected.map((node, index) => [
            node.id,
            axis === 'horizontal'
              ? { x: Math.round(start + step * index), y: node.position.y }
              : { x: node.position.x, y: Math.round(start + step * index) }
          ])
        )
        const nextNodes = current.nodes.map((node) =>
          positions.has(node.id) ? { ...node, position: positions.get(node.id) as { x: number; y: number } } : node
        )
        dispatch({ type: 'commit', flow: { nodes: nextNodes, edges: current.edges } })
      },
      // Botón "Ordenar flujo": selección si hay varias; si no, todo el flujo
      onAutoLayout: (heights: Record<string, number>) => {
        const current = stateRef.current.present
        const selection =
          multiSelectedRefEditor.current.size > 1 ? multiSelectedRefEditor.current : undefined
        const nextNodes = autoLayoutFlow(current.nodes, current.edges, heights, selection)
        dispatch({ type: 'commit', flow: { nodes: nextNodes, edges: current.edges } })
        if (!selection) setFitSignal((value) => value + 1)
        showToast('success', 'Flujo ordenado', 'Puedes deshacer con Ctrl+Z')
      }
    }),
    [commitFlow, findFreeOutput, openConfigForNode, selectedNodeId, showToast]
  )

  // ------------------------------------------------------------------
  // FAB "+"
  // ------------------------------------------------------------------
  const handleFabClick = () => {
    setConfig(null)
    const current = stateRef.current.present
    const selected = selectedNodeId ? current.nodes.find((node) => node.id === selectedNodeId) : undefined
    const freeHandle = selected ? findFreeOutput(selected) : null
    const viewport = viewportRef.current
    const bounds = canvasBoundsRef.current
    setPicker({
      kind: 'action',
      variant: 'docked',
      anchor: { x: 0, y: 0 },
      worldPoint: {
        x: (bounds.width / 2 - viewport.x) / viewport.zoom - NODE_WIDTH / 2,
        y: (bounds.height / 2 - viewport.y) / viewport.zoom - 80
      },
      offerConnect: selected && freeHandle ? { nodeId: selected.id, handle: freeHandle } : null,
      connectEnabled: Boolean(selected && freeHandle),
      showStartStep: true,
      placeAtWorldPoint: !(selected && freeHandle)
    })
  }

  // ------------------------------------------------------------------
  // Teclado global (eliminar, deshacer/rehacer, escape)
  // ------------------------------------------------------------------
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        if (typing) return
        event.preventDefault()
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' })
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        if (typing) return
        event.preventDefault()
        dispatch({ type: 'redo' })
        return
      }

      if (event.key === 'Escape') {
        if (picker || config) {
          setPicker(null)
          setConfig(null)
        } else {
          setSelectedNodeId(null)
          setSelectedEdgeId(null)
          setMultiSelectedIds(new Set())
        }
        return
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && !typing) {
        if (selectedEdgeId) {
          event.preventDefault()
          canvasActions.onDeleteEdge(selectedEdgeId)
          return
        }
        if (multiSelectedIds.size > 1) {
          event.preventDefault()
          canvasActions.onDeleteSelected()
          return
        }
        if (selectedNodeId) {
          const node = stateRef.current.present.nodes.find((candidate) => candidate.id === selectedNodeId)
          if (node && !isStartNode(node)) {
            event.preventDefault()
            canvasActions.onDeleteNode(node)
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canvasActions, config, picker, selectedEdgeId, selectedNodeId, multiSelectedIds])

  // ------------------------------------------------------------------
  // Nombre, estado, publicar, vista previa
  // ------------------------------------------------------------------
  const saveName = async () => {
    const current = automationRef.current
    const trimmed = name.trim()
    if (!current || !trimmed || trimmed === current.name) {
      setName(current?.name || trimmed)
      return
    }
    try {
      const updated = await automationsService.updateAutomation(current.id, { name: trimmed })
      setAutomation((value) => (value ? { ...value, name: updated.name } : value))
    } catch {
      showToast('error', 'No se pudo renombrar', 'Intenta de nuevo')
      setName(current.name)
    }
  }

  const changeStatus = async (status: AutomationStatus) => {
    const current = automationRef.current
    if (!current || statusBusy) return

    if (status === 'published') {
      const validation = validateAutomationFlow(stateRef.current.present.nodes, stateRef.current.present.edges)
      if (!validation.valid) {
        setNodeErrors(validation.nodeErrors)
        const summary = validation.issues.slice(0, 3).map((issue) => issue.message).join('. ')
        const extra = validation.issues.length > 3 ? ` (+${validation.issues.length - 3} más)` : ''
        showToast('error', 'No se puede publicar', `${summary}${extra}`)
        return
      }
    }

    setStatusBusy(true)
    try {
      const saved = await persistFlow()
      if (!saved) {
        showToast('error', 'No se pudo guardar', 'Revisa tu conexión e intenta de nuevo')
        return
      }
      const updated = await automationsService.updateAutomation(current.id, { status })
      setAutomation((value) =>
        value ? { ...value, status: updated.status, publishedAt: updated.publishedAt } : value
      )
      setNodeErrors({})
      if (status === 'published') {
        showToast('success', 'Automatización publicada', 'Tu automatización está en vivo')
      } else if (status === 'paused') {
        showToast('info', 'Automatización pausada')
      } else if (status === 'draft') {
        showToast('info', 'Automatización en borrador')
      }
    } catch (error) {
      showToast('error', 'No se pudo cambiar el estado', error instanceof Error ? error.message : '')
    } finally {
      setStatusBusy(false)
    }
  }

  const handleDuplicateAutomation = async () => {
    const current = automationRef.current
    if (!current) return
    try {
      await persistFlow()
      const copy = await automationsService.duplicateAutomation(current.id)
      showToast('success', 'Automatización duplicada', copy.name)
      navigate(`/automations/${copy.id}`)
    } catch {
      showToast('error', 'No se pudo duplicar la automatización')
    }
  }

  const handleDeleteAutomation = () => {
    const current = automationRef.current
    if (!current) return
    showConfirm(
      'Eliminar automatización',
      `¿Seguro que quieres eliminar "${current.name}"? Esta acción no se puede deshacer.`,
      () => {
        void automationsService
          .deleteAutomation(current.id)
          .then(() => {
            showToast('success', 'Automatización eliminada')
            navigate('/automations')
          })
          .catch(() => showToast('error', 'No se pudo eliminar la automatización'))
      },
      'Eliminar',
      'Cancelar'
    )
  }

  // Pasos de la vista previa: recorre el flujo desde la tarjeta inicial
  const previewSteps = useMemo<PreviewStep[]>(() => {
    if (!previewOpen) return []
    const steps: PreviewStep[] = []
    const startNode = nodes.find(isStartNode)
    if (!startNode) return steps

    const triggers = getStartTriggers(startNode)
    if (triggers.length === 0) {
      steps.push({ key: 'no-trigger', icon: Zap, accent: 'green', title: 'Cuando...', detail: 'Sin disparadores todavía' })
    }
    triggers.forEach((trigger) => {
      const definition = getNodeDefinition(trigger.type)
      steps.push({
        key: `trigger-${trigger.id}`,
        icon: definition?.icon || Zap,
        accent: definition?.accent || 'green',
        title: `Cuando: ${definition?.label || trigger.type}`,
        detail: definition?.summary(trigger.config || {}).text
      })
    })

    const visited = new Set<string>()
    const walk = (nodeId: string, branchLabel: string | undefined, depth: number) => {
      if (depth > 30 || visited.has(nodeId)) return
      visited.add(nodeId)
      const node = nodes.find((candidate) => candidate.id === nodeId)
      if (!node) return
      const definition = getNodeDefinition(node.type)
      const summary = definition?.summary(node.config || {})
      steps.push({
        key: `step-${node.id}`,
        icon: definition?.icon || Zap,
        accent: definition?.accent || 'blue',
        title: branchLabel ? `${branchLabel} → ${definition?.label || node.type}` : definition?.label || node.type,
        detail: summary?.text || summary?.box,
        branch: Boolean(branchLabel)
      })
      const outputs = node ? getNodeOutputs(node) : []
      outputs.forEach((output) => {
        const edge = edges.find(
          (candidate) => candidate.sourceNodeId === nodeId && (candidate.sourceHandle || 'out') === output.id
        )
        if (edge) {
          walk(edge.targetNodeId, outputs.length > 1 ? output.label : undefined, depth + 1)
        }
      })
    }

    const firstEdge = edges.find((edge) => edge.sourceNodeId === startNode.id)
    if (firstEdge) walk(firstEdge.targetNodeId, undefined, 0)

    return steps
  }, [edges, nodes, previewOpen])

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  if (loadError) {
    return (
      <div className={styles.editorShell}>
        <div className={styles.editorLoading}>
          No se encontró la automatización.&nbsp;
          <Button variant="secondary" size="sm" onClick={() => navigate('/automations')}>
            Volver a Automatizaciones
          </Button>
        </div>
      </div>
    )
  }

  if (!automation) {
    return (
      <div className={styles.editorShell}>
        <div className={styles.editorLoading}>
          <Loader2 size={16} className="animate-spin" style={{ marginRight: 8 }} />
          Cargando automatización…
        </div>
      </div>
    )
  }

  const configNode = config ? nodes.find((node) => node.id === config.nodeId) : undefined
  const configTrigger =
    config?.triggerId && configNode
      ? getStartTriggers(configNode).find((trigger) => trigger.id === config.triggerId)
      : undefined
  const configDefinition = config
    ? configTrigger
      ? getNodeDefinition(configTrigger.type)
      : configNode
        ? getNodeDefinition(configNode.type)
        : undefined
    : undefined

  const handleConfigChange = (nextConfig: Record<string, unknown>) => {
    if (!config || !configNode) return
    const withHistory = !config.committed
    if (withHistory) setConfig({ ...config, committed: true })

    if (config.triggerId) {
      const triggers = getStartTriggers(configNode).map((trigger) =>
        trigger.id === config.triggerId ? { ...trigger, config: nextConfig } : trigger
      )
      updateNodeConfig(configNode.id, { ...configNode.config, triggers }, withHistory)
    } else {
      updateNodeConfig(configNode.id, nextConfig, withHistory)
    }
  }

  const status = automation.status

  // Flecha fantasma mientras el selector está abierto tras soltar el conector
  const pendingEdge: PendingEdge | null =
    picker && picker.source && picker.placeAtWorldPoint
      ? { source: picker.source, point: picker.worldPoint }
      : null

  return (
    <VariableCategoriesContext.Provider value={variableCategories}>
    <div className={styles.editorShell}>
      {/* ----------------------------- Toolbar ---------------------------- */}
      <header className={styles.toolbar}>
        <button
          type="button"
          className={styles.toolbarBack}
          title="Volver a Automatizaciones"
          onClick={() => navigate('/automations')}
        >
          <ArrowLeft size={15} />
        </button>

        <input
          className={styles.toolbarName}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => void saveName()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          }}
          aria-label="Nombre de la automatización"
        />

        <Badge variant={STATUS_BADGE_VARIANT[status]}>{AUTOMATION_STATUS_LABELS[status]}</Badge>

        <div className={styles.toolbarSpacer} />

        <span className={cn(styles.saveIndicator, saveState === 'error' && styles.saveIndicatorError)}>
          {saveState === 'saving' && <Loader2 size={12} className="animate-spin" />}
          {saveState === 'saved' && <Check size={12} />}
          {saveState === 'error' && <CloudOff size={12} />}
          {saveState === 'saving'
            ? 'Guardando…'
            : saveState === 'saved'
              ? 'Guardado'
              : saveState === 'error'
                ? 'Error al guardar'
                : 'Cambios sin guardar'}
        </span>

        <div className={styles.toolbarGroup}>
          <button
            type="button"
            className={styles.iconButton}
            title="Deshacer (Ctrl+Z)"
            disabled={state.past.length === 0}
            onClick={() => dispatch({ type: 'undo' })}
          >
            <Undo2 size={14} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            title="Rehacer (Ctrl+Shift+Z)"
            disabled={state.future.length === 0}
            onClick={() => dispatch({ type: 'redo' })}
          >
            <Redo2 size={14} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            title="Guardar ahora"
            onClick={() => void persistFlow()}
          >
            <Save size={14} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            title="Configuración del flujo (zona horaria, horarios, reingreso)"
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon size={14} />
          </button>
        </div>

        <div className={styles.toolbarGroup}>
          <Button variant="secondary" size="sm" leftIcon={<Eye size={13} />} onClick={() => setPreviewOpen(true)}>
            Vista previa
          </Button>

          {status === 'published' ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Pause size={13} />}
              loading={statusBusy}
              onClick={() => void changeStatus('paused')}
            >
              Pausar
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Play size={13} />}
              loading={statusBusy}
              onClick={() => void changeStatus('published')}
            >
              {status === 'paused' ? 'Reanudar' : 'Publicar En Vivo'}
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={styles.iconButton} title="Más opciones">
                <MoreVertical size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void handleDuplicateAutomation()}>
                <Copy size={13} style={{ marginRight: 8 }} />
                Duplicar automatización
              </DropdownMenuItem>
              {status !== 'draft' && (
                <DropdownMenuItem onSelect={() => void changeStatus('draft')}>
                  <Undo2 size={13} style={{ marginRight: 8 }} />
                  Pasar a borrador
                </DropdownMenuItem>
              )}
              {status !== 'archived' && (
                <DropdownMenuItem onSelect={() => void changeStatus('archived')}>
                  <Archive size={13} style={{ marginRight: 8 }} />
                  Archivar
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleDeleteAutomation}>
                <Trash2 size={13} style={{ marginRight: 8 }} />
                Eliminar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* ------------------------------ Canvas ----------------------------- */}
      <div className={styles.editorMain}>
        <AutomationLeftNav currentId={automation.id} />
        <AutomationCanvas
        nodes={nodes}
        edges={edges}
        selectedNodeId={selectedNodeId}
        multiSelectedIds={multiSelectedIds}
        selectedEdgeId={selectedEdgeId}
        nodeErrors={nodeErrors}
        initialViewport={automation.flow.viewport || { x: 0, y: 0, zoom: 1 }}
        pendingEdge={pendingEdge}
        fitSignal={fitSignal}
        actions={canvasActions}
      >
        <button type="button" className={styles.fab} title="Agregar paso" onClick={handleFabClick}>
          <Plus size={20} />
        </button>

        {picker && (
          <StepPickerBubble
            kind={picker.kind}
            variant={picker.variant}
            anchor={picker.anchor}
            bounds={canvasBounds}
            connectLabel={
              picker.offerConnect && picker.kind === 'action'
                ? 'Conectar con el paso seleccionado'
                : undefined
            }
            connectEnabled={picker.connectEnabled}
            onToggleConnect={(enabled) => setPicker({ ...picker, connectEnabled: enabled })}
            showStartStep={picker.showStartStep}
            onSelectStartStep={() => setPicker({ ...picker, kind: 'trigger', showStartStep: false })}
            onSelect={handlePickStep}
            onClose={() => setPicker(null)}
          />
        )}

      </AutomationCanvas>

      {/* Panel de configuración acoplado a la derecha (estilo ManyChat) */}
      {config && configNode && configDefinition && (
        <NodeConfigBubble
          definition={configDefinition}
          config={(configTrigger ? configTrigger.config : configNode.config) || {}}
          onChange={handleConfigChange}
          onClose={() => setConfig(null)}
        />
      )}
      </div>

      {/* ----------------------- Configuración del flujo --------------------- */}
      <FlowSettingsPanel
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false)
          void saveName()
        }}
        name={name}
        onRename={setName}
        settings={flowSettings}
        onChange={(next) => {
          setFlowSettings(next)
          setSettingsRevision((value) => value + 1)
        }}
      />

      {/* ---------------------------- Vista previa -------------------------- */}
      <Modal
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="Vista previa del flujo"
        size="md"
      >
        {previewSteps.length === 0 ? (
          <p style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>
            Agrega un disparador y conecta pasos para ver el recorrido.
          </p>
        ) : (
          <div className={styles.previewList}>
            {previewSteps.map((step) => (
              <div key={step.key} className={cn(styles.previewStep, step.branch && styles.previewStepBranch)}>
                <span className={styles.pickerItemIcon} data-accent={step.accent}>
                  <step.icon size={14} />
                </span>
                <span className={styles.previewStepText}>
                  <span className={styles.previewStepTitle}>{step.title}</span>
                  {step.detail && <span className={styles.previewStepDetail}>{step.detail}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
    </VariableCategoriesContext.Provider>
  )
}
