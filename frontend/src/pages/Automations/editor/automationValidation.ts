import type { AutomationEdge, AutomationNode } from '@/services/automationsService'
import { getNodeDefinition, validateNodeConfig } from './nodeRegistry'
import { getStartTriggers, getWaitMessageSourceOptions, hasPath, isStartNode, nodeHasInput } from './flowUtils'
import { conditionVariableTokenFromField, isConditionVariableField } from './crmFields'
import {
  BASE_VARIABLES,
  buildFlowVariableCatalog,
  extractTokens,
  isDynamicToken,
  type FlowVariableCatalogOptions
} from './variablesCatalog'

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

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') {
    output.push(value)
    return output
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output))
    return output
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, output))
  }
  return output
}

interface ConditionVariableReference {
  token: string
  label: string
}

function collectConditionVariableFields(value: unknown, output: ConditionVariableReference[] = []): ConditionVariableReference[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectConditionVariableFields(item, output))
    return output
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.field === 'string' && isConditionVariableField(record.field)) {
      output.push({
        token: conditionVariableTokenFromField(record.field),
        label: typeof record.fieldLabel === 'string' ? record.fieldLabel : conditionVariableTokenFromField(record.field)
      })
    }
    Object.values(record).forEach((item) => collectConditionVariableFields(item, output))
  }
  return output
}

function unavailableDynamicTokens(
  node: AutomationNode,
  nodes: AutomationNode[],
  edges: AutomationEdge[],
  options: FlowVariableCatalogOptions = {}
): string[] {
  const catalog = buildFlowVariableCatalog(nodes, edges, node.id, options)
  const available = new Set([
    ...BASE_VARIABLES.map((variable) => variable.fieldId),
    ...catalog.variables.map((variable) => variable.fieldId)
  ])
  const tokens = new Set(collectStrings(node.config || {}).flatMap(extractTokens))
  return [...tokens].filter((token) => isDynamicToken(token) && !available.has(token))
}

function unavailableConditionVariableFields(
  node: AutomationNode,
  nodes: AutomationNode[],
  edges: AutomationEdge[],
  options: FlowVariableCatalogOptions = {}
): ConditionVariableReference[] {
  const catalog = buildFlowVariableCatalog(nodes, edges, node.id, options)
  const available = new Set(catalog.variables.map((variable) => variable.fieldId))
  const seen = new Set<string>()
  return collectConditionVariableFields(node.config || []).filter((reference) => {
    if (seen.has(reference.token)) return false
    seen.add(reference.token)
    return !available.has(reference.token)
  })
}

function validateWaitReplyMessageSource(
  node: AutomationNode,
  nodes: AutomationNode[],
  edges: AutomationEdge[],
  result: FlowValidationResult
) {
  if (node.type !== 'logic-wait') return
  const config = node.config || {}
  const selectedSource =
    config.mode === 'reply'
      ? typeof config.replySourceNodeId === 'string' ? config.replySourceNodeId : ''
      : config.mode === 'action' && config.expectedAction === 'reply_message'
        ? typeof config.actionResource === 'string' ? config.actionResource : ''
        : ''
  if (!selectedSource) return
  const validSources = new Set(getWaitMessageSourceOptions(nodes, edges, node.id).map((source) => source.value))
  if (!validSources.has(selectedSource)) {
    pushNodeError(result, node.id, 'El mensaje enviado seleccionado ya no está antes de esta espera')
  }
}

/**
 * Validación completa del flujo antes de publicar.
 * Devuelve mensajes claros en español y los errores por nodo.
 */
export function validateAutomationFlow(
  nodes: AutomationNode[],
  edges: AutomationEdge[],
  options: FlowVariableCatalogOptions = {}
): FlowValidationResult {
  const result: FlowValidationResult = { valid: true, issues: [], nodeErrors: {} }

  const startNode = nodes.find(isStartNode)

  // 1. Inicio y disparadores
  if (!startNode) {
    result.issues.push({ message: 'El flujo no tiene tarjeta inicial "Cuando..."' })
  } else {
    if (!edges.some((edge) => edge.sourceNodeId === startNode.id)) {
      pushNodeError(result, startNode.id, 'Agrega al menos un paso conectado al inicio antes de publicar')
    }
    const triggers = getStartTriggers(startNode)
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
    unavailableDynamicTokens(node, nodes, edges, options).forEach((token) => {
      pushNodeError(result, node.id, `La variable {{${token}}} ya no está disponible`)
    })
    unavailableConditionVariableFields(node, nodes, edges, options).forEach((reference) => {
      pushNodeError(result, node.id, `El dato "${reference.label}" ya no está disponible para esta condición`)
    })
    validateWaitReplyMessageSource(node, nodes, edges, result)
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
