import type {
  AutomationEdge,
  AutomationNode,
  AutomationTriggerEntry
} from '@/services/automationsService'
import { getNodeDefinition, START_NODE_TYPE, type NodeOutputHandle } from './nodeRegistry'

export const NODE_WIDTH = 300
export const NODE_GAP_X = 140
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 2

export function genId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}${random}`
}

export function isStartNode(node: AutomationNode): boolean {
  return node.type === START_NODE_TYPE
}

export function getStartTriggers(node: AutomationNode): AutomationTriggerEntry[] {
  const triggers = node.config?.triggers
  return Array.isArray(triggers) ? (triggers as AutomationTriggerEntry[]) : []
}

/** Salidas de un nodo (la tarjeta inicial siempre tiene la salida "Entonces") */
export function getNodeOutputs(node: AutomationNode): NodeOutputHandle[] {
  if (isStartNode(node)) {
    return [{ id: 'out', label: 'Entonces' }]
  }
  const definition = getNodeDefinition(node.type)
  if (!definition) return [{ id: 'out', label: 'Siguiente paso' }]
  return definition.outputs(node.config || {})
}

export function nodeHasInput(node: AutomationNode): boolean {
  if (isStartNode(node)) return false
  const definition = getNodeDefinition(node.type)
  return !definition?.noInput
}

/** Crea un nodo nuevo de un tipo del registro en la posición indicada */
export function createNode(type: string, position: { x: number; y: number }): AutomationNode {
  const definition = getNodeDefinition(type)
  return {
    id: genId('node'),
    type,
    category: definition?.category,
    label: definition?.label,
    position: { x: Math.round(position.x), y: Math.round(position.y) },
    config: definition ? definition.defaultConfig() : {}
  }
}

/** Posición sugerida para el siguiente paso de un nodo (a su derecha) */
export function nextNodePosition(
  source: AutomationNode,
  sourceHandle: string,
  existingNodes: AutomationNode[]
): { x: number; y: number } {
  const outputs = getNodeOutputs(source)
  const handleIndex = Math.max(0, outputs.findIndex((output) => output.id === sourceHandle))
  const base = {
    x: source.position.x + NODE_WIDTH + NODE_GAP_X,
    y: source.position.y + handleIndex * 150
  }

  // Evita encimar nodos: baja la posición mientras haya colisiones aproximadas
  let candidate = { ...base }
  const collides = (point: { x: number; y: number }) =>
    existingNodes.some(
      (node) =>
        Math.abs(node.position.x - point.x) < NODE_WIDTH * 0.8 &&
        Math.abs(node.position.y - point.y) < 120
    )
  let guard = 0
  while (collides(candidate) && guard < 20) {
    candidate = { x: candidate.x, y: candidate.y + 160 }
    guard += 1
  }
  return candidate
}

function buildAdjacency(edges: AutomationEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>()
  edges.forEach((edge) => {
    const list = adjacency.get(edge.sourceNodeId) || []
    list.push(edge.targetNodeId)
    adjacency.set(edge.sourceNodeId, list)
  })
  return adjacency
}

/** ¿Existe un camino de `from` hacia `to`? (para evitar ciclos) */
export function hasPath(edges: AutomationEdge[], from: string, to: string): boolean {
  if (from === to) return true
  const adjacency = buildAdjacency(edges)
  const queue = [from]
  const visited = new Set<string>([from])
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const next of adjacency.get(current) || []) {
      if (next === to) return true
      if (!visited.has(next)) {
        visited.add(next)
        queue.push(next)
      }
    }
  }
  return false
}

export interface ConnectionCheck {
  valid: boolean
  reason?: string
}

/** Reglas de conexión entre nodos */
export function canConnect(
  nodes: AutomationNode[],
  edges: AutomationEdge[],
  sourceNodeId: string,
  sourceHandle: string,
  targetNodeId: string
): ConnectionCheck {
  if (sourceNodeId === targetNodeId) {
    return { valid: false, reason: 'Un paso no puede conectarse consigo mismo' }
  }

  const source = nodes.find((node) => node.id === sourceNodeId)
  const target = nodes.find((node) => node.id === targetNodeId)
  if (!source || !target) {
    return { valid: false, reason: 'La conexión apunta a un paso inexistente' }
  }

  if (!nodeHasInput(target)) {
    return {
      valid: false,
      reason: isStartNode(target)
        ? 'No puedes conectar pasos hacia la tarjeta "Cuando..."'
        : 'Este paso no acepta conexiones de entrada'
    }
  }

  if (getNodeOutputs(source).every((output) => output.id !== sourceHandle)) {
    return { valid: false, reason: 'La salida seleccionada ya no existe' }
  }

  const duplicated = edges.some(
    (edge) =>
      edge.sourceNodeId === sourceNodeId &&
      edge.sourceHandle === sourceHandle &&
      edge.targetNodeId === targetNodeId
  )
  if (duplicated) {
    return { valid: false, reason: 'Esa conexión ya existe' }
  }

  // Evitar ciclos: si desde el destino se puede llegar al origen, se formaría un ciclo.
  // Se ignora la conexión actual de esta misma salida porque será reemplazada.
  const remaining = edges.filter(
    (edge) => !(edge.sourceNodeId === sourceNodeId && edge.sourceHandle === sourceHandle)
  )
  if (hasPath(remaining, targetNodeId, sourceNodeId)) {
    return { valid: false, reason: 'Esta conexión crearía un ciclo en el flujo' }
  }

  return { valid: true }
}

/**
 * Conecta dos nodos. Cada salida tiene una sola conexión: si la salida ya
 * estaba conectada, la conexión anterior se reemplaza.
 */
export function connectNodes(
  edges: AutomationEdge[],
  sourceNodeId: string,
  sourceHandle: string,
  targetNodeId: string,
  label?: string
): AutomationEdge[] {
  const withoutPrevious = edges.filter(
    (edge) => !(edge.sourceNodeId === sourceNodeId && edge.sourceHandle === sourceHandle)
  )
  return [
    ...withoutPrevious,
    {
      id: genId('edge'),
      sourceNodeId,
      sourceHandle,
      targetNodeId,
      targetHandle: 'in',
      label,
      animated: true
    }
  ]
}

/** Elimina un nodo y todas sus conexiones */
export function removeNode(
  nodes: AutomationNode[],
  edges: AutomationEdge[],
  nodeId: string
): { nodes: AutomationNode[]; edges: AutomationEdge[] } {
  return {
    nodes: nodes.filter((node) => node.id !== nodeId),
    edges: edges.filter((edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId)
  }
}

/** Limpia conexiones cuya salida ya no existe (ej. al quitar una rama) */
export function pruneInvalidEdges(nodes: AutomationNode[], edges: AutomationEdge[]): AutomationEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id))
  return edges.filter((edge) => {
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) return false
    const source = nodes.find((node) => node.id === edge.sourceNodeId) as AutomationNode
    return getNodeOutputs(source).some((output) => output.id === edge.sourceHandle)
  })
}

// ---------------------------------------------------------------------------
// Migración de flujos guardados con tipos/configs de versiones anteriores
// ---------------------------------------------------------------------------

interface LegacyConditionRow {
  field?: string
  operator?: string
  value?: string
}

const LEGACY_OPERATOR_MAP: Record<string, string> = {
  equals: 'is',
  not_equals: 'is_not',
  contains: 'contains',
  not_contains: 'not_contains',
  greater: 'gt',
  less: 'lt',
  empty: 'empty',
  not_empty: 'not_empty'
}

function migrateLegacyConditions(rows: LegacyConditionRow[]): Record<string, unknown> {
  return {
    match: 'all',
    rules: rows
      .filter((row) => row && (row.field || row.value))
      .map((row) => ({
        field: 'contact-custom-field',
        customKey: row.field || '',
        operator: LEGACY_OPERATOR_MAP[row.operator || ''] || 'contains',
        value: row.value || ''
      }))
  }
}

const LEGACY_CHANNELS: Record<string, string> = { sms: 'any', email: 'any', telegram: 'whatsapp' }

/**
 * Convierte nodos guardados por versiones anteriores del editor al modelo
 * actual: If/Else → Condición, Telegram/Canal → WhatsApp, esperas con el
 * modelo viejo, y canales que ya no existen (SMS/Email) → "cualquier canal".
 */
export function migrateLegacyFlow(nodes: AutomationNode[]): AutomationNode[] {
  return nodes.map((node) => {
    let next = node
    const config = { ...(node.config || {}) }

    // Canales retirados en configs sueltas
    ;['channel', 'replyChannel'].forEach((key) => {
      const value = config[key]
      if (typeof value === 'string' && LEGACY_CHANNELS[value]) {
        config[key] = LEGACY_CHANNELS[value]
        next = { ...next, config }
      }
    })

    if (node.type === 'logic-if-else' || (node.type === 'logic-condition' && Array.isArray(config.conditions))) {
      const migrated = migrateLegacyConditions((config.conditions as LegacyConditionRow[]) || [])
      return { ...next, type: 'logic-condition', label: 'Condición', config: migrated }
    }

    if (node.type === 'channel-telegram' || node.type === 'channel-generic') {
      const channel = typeof config.channel === 'string' ? config.channel : 'whatsapp'
      const target =
        channel === 'messenger'
          ? 'channel-messenger'
          : channel === 'instagram'
            ? 'channel-instagram'
            : 'channel-whatsapp'
      const message = typeof config.message === 'string' ? config.message : ''
      const migrated =
        target === 'channel-whatsapp'
          ? { sender: 'default', messageType: 'text', message }
          : { message }
      return { ...next, type: target, label: undefined, config: migrated }
    }

    if (node.type === 'logic-wait' && (config.mode === 'until' || (config.mode === 'duration' && config.untilDate !== undefined && !('name' in config)))) {
      return {
        ...next,
        config: {
          ...config,
          name: 'Esperar',
          mode: config.mode === 'until' ? 'datetime' : 'duration'
        }
      }
    }

    if (node.type === 'logic-goal' && typeof config.goal === 'string' && !('goalType' in config)) {
      return { ...next, config: { name: config.goal, goalType: '' } }
    }

    return next
  })
}

export interface EdgeGeometry {
  path: string
  midX: number
  midY: number
}

/** Curva suave de izquierda a derecha entre dos puntos */
export function edgePath(sx: number, sy: number, tx: number, ty: number): EdgeGeometry {
  const dx = Math.max(48, Math.abs(tx - sx) * 0.45)
  const c1x = sx + dx
  const c2x = tx - dx
  const path = `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ty}, ${tx} ${ty}`
  // Punto medio aproximado de la curva (t = 0.5)
  const midX = (sx + 3 * c1x + 3 * c2x + tx) / 8
  const midY = (sy + 3 * sy + 3 * ty + ty) / 8
  return { path, midX, midY }
}
