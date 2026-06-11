import type { AutomationEdge, AutomationNode } from '@/services/automationsService'
import { getNodeDefinition, validateNodeConfig } from './nodeRegistry'
import { getStartTriggers, hasPath, isStartNode, nodeHasInput } from './flowUtils'

export interface FlowValidationIssue {
  nodeId?: string
  message: string
}

export interface FlowValidationResult {
  valid: boolean
  issues: FlowValidationIssue[]
  /** Errores agrupados por nodo para resaltarlos en el canvas */
  nodeErrors: Record<string, string[]>
}

function pushNodeError(result: FlowValidationResult, nodeId: string, message: string) {
  result.issues.push({ nodeId, message })
  if (!result.nodeErrors[nodeId]) result.nodeErrors[nodeId] = []
  result.nodeErrors[nodeId].push(message)
}

/** Nombre legible de un nodo para los mensajes de error */
function nodeName(node: AutomationNode): string {
  return node.label || getNodeDefinition(node.type)?.label || 'Paso sin nombre'
}

/**
 * Validación completa del flujo antes de publicar.
 * Devuelve mensajes claros en español y los errores por nodo.
 */
export function validateAutomationFlow(
  nodes: AutomationNode[],
  edges: AutomationEdge[]
): FlowValidationResult {
  const result: FlowValidationResult = { valid: true, issues: [], nodeErrors: {} }

  const startNode = nodes.find(isStartNode)

  // 1. Disparadores
  if (!startNode) {
    result.issues.push({ message: 'El flujo no tiene tarjeta inicial "Cuando..."' })
  } else {
    const triggers = getStartTriggers(startNode)
    if (triggers.length === 0) {
      pushNodeError(result, startNode.id, 'Agrega al menos un disparador antes de publicar')
    }
    triggers.forEach((trigger) => {
      const definition = getNodeDefinition(trigger.type)
      if (!definition) {
        pushNodeError(result, startNode.id, 'Hay un disparador de un tipo desconocido')
        return
      }
      validateNodeConfig(definition, trigger.config || {}).forEach((error) => {
        pushNodeError(result, startNode.id, `${definition.label}: ${error}`)
      })
    })
  }

  // 2. Configuración de cada paso
  nodes.forEach((node) => {
    if (isStartNode(node)) return
    const definition = getNodeDefinition(node.type)
    if (!definition) {
      pushNodeError(result, node.id, `El paso "${nodeName(node)}" es de un tipo desconocido`)
      return
    }
    validateNodeConfig(definition, node.config || {}).forEach((error) => {
      pushNodeError(result, node.id, error)
    })
  })

  // 3. Conexiones válidas
  const nodeIds = new Set(nodes.map((node) => node.id))
  edges.forEach((edge) => {
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
      result.issues.push({ message: 'Hay conexiones que apuntan a pasos que ya no existen' })
    }
  })

  // 4. Pasos sueltos (sin conexión de entrada)
  const connectedTargets = new Set(edges.map((edge) => edge.targetNodeId))
  nodes.forEach((node) => {
    if (isStartNode(node) || !nodeHasInput(node)) return
    if (!connectedTargets.has(node.id)) {
      pushNodeError(result, node.id, `El paso "${nodeName(node)}" no está conectado al flujo`)
    }
  })

  // 5. Ciclos
  const hasCycle = nodes.some((node) =>
    edges
      .filter((edge) => edge.sourceNodeId === node.id)
      .some((edge) => hasPath(edges, edge.targetNodeId, node.id))
  )
  if (hasCycle) {
    result.issues.push({ message: 'El flujo tiene un ciclo: una rama regresa a un paso anterior' })
  }

  result.valid = result.issues.length === 0
  return result
}
