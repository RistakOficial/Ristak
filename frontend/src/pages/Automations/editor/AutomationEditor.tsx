import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Archive,
  AlertTriangle,
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
  Button,
  Modal,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { useAuth } from '@/contexts/AuthContext'
import { hasLicenseFeature } from '@/utils/accessControl'
import automationsService, {
  AUTOMATION_REVIEW_LABEL,
  automationsCache,
  defaultFlowSettings,
  type Automation,
  type AutomationNode,
  type AutomationReviewIssue,
  type AutomationSummary,
  type AutomationStatus,
  type AutomationViewport,
  type FlowSettings
} from '@/services/automationsService'
import { resetCatalogCache } from '@/services/automationCatalogsService'
import { AutomationCanvas, type PendingEdge, type PickerRequest } from './AutomationCanvas'
import { StepPickerBubble } from './StepPickerBubble'
import { NodeConfigBubble } from './NodeConfigBubble'
import { VariableCategoriesContext } from './composer/MessageComposer'
import { FlowVariablesContext, buildFlowVariableCatalog } from './variablesCatalog'
import { Settings as SettingsIcon } from 'lucide-react'
import {
  getNodeDefinition,
  validateNodeConfig,
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
  getWaitMessageSourceOptions,
  isStartNode,
  migrateLegacyFlow,
  nextNodePosition,
  NODE_WIDTH,
  pruneInvalidEdges,
  removeNode
} from './flowUtils'
import { AutomationLibrary } from '../AutomationLibrary'
import { FlowSettingsPanel } from './FlowSettingsPanel'
import { EnrollmentRecordsModal, type RecordsTab } from './EnrollmentRecordsModal'
import { AutomationTestRunModal } from './AutomationTestRunModal'
import { createEditorState, editorReducer } from './editorState'
import { validateAutomationFlow } from './automationValidation'
import { RichEmailEditorModal } from './config/RichEmailEditorModal'
import type { EmailRichEditorRequest } from './config/EmailConfigEditor'
import styles from './AutomationEditor.module.css'

// El AppShell escucha este evento (lo usa el editor de Sitios) para ocultar el
// header global y dar todo el alto de la pantalla al editor.
const EDITOR_ACTIVE_EVENT = 'ristak-sites-editor-active'

type SaveState = 'saved' | 'dirty' | 'saving' | 'error'
type PersistAutomation = (options?: { notify?: boolean }) => Promise<boolean>

interface PickerState {
  kind: NodeKind
  /** anchored: globo cerca del punto · docked: panel amplio a la derecha */
  variant: 'anchored' | 'docked'
  placement?: 'point' | 'below-end' | 'left-start'
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
  /** Punto del lienzo donde se abrió el panel; se proyecta con el viewport actual. */
  anchorWorld: { x: number; y: number }
  /** Ya se registró un punto de historial en esta sesión de edición */
  committed: boolean
}

type EmailEditorSaveConfig = {
  subject: string
  body: string
  bodyHtml: string
  includeSignature: boolean
}

type EmailEditorState = EmailRichEditorRequest & Pick<ConfigState, 'nodeId' | 'triggerId' | 'committed'>

interface PreviewStep {
  key: string
  icon: NodeDefinition['icon'] | typeof Zap
  accent: string
  title: string
  detail?: string
  branch?: boolean
}

type EditorFlow = Pick<Automation['flow'], 'nodes' | 'edges' | 'viewport' | 'settings'>

const DEFAULT_VIEWPORT: AutomationViewport = { x: 0, y: 0, zoom: 1 }
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeViewport(value: unknown): AutomationViewport {
  if (!isRecord(value)) return DEFAULT_VIEWPORT
  return {
    x: Number(value.x) || 0,
    y: Number(value.y) || 0,
    zoom: Math.min(2.5, Math.max(0.2, Number(value.zoom) || 1))
  }
}

function fallbackStartNode(): AutomationNode {
  return {
    id: 'start',
    type: 'start',
    category: 'trigger',
    label: 'Cuando...',
    position: { x: 120, y: 220 },
    config: { triggers: [] }
  }
}

function normalizeEditorFlow(flow: Automation['flow'] | null | undefined): EditorFlow {
  const rawNodes = Array.isArray(flow?.nodes) ? flow.nodes : []
  const nodes = rawNodes
    .filter((node): node is AutomationNode => isRecord(node) && Boolean(node.id) && Boolean(node.type))
    .map((node) => ({
      ...node,
      id: String(node.id),
      type: String(node.type),
      position: isRecord(node.position)
        ? { x: Number(node.position.x) || 0, y: Number(node.position.y) || 0 }
        : { x: 0, y: 0 },
      config: isRecord(node.config) ? node.config : {}
    }))
  const nodesWithStart = nodes.some(isStartNode) ? nodes : [fallbackStartNode(), ...nodes]
  const migratedNodes = migrateLegacyFlow(nodesWithStart)
  const nodeIds = new Set(migratedNodes.map((node) => node.id))
  const rawEdges: unknown[] = Array.isArray(flow?.edges) ? flow.edges : []
  const edges = rawEdges
    .filter(
      (edge): edge is Record<string, unknown> =>
        isRecord(edge) &&
        Boolean(edge.id) &&
        nodeIds.has(String(edge.sourceNodeId)) &&
        nodeIds.has(String(edge.targetNodeId))
    )
    .map((edge) => ({
      ...edge,
      id: String(edge.id),
      sourceNodeId: String(edge.sourceNodeId),
      sourceHandle: edge.sourceHandle ? String(edge.sourceHandle) : 'out',
      targetNodeId: String(edge.targetNodeId),
      targetHandle: edge.targetHandle ? String(edge.targetHandle) : 'in',
      animated: edge.animated !== false
    }))

  return {
    nodes: migratedNodes,
    edges,
    viewport: normalizeViewport(flow?.viewport),
    settings: isRecord(flow?.settings) ? (flow.settings as FlowSettings) : undefined
  }
}

function automationContentSignature(
  name: string,
  nodes: AutomationNode[],
  edges: Automation['flow']['edges'],
  settings: FlowSettings
) {
  return JSON.stringify({
    name: name.trim(),
    nodes: nodes.map((node) => ({ ...node, position: undefined })),
    edges,
    settings
  })
}

function toAutomationSummary(automation: Automation): AutomationSummary {
  return {
    id: automation.id,
    folderId: automation.folderId,
    name: automation.name,
    description: automation.description,
    status: automation.status,
    hasUnpublishedChanges: automation.hasUnpublishedChanges,
    reviewStatus: automation.reviewStatus,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
    publishedAt: automation.publishedAt
  }
}

function reviewIssuesToNodeErrors(issues: AutomationReviewIssue[] = []) {
  return issues.reduce<Record<string, string[]>>((acc, issue) => {
    if (!issue.nodeId) return acc
    acc[issue.nodeId] = [...(acc[issue.nodeId] || []), issue.message]
    return acc
  }, {})
}

export const AutomationEditor: React.FC = () => {
  const { automationId = '' } = useParams()
  const navigate = useNavigate()
  const { showToast, showConfirm } = useNotification()
  const { user } = useAuth()

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
  const [recordsTab, setRecordsTab] = useState<RecordsTab | null>(null)
  const [testRunOpen, setTestRunOpen] = useState(false)
  const [nodeStats, setNodeStats] = useState<Record<string, number>>({})
  const [fitSignal, setFitSignal] = useState(0)
  const flowSettingsRef = useRef(flowSettings)
  flowSettingsRef.current = flowSettings
  const [config, setConfig] = useState<ConfigState | null>(null)
  const [emailEditor, setEmailEditor] = useState<EmailEditorState | null>(null)
  const emailEditorRef = useRef<EmailEditorState | null>(null)
  emailEditorRef.current = emailEditor
  const configRef = useRef<typeof config>(null)
  useEffect(() => {
    configRef.current = config
  }, [config])

  useEffect(() => {
    resetCatalogCache()
  }, [automationId])

  const [nodeErrors, setNodeErrors] = useState<Record<string, string[]>>({})
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [statusBusy, setStatusBusy] = useState(false)

  const viewportRef = useRef<AutomationViewport>({ x: 0, y: 0, zoom: 1 })
  const [configViewport, setConfigViewport] = useState<AutomationViewport>(viewportRef.current)
  const savedContentSignatureRef = useRef('')
  const nameRef = useRef(name)
  nameRef.current = name
  const stateRef = useRef(state)
  stateRef.current = state
  const automationRef = useRef(automation)
  automationRef.current = automation
  const persistAutomationRef = useRef<PersistAutomation | null>(null)
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

  const currentContentSignature = useMemo(
    () => automationContentSignature(name, nodes, edges, flowSettings),
    [edges, flowSettings, name, nodes]
  )

  const editorPointToWorld = useCallback(
    (point: { x: number; y: number }, viewport: AutomationViewport = viewportRef.current) => ({
      x: (point.x - viewport.x) / viewport.zoom,
      y: (point.y - viewport.y) / viewport.zoom
    }),
    []
  )

  // Contactos activos por nodo (badges del canvas): se refresca cada 15s
  useEffect(() => {
    if (!automation) return
    let cancelled = false
    const load = () => {
      void automationsService
        .getEnrollmentStats(automation.id)
        .then((stats) => {
          if (!cancelled) setNodeStats(stats.byNode || {})
        })
        .catch(() => undefined)
    }
    load()
    const interval = window.setInterval(load, 15000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [automation])

  // Variables congruentes con los disparadores del flujo (citas, pagos...).
  // Contacto, personalizados, variables internas y enlaces de disparo siempre presentes.
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
    return [...contextual, 'contact', 'custom', 'variable', 'trigger_link', 'conversation', 'automation']
  }, [nodes])

  const flowVariableCatalog = useMemo(
    () => buildFlowVariableCatalog(nodes, edges, config?.triggerId ? null : config?.nodeId || null),
    [config?.nodeId, config?.triggerId, edges, nodes]
  )

  const hasUnpublishedChanges = Boolean(automation?.hasUnpublishedChanges)
  const getHasUnsavedChanges = useCallback(() => {
    if (!automationRef.current) return false
    return automationContentSignature(
      nameRef.current,
      stateRef.current.present.nodes,
      stateRef.current.present.edges,
      flowSettingsRef.current
    ) !== savedContentSignatureRef.current
  }, [])
  const hasUnsavedChanges = Boolean(automation && currentContentSignature !== savedContentSignatureRef.current)
  const shouldWarnBeforeLeaving = Boolean(automation && hasUnsavedChanges)

  useEffect(() => {
    if (!shouldWarnBeforeLeaving) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [shouldWarnBeforeLeaving])

  const confirmLeavingIfNeeded = useCallback(
    (onContinue: () => void) => {
      const pendingUnsavedChanges = getHasUnsavedChanges()
      if (!pendingUnsavedChanges) {
        onContinue()
        return
      }
      showConfirm(
        'Cambios sin guardar',
        'Si sales ahora, los cambios que no guardaste se perderán.',
        onContinue,
        'Salir sin guardar',
        'Seguir editando',
        undefined,
        {
          secondaryActionText: 'Salir y guardar',
          secondaryActionVariant: 'primary',
          onSecondaryAction: async () => {
            const saveBeforeLeaving = persistAutomationRef.current
            if (!saveBeforeLeaving) return false
            const saved = await saveBeforeLeaving({ notify: true })
            if (saved) onContinue()
            return saved
          }
        }
      )
    },
    [getHasUnsavedChanges, showConfirm]
  )

  const navigateFromEditor = useCallback(
    (to: string) => {
      confirmLeavingIfNeeded(() => navigate(to))
    },
    [confirmLeavingIfNeeded, navigate]
  )

  const handleLibraryAutomationUpdated = useCallback((updated: AutomationSummary) => {
    const current = automationRef.current
    if (!current || current.id !== updated.id) return

    const wasDirty = getHasUnsavedChanges()
    setAutomation((value) =>
      value
        ? {
            ...value,
            ...updated,
            flow: value.flow
          }
        : value
    )
    if (nameRef.current !== updated.name) {
      nameRef.current = updated.name
      setName(updated.name)
    }

    if (!wasDirty) {
      savedContentSignatureRef.current = automationContentSignature(
        updated.name,
        stateRef.current.present.nodes,
        stateRef.current.present.edges,
        flowSettingsRef.current
      )
      setSaveState('saved')
    }
  }, [getHasUnsavedChanges])

  useEffect(() => {
    if (!shouldWarnBeforeLeaving) return
    const handleDocumentClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return
      }
      const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor || anchor.target) return
      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('#')) return
      const nextUrl = new URL(href, window.location.origin)
      if (nextUrl.origin !== window.location.origin) return
      const nextPath = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`
      const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`
      if (nextPath === currentPath) return

      event.preventDefault()
      event.stopPropagation()
      confirmLeavingIfNeeded(() => navigate(nextPath))
    }
    document.addEventListener('click', handleDocumentClick, true)
    return () => document.removeEventListener('click', handleDocumentClick, true)
  }, [confirmLeavingIfNeeded, navigate, shouldWarnBeforeLeaving])

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

    const initFrom = (data: Automation) => {
      const safeFlow = normalizeEditorFlow(data.flow)
      const safeSettings = { ...defaultFlowSettings(), ...(safeFlow.settings || {}) }
      setAutomation({ ...data, flow: safeFlow })
      setName(data.name)
      viewportRef.current = safeFlow.viewport
      setFlowSettings(safeSettings)
      dispatch({ type: 'init', flow: { nodes: safeFlow.nodes, edges: safeFlow.edges } })
      savedContentSignatureRef.current = automationContentSignature(
        data.name,
        safeFlow.nodes,
        safeFlow.edges,
        safeSettings
      )
      setNodeErrors(reviewIssuesToNodeErrors(data.reviewStatus?.issues))
      setSaveState('saved')
    }

    // Sin parpadeo: si ya lo conocemos, se pinta al instante desde el caché
    // y se revalida en segundo plano (solo se aplica si aún no editas nada)
    const cached = automationsCache.automations.get(automationId)
    if (cached) initFrom(cached)

    automationsService
      .getAutomation(automationId)
      .then((data) => {
        if (cancelled) return
        if (!cached) {
          initFrom(data)
          return
        }
        const untouched =
          stateRef.current.past.length === 0 && stateRef.current.future.length === 0
        if (untouched && data.updatedAt !== cached.updatedAt) initFrom(data)
      })
      .catch(() => {
        if (!cancelled && !cached) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [automationId])

  // ------------------------------------------------------------------
  // Guardado manual del editor
  // ------------------------------------------------------------------
  const persistAutomation = useCallback(async (options: { notify?: boolean } = {}) => {
    const current = automationRef.current
    if (!current) return false
    const trimmedName = nameRef.current.trim()
    if (!trimmedName) {
      setSaveState('error')
      if (options.notify) {
        showToast('error', 'No se pudo guardar', 'Ponle un nombre a la automatización')
      }
      return false
    }
    setSaveState('saving')
    try {
      const updated = await automationsService.updateAutomation(current.id, {
        name: trimmedName,
        flow: {
          nodes: stateRef.current.present.nodes,
          edges: stateRef.current.present.edges,
          viewport: viewportRef.current,
          settings: flowSettingsRef.current
        }
      })
      setAutomation((value) =>
        value
          ? {
              ...value,
              name: updated.name,
              updatedAt: updated.updatedAt,
              hasUnpublishedChanges: updated.hasUnpublishedChanges ?? value.hasUnpublishedChanges
            }
          : value
      )
      if (nameRef.current !== updated.name) {
        nameRef.current = updated.name
        setName(updated.name)
      }
      savedContentSignatureRef.current = automationContentSignature(
        updated.name,
        stateRef.current.present.nodes,
        stateRef.current.present.edges,
        flowSettingsRef.current
      )
      const stillDirty = getHasUnsavedChanges()
      setSaveState(stillDirty ? 'dirty' : 'saved')
      if (options.notify && !stillDirty) {
        showToast('success', 'Automatización guardada', 'Los cambios quedaron guardados')
      }
      return true
    } catch {
      setSaveState('error')
      if (options.notify) {
        showToast('error', 'No se pudo guardar', 'Revisa tu conexión e intenta de nuevo')
      }
      return false
    }
  }, [getHasUnsavedChanges, showToast])
  persistAutomationRef.current = persistAutomation

  const commitNameChange = useCallback(() => {
    const current = automationRef.current
    if (!current || saveState === 'saving' || statusBusy) return

    const rawName = nameRef.current
    const trimmedName = rawName.trim()
    if (rawName !== trimmedName) {
      nameRef.current = trimmedName
      setName(trimmedName)
    }

    if (!trimmedName) {
      setSaveState('error')
      showToast('error', 'No se pudo guardar', 'Ponle un nombre a la automatización')
      return
    }
    if (trimmedName === current.name) return

    void persistAutomation({ notify: false })
  }, [persistAutomation, saveState, showToast, statusBusy])

  useEffect(() => {
    if (!automation) return
    const dirty = getHasUnsavedChanges()
    setSaveState((current) => (current === 'saving' ? current : dirty ? 'dirty' : 'saved'))
  }, [automation, currentContentSignature, getHasUnsavedChanges])

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

  const refreshWebhookSample = useCallback(async (endpointId: string) => {
    const currentAutomation = automationRef.current
    if (!currentAutomation || !endpointId) return null
    const latest = await automationsService.getAutomation(currentAutomation.id)
    const latestNodes = migrateLegacyFlow(latest.flow.nodes)
    const latestStart = latestNodes.find(isStartNode)
    const latestTrigger = latestStart
      ? getStartTriggers(latestStart).find((trigger) => String(trigger.config?.endpointId || '') === endpointId)
      : undefined

    if (!latestTrigger?.config?.sampleResponse) return null

    const current = stateRef.current.present
    const currentStart = current.nodes.find(isStartNode)
    if (!currentStart) return latestTrigger.config

    const triggers = getStartTriggers(currentStart).map((trigger) =>
      String(trigger.config?.endpointId || '') === endpointId
        ? {
            ...trigger,
            config: {
              ...trigger.config,
              sampleResponse: latestTrigger.config.sampleResponse,
              sampleReceivedAt: latestTrigger.config.sampleReceivedAt,
              sampleMethod: latestTrigger.config.sampleMethod,
              sampleStatus: 'received'
            }
          }
        : trigger
    )
    updateNodeConfig(currentStart.id, { ...currentStart.config, triggers }, false)
    return latestTrigger.config
  }, [updateNodeConfig])

  const testWebhookAction = useCallback(async (nodeConfig: Record<string, unknown>) => {
    const currentConfig = configRef.current
    if (!currentConfig?.nodeId) {
      throw new Error('Selecciona el webhook antes de probarlo')
    }
    const current = stateRef.current.present
    return automationsService.testWebhookAction({
      nodeId: currentConfig.nodeId,
      config: nodeConfig,
      flow: {
        nodes: current.nodes,
        edges: current.edges,
        viewport: viewportRef.current,
        settings: flowSettingsRef.current
      }
    })
  }, [])

  // ------------------------------------------------------------------
  // Selección / creación de pasos desde los globos
  // ------------------------------------------------------------------
  const collectNodeConfigErrors = useCallback((node: AutomationNode): string[] => {
    if (isStartNode(node)) {
      return getStartTriggers(node).flatMap((trigger) => {
        const definition = getNodeDefinition(trigger.type)
        if (!definition) return ['Hay un disparador de un tipo desconocido']
        return validateNodeConfig(definition, trigger.config || {}).map(
          (error) => `${definition.label}: ${error}`
        )
      })
    }
    const definition = getNodeDefinition(node.type)
    if (!definition) return ['Este paso tiene un tipo desconocido']
    return validateNodeConfig(definition, node.config || {})
  }, [])

  const syncNodeConfigErrors = useCallback(
    (node: AutomationNode) => {
      const errors = collectNodeConfigErrors(node)
      setNodeErrors((current) => {
        const next = { ...current }
        if (errors.length > 0) next[node.id] = errors
        else delete next[node.id]
        return next
      })
      return errors
    },
    [collectNodeConfigErrors]
  )

  const markOpenConfigErrors = useCallback(() => {
    const current = configRef.current
    if (!current) return
    const node = stateRef.current.present.nodes.find((candidate) => candidate.id === current.nodeId)
    if (node) syncNodeConfigErrors(node)
  }, [syncNodeConfigErrors])

  const closeConfig = useCallback(() => {
    markOpenConfigErrors()
    setConfig(null)
  }, [markOpenConfigErrors])

  const openConfigForNode = useCallback((node: AutomationNode, anchor?: { x: number; y: number }) => {
    if (configRef.current && configRef.current.nodeId !== node.id) {
      markOpenConfigErrors()
    }
    const viewport = viewportRef.current
    const screenAnchor = anchor || {
      x: (node.position.x + NODE_WIDTH) * viewport.zoom + viewport.x + 36,
      y: node.position.y * viewport.zoom + viewport.y
    }
    setConfigViewport(viewport)
    setConfig({
      nodeId: node.id,
      anchorWorld: editorPointToWorld(screenAnchor, viewport),
      committed: false
    })
  }, [editorPointToWorld, markOpenConfigErrors])

  const handlePickStep = useCallback(
    (definition: NodeDefinition) => {
      if (!picker) return

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
          const screenAnchor = {
            x: (startNode.position.x + 320) * viewport.zoom + viewport.x + 36,
            y: startNode.position.y * viewport.zoom + viewport.y
          }
          setConfigViewport(viewport)
          setConfig({
            nodeId: startNode.id,
            triggerId: entry.id,
            anchorWorld: editorPointToWorld(screenAnchor, viewport),
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

  const canUseNodeDefinition = useCallback(
    (definition: NodeDefinition) => !definition.requiredFeature || hasLicenseFeature(user, [definition.requiredFeature]),
    [user]
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
          markOpenConfigErrors()
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
      // Tarjeta "Elegir primer paso" en automatizaciones vacías
      onCreateFirstStep: (type: string, position: { x: number; y: number }) => {
        const current = stateRef.current.present
        const startNode = current.nodes.find(isStartNode)
        if (!startNode) return
        const node = createNode(type, position)
        const edges = connectNodes(current.edges, startNode.id, 'out', node.id)
        commitFlow([...current.nodes, node], edges)
        setSelectedNodeId(node.id)
        const definition = getNodeDefinition(type)
        if (definition && (definition.fields.length > 0 || definition.configComponent)) {
          openConfigForNode(node)
        }
      },
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
        setNodeErrors((errors) => {
          const next = { ...errors }
          delete next[node.id]
          return next
        })
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
      // Alt + arrastrar un paso: crea una copia en el mismo lugar y el
      // arrastre continúa moviendo la copia (atajo para duplicar)
      onDuplicateNodeForDrag: (node: AutomationNode): AutomationNode | null => {
        if (isStartNode(node)) return null
        const current = stateRef.current.present
        const copy: AutomationNode = {
          ...node,
          id: genId('node'),
          position: { ...node.position },
          config: JSON.parse(JSON.stringify(node.config || {}))
        }
        commitFlow([...current.nodes, copy])
        setSelectedNodeId(copy.id)
        setMultiSelectedIds(new Set([copy.id]))
        return copy
      },
      onOpenConfig: (node: AutomationNode, anchor: { x: number; y: number }) => {
        openConfigForNode(node, anchor)
      },
      onRequestPicker: (request: PickerRequest) => {
        markOpenConfigErrors()
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
        markOpenConfigErrors()
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
        if (configRef.current && configRef.current.triggerId !== triggerId) {
          markOpenConfigErrors()
        }
        setPicker(null)
        setSelectedNodeId(node.id)
        const viewport = viewportRef.current
        setConfigViewport(viewport)
        setConfig({ nodeId: node.id, triggerId, anchorWorld: editorPointToWorld(anchor, viewport), committed: false })
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
        const nextNode = nextNodes.find((candidate) => candidate.id === node.id)
        if (nextNode && nodeErrors[node.id]?.length) {
          syncNodeConfigErrors(nextNode)
        }
        setConfig((value) => (value?.triggerId === triggerId ? null : value))
      },
      onViewportChange: (viewport: AutomationViewport) => {
        viewportRef.current = viewport
        if (configRef.current) setConfigViewport(viewport)
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
      onAddStickyNote: (position: { x: number; y: number }) => {
        markOpenConfigErrors()
        setPicker(null)
        const current = stateRef.current.present
        const node = createNode('extra-comment', position)
        commitFlow([...current.nodes, node], current.edges)
        setSelectedNodeId(node.id)
        setMultiSelectedIds(new Set([node.id]))
        openConfigForNode(node)
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
    [
      commitFlow,
      editorPointToWorld,
      findFreeOutput,
      markOpenConfigErrors,
      nodeErrors,
      openConfigForNode,
      selectedNodeId,
      showToast,
      syncNodeConfigErrors
    ]
  )

  // ------------------------------------------------------------------
  // FAB "+"
  // ------------------------------------------------------------------
  const handleFabClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    markOpenConfigErrors()
    setConfig(null)
    const current = stateRef.current.present
    const selected = selectedNodeId ? current.nodes.find((node) => node.id === selectedNodeId) : undefined
    const freeHandle = selected ? findFreeOutput(selected) : null
    const viewport = viewportRef.current
    const bounds = canvasBoundsRef.current
    const buttonRect = event.currentTarget.getBoundingClientRect()
    const canvasRect = event.currentTarget
      .closest('[data-automation-canvas-wrap]')
      ?.getBoundingClientRect()
    const anchor = canvasRect
      ? {
          x: buttonRect.left - canvasRect.left - 10,
          y: buttonRect.top - canvasRect.top
        }
      : { x: bounds.width - 72, y: 18 }

    setPicker({
      kind: 'action',
      variant: 'anchored',
      placement: 'left-start',
      anchor,
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
  // Teclado global (guardar, eliminar, deshacer/rehacer, escape)
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

      if (emailEditorRef.current) {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
        }
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void persistAutomation({ notify: true })
        return
      }

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
          if (config) closeConfig()
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
  }, [canvasActions, closeConfig, config, persistAutomation, picker, selectedEdgeId, selectedNodeId, multiSelectedIds])

  // ------------------------------------------------------------------
  // Nombre, estado, publicar, vista previa
  // ------------------------------------------------------------------
  const changeStatus = async (status: AutomationStatus) => {
    const current = automationRef.current
    if (!current || statusBusy) return

    if (status === 'published') {
      const validation = validateAutomationFlow(stateRef.current.present.nodes, stateRef.current.present.edges)
      if (!validation.valid) {
        setNodeErrors(validation.nodeErrors)
        const summary = validation.issues.slice(0, 3).map((issue) => issue.message).join('. ')
        const extra = validation.issues.length > 3 ? ` (+${validation.issues.length - 3} más)` : ''
        showToast('error', 'No se puede publicar', `Corrige los campos faltantes: ${summary}${extra}`)
        return
      }
    }

    setStatusBusy(true)
    try {
      const hadPendingChanges = Boolean(current.hasUnpublishedChanges || getHasUnsavedChanges())
      const saved = await persistAutomation()
      if (!saved) {
        showToast('error', 'No se pudo guardar', 'Revisa el nombre o tu conexión e intenta de nuevo')
        return
      }
      const updated = await automationsService.updateAutomation(current.id, { status })
      setAutomation((value) =>
        value
          ? {
              ...value,
              status: updated.status,
              publishedAt: updated.publishedAt,
              updatedAt: updated.updatedAt,
              hasUnpublishedChanges: updated.hasUnpublishedChanges ?? false,
              reviewStatus: updated.reviewStatus
            }
          : value
      )
      setNodeErrors(reviewIssuesToNodeErrors(updated.reviewStatus?.issues))
      if (status === 'published') {
        setSaveState('saved')
        showToast(
          'success',
          hadPendingChanges ? 'Cambios publicados' : 'Automatización publicada',
          'Tu automatización está en vivo'
        )
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

  const duplicateCurrentAutomation = async () => {
    const current = automationRef.current
    if (!current) return
    try {
      const saved = await persistAutomation()
      if (!saved) return
      const copy = await automationsService.duplicateAutomation(current.id)
      showToast('success', 'Automatización duplicada', copy.name)
      navigate(`/automations/${copy.id}`)
    } catch {
      showToast('error', 'No se pudo duplicar la automatización')
    }
  }

  const handleDuplicateAutomation = () => {
    confirmLeavingIfNeeded(() => {
      void duplicateCurrentAutomation()
    })
  }

  const handleDeleteAutomation = () => {
    const current = automationRef.current
    if (!current) return
    showConfirm(
      'Eliminar automatización',
      `Se eliminará "${current.name}" junto con su flujo y configuración. Esta acción no se puede deshacer.`,
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
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
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
          <Button variant="secondary" size="sm" onClick={() => navigateFromEditor('/automations')}>
            Volver a Automatizaciones
          </Button>
        </div>
      </div>
    )
  }

  if (!automation) {
    return (
      <div className={styles.editorShell}>
        <div className={styles.editorLoading} role="status" aria-live="polite" aria-label="Cargando automatización">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
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
  const waitMessageSources =
    configNode && !config?.triggerId ? getWaitMessageSourceOptions(nodes, edges, configNode.id) : []
  const configAnchor = config
    ? {
        x: config.anchorWorld.x * configViewport.zoom + configViewport.x,
        y: config.anchorWorld.y * configViewport.zoom + configViewport.y
      }
    : null

  const handleConfigChange = (nextConfig: Record<string, unknown>) => {
    if (!config || !configNode) return
    const withHistory = !config.committed
    if (withHistory) setConfig({ ...config, committed: true })

    if (config.triggerId) {
      const triggers = getStartTriggers(configNode).map((trigger) =>
        trigger.id === config.triggerId ? { ...trigger, config: nextConfig } : trigger
      )
      const mergedConfig = { ...configNode.config, triggers }
      updateNodeConfig(configNode.id, mergedConfig, withHistory)
      if (nodeErrors[configNode.id]?.length) {
        syncNodeConfigErrors({ ...configNode, config: mergedConfig })
      }
    } else {
      updateNodeConfig(configNode.id, nextConfig, withHistory)
      if (nodeErrors[configNode.id]?.length) {
        syncNodeConfigErrors({ ...configNode, config: nextConfig })
      }
    }
  }

  const handleOpenRichEmailEditor = (request: EmailRichEditorRequest) => {
    const currentConfig = configRef.current
    if (!currentConfig) return

    const nextEmailEditor = {
      ...request,
      nodeId: currentConfig.nodeId,
      triggerId: currentConfig.triggerId,
      committed: currentConfig.committed
    }
    emailEditorRef.current = nextEmailEditor
    configRef.current = null
    setEmailEditor(nextEmailEditor)
    setPicker(null)
    setConfig(null)
  }

  const closeRichEmailEditor = () => {
    emailEditorRef.current = null
    setEmailEditor(null)
  }

  const handleSaveRichEmailEditor = (nextConfig: EmailEditorSaveConfig) => {
    if (!emailEditor) return

    const current = stateRef.current.present
    const node = current.nodes.find((candidate) => candidate.id === emailEditor.nodeId)
    if (!node) {
      closeRichEmailEditor()
      return
    }

    const withHistory = !emailEditor.committed
    if (emailEditor.triggerId) {
      const triggers = getStartTriggers(node).map((trigger) =>
        trigger.id === emailEditor.triggerId
          ? { ...trigger, config: { ...trigger.config, ...nextConfig } }
          : trigger
      )
      const mergedConfig = { ...node.config, triggers }
      updateNodeConfig(node.id, mergedConfig, withHistory)
      if (nodeErrors[node.id]?.length) {
        syncNodeConfigErrors({ ...node, config: mergedConfig })
      }
    } else {
      const mergedConfig = { ...node.config, ...nextConfig }
      updateNodeConfig(node.id, mergedConfig, withHistory)
      if (nodeErrors[node.id]?.length) {
        syncNodeConfigErrors({ ...node, config: mergedConfig })
      }
    }

    closeRichEmailEditor()
  }

  const status = automation.status
  const currentAutomationSummary = toAutomationSummary(automation)
  const requiresReview = automation.reviewStatus?.state === 'requires_review'
  const reviewSummary = automation.reviewStatus?.summary || 'Hay referencias que ya no existen.'
  const hasDraftChanges = hasUnsavedChanges || hasUnpublishedChanges
  const automationHasPublishedVersion = Boolean(automation.publishedAt) || status === 'published' || status === 'paused'
  const dirtyActionTarget = hasDraftChanges
    ? automationHasPublishedVersion
      ? 'publish'
      : 'save'
    : null
  const saveIndicatorMode =
    saveState === 'saving' || statusBusy
      ? 'saving'
      : saveState === 'error'
        ? 'error'
        : hasUnsavedChanges
          ? 'dirty'
          : hasUnpublishedChanges
            ? 'unpublished'
            : 'saved'
  const saveIndicatorText =
    saveIndicatorMode === 'saving'
      ? 'Guardando…'
      : saveIndicatorMode === 'error'
        ? 'Error al guardar'
        : saveIndicatorMode === 'dirty'
          ? 'Cambios sin guardar'
          : saveIndicatorMode === 'unpublished'
            ? 'Cambios sin publicar'
            : 'Guardado'
  const publishButtonLabel = hasDraftChanges
    ? 'Publicar'
    : status === 'paused'
      ? 'Reanudar'
      : 'Publicar'

  const openTestRun = () => {
    if (hasUnsavedChanges) {
      showToast(
        'warning',
        'Guarda la automatización antes de probar',
        'La prueba usa la última versión guardada para ejecutar lo mismo que estás validando.'
      )
      return
    }

    const validation = validateAutomationFlow(stateRef.current.present.nodes, stateRef.current.present.edges)
    if (!validation.valid) {
      setNodeErrors(validation.nodeErrors)
      const summary = validation.issues.slice(0, 3).map((issue) => issue.message).join('. ')
      const extra = validation.issues.length > 3 ? ` (+${validation.issues.length - 3} más)` : ''
      showToast('warning', 'Corrige la automatización antes de probar', `${summary}${extra}`)
      return
    }

    if (status === 'archived') {
      showToast('warning', 'No puedes probar una automatización archivada')
      return
    }
    setTestRunOpen(true)
  }

  // Flecha fantasma mientras el selector está abierto tras soltar el conector
  const pendingEdge: PendingEdge | null =
    picker && picker.source && picker.placeAtWorldPoint
      ? { source: picker.source, point: picker.worldPoint }
      : null

  return (
    <VariableCategoriesContext.Provider value={variableCategories}>
    <FlowVariablesContext.Provider value={flowVariableCatalog}>
    <div className={styles.editorShell}>
      {/* ----------------------------- Toolbar ---------------------------- */}
      <header className={styles.toolbar}>
        <button
          type="button"
          className={styles.toolbarBack}
          title="Volver a Automatizaciones"
          onClick={() => navigateFromEditor('/automations')}
        >
          <ArrowLeft size={15} />
        </button>

        <input
          className={styles.toolbarName}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitNameChange}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          }}
          aria-label="Nombre de la automatización"
        />

        {/* Deshacer / Rehacer junto al título */}
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

        <div className={styles.toolbarCenterGroup}>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<SettingsIcon size={13} />}
            onClick={() => setSettingsOpen(true)}
          >
            Configuración
          </Button>
          <div className={styles.toolbarTabList} role="tablist" aria-label="Registros de automatización">
            <button
              type="button"
              role="tab"
              aria-selected={recordsTab === 'enrollments'}
              className={cn(styles.toolbarTab, recordsTab === 'enrollments' && styles.toolbarTabActive)}
              onClick={() => setRecordsTab('enrollments')}
            >
              Historial de inscripciones
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={recordsTab === 'executions'}
              className={cn(styles.toolbarTab, recordsTab === 'executions' && styles.toolbarTabActive)}
              onClick={() => setRecordsTab('executions')}
            >
              Registros de ejecución
            </button>
          </div>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Play size={13} />}
            disabled={statusBusy || saveState === 'saving'}
            onClick={openTestRun}
          >
            Probar
          </Button>
        </div>

        <div className={styles.toolbarSpacer} />

        <div className={styles.toolbarGroup}>
          <span
            className={cn(
              styles.saveIndicator,
              saveIndicatorMode === 'error' && styles.saveIndicatorError,
              (saveIndicatorMode === 'dirty' || saveIndicatorMode === 'unpublished') && styles.saveIndicatorWarning
            )}
          >
            {saveIndicatorMode === 'saving' && <Loader2 size={12} className="animate-spin" />}
            {saveIndicatorMode === 'saved' && <Check size={12} />}
            {saveIndicatorMode === 'error' && <CloudOff size={12} />}
            {saveIndicatorText}
          </span>
          <Button
            variant="secondary"
            size="sm"
            className={dirtyActionTarget === 'save' ? styles.dirtyActionButton : undefined}
            leftIcon={<Save size={13} />}
            disabled={saveState === 'saving' || statusBusy}
            onClick={() => void persistAutomation({ notify: true })}
          >
            Guardar
          </Button>
          <Button variant="secondary" size="sm" leftIcon={<Eye size={13} />} onClick={() => setPreviewOpen(true)}>
            Vista previa
          </Button>

          {status === 'published' && !hasDraftChanges ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Pause size={13} />}
              disabled={statusBusy || saveState === 'saving'}
              onClick={() => void changeStatus('paused')}
            >
              Pausar
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              className={cn(styles.publishButton, dirtyActionTarget === 'publish' && styles.dirtyActionButton)}
              leftIcon={<Play size={13} />}
              disabled={statusBusy || saveState === 'saving'}
              onClick={() => void changeStatus('published')}
            >
              {publishButtonLabel}
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={styles.iconButton} title="Más opciones">
                <MoreVertical size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={handleDuplicateAutomation}>
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

      {requiresReview && (
        <div className={styles.reviewBanner} role="alert">
          <AlertTriangle size={16} className={styles.reviewBannerIcon} />
          <span>
            <strong>{AUTOMATION_REVIEW_LABEL}.</strong> {reviewSummary}
          </span>
        </div>
      )}

      {/* ------------------------------ Canvas ----------------------------- */}
      <div className={styles.editorMain}>
        <AutomationLibrary
          currentAutomationId={automation.id}
          currentAutomation={currentAutomationSummary}
          onOpenAutomation={(targetId) => navigateFromEditor(`/automations/${targetId}`)}
          onAutomationUpdated={handleLibraryAutomationUpdated}
        />
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
        nodeStats={nodeStats}
        hideFirstStepGhost={Boolean(picker) && !emailEditor}
        actions={canvasActions}
      >
        <button
          type="button"
          className={styles.fab}
          title="Agregar paso"
          data-automation-interactive="true"
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={handleFabClick}
        >
          <Plus size={20} />
        </button>

        {!emailEditor && picker && (
          <StepPickerBubble
            kind={picker.kind}
            variant={picker.variant}
            placement={picker.placement}
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
            definitionFilter={canUseNodeDefinition}
            onSelect={handlePickStep}
            onClose={() => setPicker(null)}
          />
        )}

        {/* Panel de configuración flotante junto al evento */}
        {!emailEditor && config && configNode && configDefinition && configAnchor && (
          <NodeConfigBubble
            definition={configDefinition}
            config={(configTrigger ? configTrigger.config : configNode.config) || {}}
            anchor={configAnchor}
            bounds={canvasBounds}
            onChange={handleConfigChange}
            waitMessageSources={waitMessageSources}
            onRefreshWebhookSample={refreshWebhookSample}
            onTestWebhookAction={testWebhookAction}
            onOpenRichEmailEditor={handleOpenRichEmailEditor}
            onClose={closeConfig}
          />
        )}
      </AutomationCanvas>
      </div>

      <RichEmailEditorModal
        open={Boolean(emailEditor)}
        subject={emailEditor?.subject || ''}
        body={emailEditor?.body || ''}
        bodyHtml={emailEditor?.bodyHtml || ''}
        includeSignature={emailEditor?.includeSignature ?? true}
        variables={emailEditor?.variables || []}
        onClose={closeRichEmailEditor}
        onSave={handleSaveRichEmailEditor}
      />

      {/* ------------------ Inscripciones y registros ----------------------- */}
      <EnrollmentRecordsModal
        automationId={automation.id}
        nodes={nodes}
        open={recordsTab !== null}
        initialTab={recordsTab || 'enrollments'}
        onClose={() => setRecordsTab(null)}
      />

      <AutomationTestRunModal
        automationId={automation.id}
        automationName={automation.name}
        open={testRunOpen}
        onClose={() => setTestRunOpen(false)}
        onTested={() => {
          void automationsService
            .getEnrollmentStats(automation.id)
            .then((stats) => setNodeStats(stats.byNode || {}))
            .catch(() => undefined)
        }}
        onOpenRecords={() => {
          setTestRunOpen(false)
          setRecordsTab('executions')
        }}
      />

      {/* ----------------------- Configuración del flujo --------------------- */}
      <FlowSettingsPanel
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false)
        }}
        name={name}
        onRename={setName}
        onCommitName={commitNameChange}
        settings={flowSettings}
        onChange={(next) => {
          setFlowSettings(next)
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
    </FlowVariablesContext.Provider>
    </VariableCategoriesContext.Provider>
  )
}
