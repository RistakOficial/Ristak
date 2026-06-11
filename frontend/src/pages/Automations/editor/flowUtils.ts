import type {
  AutomationEdge,
  AutomationNode,
  AutomationTriggerEntry
} from '@/services/automationsService'
import { getNodeDefinition, START_NODE_TYPE, type NodeOutputHandle } from './nodeRegistry'
import { migrateSimpleCondition } from './crmFields'

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

  // Evitar ciclos: si desde el destino se puede llegar al origen, se formaría un ciclo
  if (hasPath(edges, targetNodeId, sourceNodeId)) {
    return { valid: false, reason: 'Esta conexión crearía un ciclo en el flujo' }
  }

  return { valid: true }
}

/**
 * Conecta dos nodos. Una misma salida puede tener varias conexiones hacia
 * pasos distintos (no hace falta crear ramas para bifurcar el flujo).
 */
export function connectNodes(
  edges: AutomationEdge[],
  sourceNodeId: string,
  sourceHandle: string,
  targetNodeId: string,
  label?: string
): AutomationEdge[] {
  return [
    ...edges,
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
  return migrateSimpleCondition({
    match: 'all',
    rules: rows
      .filter((row) => row && (row.field || row.value))
      .map((row) => ({
        field: 'contact-custom-field',
        customKey: row.field || '',
        operator: LEGACY_OPERATOR_MAP[row.operator || ''] || 'contains',
        value: row.value || ''
      }))
  }) as unknown as Record<string, unknown>
}

const LEGACY_CHANNELS: Record<string, string> = { sms: 'any', email: 'any', telegram: 'whatsapp' }

/** Convierte el mensaje plano viejo en bloques de mensaje */
function messageToBlocks(message: string): Array<Record<string, unknown>> {
  return message.trim()
    ? [{ id: genId('blk'), type: 'text', compiledText: message, buttons: [], quickReplies: [] }]
    : []
}

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

    // Condición con el modelo intermedio { match, rules } → modelo avanzado
    if (node.type === 'logic-condition' && Array.isArray(config.rules) && !Array.isArray(config.branches)) {
      return {
        ...next,
        config: migrateSimpleCondition(config as { match?: 'all' | 'any'; rules?: never[] }) as unknown as Record<string, unknown>
      }
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
          ? { sender: 'default', messageType: 'text', messageBlocks: messageToBlocks(message), extraBranches: [] }
          : { messageBlocks: messageToBlocks(message), extraBranches: [] }
      return { ...next, type: target, label: undefined, config: migrated }
    }

    // Mensaje plano viejo en nodos de canal → bloques de mensaje
    if (
      ['channel-whatsapp', 'channel-messenger', 'channel-instagram', 'channel-facebook-message'].includes(node.type) &&
      typeof config.message === 'string' &&
      !Array.isArray(config.messageBlocks)
    ) {
      const { message, ...rest } = config
      return {
        ...next,
        config: { ...rest, messageBlocks: messageToBlocks(message as string), extraBranches: config.extraBranches || [] }
      }
    }

    // "Dividir" retirado → Acciones con ramas extra (conservan ids y conexiones)
    if (node.type === 'logic-split') {
      const branches = Array.isArray(config.branches)
        ? (config.branches as Array<{ id?: string; label?: string }>)
        : []
      return {
        ...next,
        type: 'logic-actions-group',
        label: undefined,
        config: {
          customTitle: typeof node.label === 'string' && node.label !== 'Dividir' ? node.label : 'Ramas',
          notes: '',
          extraBranches: branches.map((branch, index) => ({
            id: branch.id || `branch-${index + 1}`,
            label: branch.label || `Rama ${index + 1}`
          }))
        }
      }
    }

    // "Pausa inteligente" retirada → Esperar (periodo + ventana horaria)
    if (node.type === 'logic-smart-pause') {
      return {
        ...next,
        type: 'logic-wait',
        label: undefined,
        config: {
          name: 'Esperar',
          mode: 'duration',
          amount: Number(config.amount) || 1,
          unit: typeof config.unit === 'string' ? config.unit : 'hours',
          windowEnabled: Boolean(config.windowEnabled),
          windowDays: Array.isArray(config.windowDays) ? config.windowDays : [],
          windowStart: typeof config.windowStart === 'string' ? config.windowStart : '09:00',
          windowEnd: typeof config.windowEnd === 'string' ? config.windowEnd : '18:00',
          outsideWindow: 'next-window',
          timeoutEnabled: false
        }
      }
    }

    if (node.type === 'logic-wait') {
      // La zona horaria ya no vive en el nodo: la define el flujo
      const { timezone, useContactTimezone, windowTimezone, ...rest } = config
      // El modo "condiciones" ahora usa el constructor avanzado
      const waitConditions = rest.conditions as Record<string, unknown> | undefined
      if (waitConditions && Array.isArray(waitConditions.rules) && !Array.isArray(waitConditions.branches)) {
        rest.conditions = migrateSimpleCondition(waitConditions as { match?: 'all' | 'any'; rules?: never[] }) as unknown as Record<string, unknown>
      }
      void timezone
      void useContactTimezone
      void windowTimezone
      if (config.mode === 'until' || (config.mode === 'duration' && config.untilDate !== undefined && !('name' in config))) {
        return {
          ...next,
          config: { ...rest, name: 'Esperar', mode: config.mode === 'until' ? 'datetime' : 'duration' }
        }
      }
      return { ...next, config: rest }
    }

    if (node.type === 'logic-goal' && typeof config.goal === 'string' && !('goalType' in config)) {
      return { ...next, config: { name: config.goal, goalType: '' } }
    }

    return next
  })
}

// ---------------------------------------------------------------------------
// Orden automático del flujo (izquierda → derecha, ramas en vertical)
// ---------------------------------------------------------------------------

const LAYOUT_GAP_X = 140
const LAYOUT_GAP_Y = 48
const DEFAULT_NODE_HEIGHT = 170

/**
 * Acomoda los nodos por capas: disparadores a la izquierda, cada paso a la
 * derecha de su origen y las ramas apiladas verticalmente sin encimarse.
 * Si se pasa `onlyIds`, ordena únicamente esa selección (subgrafo) anclada
 * a la posición actual del grupo.
 */
export function autoLayoutFlow(
  nodes: AutomationNode[],
  edges: AutomationEdge[],
  nodeHeights: Record<string, number> = {},
  onlyIds?: Set<string>
): AutomationNode[] {
  const targetIds = onlyIds && onlyIds.size > 0 ? onlyIds : new Set(nodes.map((node) => node.id))
  const targets = nodes.filter((node) => targetIds.has(node.id))
  if (targets.length === 0) return nodes

  const innerEdges = edges.filter(
    (edge) => targetIds.has(edge.sourceNodeId) && targetIds.has(edge.targetNodeId)
  )

  // Profundidad = distancia más larga desde una raíz (sin entradas internas)
  const incoming = new Map<string, number>()
  targets.forEach((node) => incoming.set(node.id, 0))
  innerEdges.forEach((edge) => incoming.set(edge.targetNodeId, (incoming.get(edge.targetNodeId) || 0) + 1))

  const depth = new Map<string, number>()
  const queue: string[] = []
  targets.forEach((node) => {
    const isRoot = (incoming.get(node.id) || 0) === 0
    if (isRoot || isStartNode(node)) {
      depth.set(node.id, isStartNode(node) ? 0 : depth.get(node.id) ?? 0)
      queue.push(node.id)
    }
  })
  if (queue.length === 0 && targets.length > 0) {
    depth.set(targets[0].id, 0)
    queue.push(targets[0].id)
  }

  const adjacency = new Map<string, string[]>()
  innerEdges.forEach((edge) => {
    const list = adjacency.get(edge.sourceNodeId) || []
    list.push(edge.targetNodeId)
    adjacency.set(edge.sourceNodeId, list)
  })

  // Relajación BFS (el flujo es acíclico: canConnect lo garantiza)
  let guard = 0
  while (queue.length > 0 && guard < 5000) {
    guard += 1
    const current = queue.shift() as string
    const currentDepth = depth.get(current) ?? 0
    for (const nextId of adjacency.get(current) || []) {
      const proposed = currentDepth + 1
      if ((depth.get(nextId) ?? -1) < proposed) {
        depth.set(nextId, proposed)
        queue.push(nextId)
      }
    }
  }
  targets.forEach((node) => {
    if (!depth.has(node.id)) depth.set(node.id, 0)
  })

  // Columnas por profundidad, ordenadas por la posición vertical de sus padres
  const columns = new Map<number, AutomationNode[]>()
  targets.forEach((node) => {
    const column = depth.get(node.id) ?? 0
    const list = columns.get(column) || []
    list.push(node)
    columns.set(column, list)
  })

  const baseX = Math.min(...targets.map((node) => node.position.x))
  const baseY = Math.min(...targets.map((node) => node.position.y))
  const orderIndex = new Map<string, number>()
  const positions = new Map<string, { x: number; y: number }>()

  const parentOrder = (nodeId: string): number => {
    const parents = innerEdges.filter((edge) => edge.targetNodeId === nodeId)
    if (parents.length === 0) return orderIndex.get(nodeId) ?? 0
    const values = parents.map((edge) => orderIndex.get(edge.sourceNodeId) ?? 0)
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }

  const sortedColumns = [...columns.keys()].sort((a, b) => a - b)
  sortedColumns.forEach((column) => {
    const list = (columns.get(column) || []).slice()
    if (column === 0) {
      list.sort((a, b) => a.position.y - b.position.y)
    } else {
      list.sort((a, b) => parentOrder(a.id) - parentOrder(b.id) || a.position.y - b.position.y)
    }
    let y = baseY
    list.forEach((node, index) => {
      orderIndex.set(node.id, index)
      positions.set(node.id, { x: Math.round(baseX + column * (NODE_WIDTH + LAYOUT_GAP_X)), y: Math.round(y) })
      y += (nodeHeights[node.id] || DEFAULT_NODE_HEIGHT) + LAYOUT_GAP_Y
    })
  })

  return nodes.map((node) => {
    const position = positions.get(node.id)
    return position ? { ...node, position } : node
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
