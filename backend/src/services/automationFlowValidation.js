/**
 * Validación y normalización del flujo de una automatización.
 *
 * El flujo se guarda como JSON flexible: { nodes: [], edges: [], viewport: {} }.
 * Estas funciones son puras (sin acceso a BD) para poder probarlas de forma
 * aislada y reutilizarlas desde el servicio al guardar o publicar.
 */

const MAX_FLOW_BYTES = 2 * 1024 * 1024 // 2MB: límite defensivo para el JSON del flujo

export const START_NODE_TYPE = 'start'

// Únicos canales conversacionales soportados (sin SMS ni Email)
export const ALLOWED_CHANNELS = ['whatsapp', 'messenger', 'instagram']
const CHANNEL_CONFIG_KEYS = ['channel', 'replyChannel', 'conversationChannel', 'actionChannel']

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasSampleResponse(value) {
  if (Array.isArray(value)) return value.length > 0
  return isPlainObject(value) && Object.keys(value).length > 0
}

/**
 * Normaliza un flujo recibido del cliente a la forma { nodes, edges, viewport }.
 * No valida reglas de negocio: solo garantiza estructura segura para persistir.
 * Lanza error (status 400) si la estructura es inválida o demasiado grande.
 */
export function normalizeFlow(rawFlow) {
  if (rawFlow === null || rawFlow === undefined) {
    return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
  }

  if (!isPlainObject(rawFlow)) {
    const error = new Error('El flujo de la automatización tiene un formato inválido')
    error.status = 400
    throw error
  }

  const nodes = asArray(rawFlow.nodes).filter(isPlainObject).map((node) => ({
    ...node,
    id: String(node.id || ''),
    type: String(node.type || ''),
    position: isPlainObject(node.position)
      ? { x: Number(node.position.x) || 0, y: Number(node.position.y) || 0 }
      : { x: 0, y: 0 },
    config: isPlainObject(node.config) ? node.config : {}
  }))

  const edges = asArray(rawFlow.edges).filter(isPlainObject).map((edge) => ({
    ...edge,
    id: String(edge.id || ''),
    sourceNodeId: String(edge.sourceNodeId || ''),
    targetNodeId: String(edge.targetNodeId || ''),
    sourceHandle: edge.sourceHandle ? String(edge.sourceHandle) : 'out',
    targetHandle: edge.targetHandle ? String(edge.targetHandle) : 'in',
    animated: edge.animated !== false
  }))

  const viewport = isPlainObject(rawFlow.viewport)
    ? {
        x: Number(rawFlow.viewport.x) || 0,
        y: Number(rawFlow.viewport.y) || 0,
        zoom: Math.min(2.5, Math.max(0.2, Number(rawFlow.viewport.zoom) || 1))
      }
    : { x: 0, y: 0, zoom: 1 }

  const invalidNode = nodes.find((node) => !node.id || !node.type)
  if (invalidNode) {
    const error = new Error('Hay pasos del flujo sin identificador o tipo')
    error.status = 400
    throw error
  }

  // Configuración global del flujo (zona horaria, horarios, reingreso…):
  // se preserva tal cual, es un objeto flexible definido por el editor.
  const settings = isPlainObject(rawFlow.settings) ? rawFlow.settings : undefined

  const flow = settings ? { nodes, edges, viewport, settings } : { nodes, edges, viewport }
  const size = Buffer.byteLength(JSON.stringify(flow), 'utf8')
  if (size > MAX_FLOW_BYTES) {
    const error = new Error('El flujo de la automatización es demasiado grande para guardarse')
    error.status = 400
    throw error
  }

  return flow
}

function detectCycle(nodes, edges) {
  const adjacency = new Map()
  nodes.forEach((node) => adjacency.set(node.id, []))
  edges.forEach((edge) => {
    if (adjacency.has(edge.sourceNodeId)) {
      adjacency.get(edge.sourceNodeId).push(edge.targetNodeId)
    }
  })

  const visiting = new Set()
  const visited = new Set()

  const visit = (nodeId) => {
    if (visiting.has(nodeId)) return true
    if (visited.has(nodeId)) return false
    visiting.add(nodeId)
    for (const next of adjacency.get(nodeId) || []) {
      if (visit(next)) return true
    }
    visiting.delete(nodeId)
    visited.add(nodeId)
    return false
  }

  return nodes.some((node) => visit(node.id))
}

/**
 * Validación estructural mínima antes de publicar una automatización.
 * La validación detallada por tipo de paso vive en el editor (frontend);
 * aquí solo se garantiza que el flujo publicado sea coherente.
 *
 * Devuelve una lista de mensajes de error en español (vacía si es válido).
 */
export function validateFlowForPublish(flow) {
  const errors = []
  const nodes = asArray(flow?.nodes)
  const edges = asArray(flow?.edges)

  const startNode = nodes.find((node) => node.type === START_NODE_TYPE)
  const triggers = asArray(startNode?.config?.triggers)

  if (!startNode || triggers.length === 0) {
    errors.push('Agrega al menos un disparador antes de publicar')
  }

  triggers
    .filter((trigger) => trigger?.type === 'trigger-incoming-webhook')
    .forEach((trigger) => {
      if (!hasSampleResponse(trigger?.config?.sampleResponse)) {
        errors.push('Prueba el webhook y recibe datos reales antes de publicar')
      }
    })

  const nodeIds = new Set(nodes.map((node) => node.id))
  const brokenEdge = edges.find(
    (edge) => !nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)
  )
  if (brokenEdge) {
    errors.push('Hay conexiones que apuntan a pasos que ya no existen')
  }

  nodes
    .filter((node) => node.type === 'randomizer')
    .forEach((node) => {
      const branches = asArray(node.config?.branches)
      const total = branches.reduce((sum, branch) => sum + (Number(branch?.percent) || 0), 0)
      if (branches.length < 2 || total !== 100) {
        errors.push('Las ramas del aleatorizador deben sumar 100%')
      }
    })

  // Canales no soportados (SMS, Email…) en cualquier configuración
  const invalidChannels = new Set()
  const collectChannels = (config) => {
    if (!isPlainObject(config)) return
    CHANNEL_CONFIG_KEYS.forEach((key) => {
      const value = config[key]
      if (typeof value === 'string' && value && value !== 'any' && !ALLOWED_CHANNELS.includes(value)) {
        invalidChannels.add(value)
      }
    })
  }
  nodes.forEach((node) => {
    collectChannels(node.config)
    asArray(node.config?.triggers).forEach((trigger) => collectChannels(trigger?.config))
  })
  if (invalidChannels.size > 0) {
    errors.push(
      `Canales no soportados en el flujo (${[...invalidChannels].join(', ')}): usa WhatsApp, Messenger o Instagram Direct`
    )
  }

  // Máximo 10 ramas (salidas distintas conectadas) por nodo
  const handlesBySource = new Map()
  edges.forEach((edge) => {
    const set = handlesBySource.get(edge.sourceNodeId) || new Set()
    set.add(edge.sourceHandle || 'out')
    handlesBySource.set(edge.sourceNodeId, set)
  })
  for (const [, handles] of handlesBySource) {
    if (handles.size > 10) {
      errors.push('Máximo 10 ramas por paso')
      break
    }
  }

  // Horario global del flujo: si está activo necesita días y horas válidas
  const schedule = flow?.settings?.allowedSchedule
  if (isPlainObject(schedule) && schedule.enabled) {
    if (!Array.isArray(schedule.daysOfWeek) || schedule.daysOfWeek.length === 0) {
      errors.push('El horario del flujo necesita al menos un día permitido')
    }
    if (!schedule.startTime || !schedule.endTime) {
      errors.push('El horario del flujo necesita hora de inicio y fin')
    }
  }

  if (detectCycle(nodes, edges)) {
    errors.push('El flujo tiene un ciclo: una rama regresa a un paso anterior')
  }

  return errors
}
