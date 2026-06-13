import React from 'react'
import { getCatalog } from '@/services/automationCatalogsService'
import type {
  AutomationEdge,
  AutomationNode,
  AutomationTriggerEntry
} from '@/services/automationsService'
import {
  getNodeDefinition,
  START_NODE_TYPE,
  type NodeVariableOutput,
  type VariableSchemaField,
  type VariableValueType
} from './nodeRegistry'
import { getStartTriggers, hasPath, isStartNode } from './flowUtils'

/**
 * Catálogo de variables insertables en mensajes, prompts, webhooks y campos
 * dinámicos. La UI muestra nombres legibles; el texto se guarda como tokens
 * estables, por ejemplo: "Hola {{webhook_1.cliente}}".
 */

export interface FlowVariable {
  /** Identificador del campo, p. ej. "contact.first_name" o "webhook_1.cliente" */
  fieldId: string
  /** Etiqueta legible que se muestra en el chip */
  label: string
  category: string
  /** Etiqueta visible de la categoría cuando viene de un bloque */
  categoryLabel?: string
  /** Ruta legible para mostrar subcategorías anidadas */
  pathLabels?: string[]
  /** Ruta interna sin el token root */
  path?: string
  type?: VariableValueType
  sourceId?: string
}

export interface FlowVariableCategory {
  id: string
  label: string
  unavailableReason?: string
}

export interface FlowVariableCatalog {
  categories: FlowVariableCategory[]
  variables: FlowVariable[]
}

export const FlowVariablesContext = React.createContext<FlowVariableCatalog>({
  categories: [],
  variables: []
})

export const VARIABLE_CATEGORIES: FlowVariableCategory[] = [
  { id: 'contact', label: 'Contacto' },
  { id: 'custom', label: 'Campos personalizados' },
  { id: 'conversation', label: 'Conversación' },
  { id: 'appointment', label: 'Citas' },
  { id: 'payment', label: 'Pagos' },
  { id: 'form', label: 'Formularios' },
  { id: 'automation', label: 'Automatización' }
]

export const BASE_VARIABLES: FlowVariable[] = [
  // Contacto (el email es dato CRM, no canal)
  { fieldId: 'contact.first_name', label: 'Primer nombre', category: 'contact' },
  { fieldId: 'contact.last_name', label: 'Apellido', category: 'contact' },
  { fieldId: 'contact.full_name', label: 'Nombre completo', category: 'contact' },
  { fieldId: 'contact.phone', label: 'Teléfono', category: 'contact' },
  { fieldId: 'contact.email', label: 'Email (dato de contacto)', category: 'contact' },
  { fieldId: 'contact.source', label: 'Fuente', category: 'contact' },
  { fieldId: 'contact.created_at', label: 'Fecha de creación', category: 'contact' },
  { fieldId: 'contact.updated_at', label: 'Fecha de actualización', category: 'contact' },
  { fieldId: 'contact.last_activity', label: 'Última actividad', category: 'contact' },
  { fieldId: 'contact.last_channel', label: 'Último canal', category: 'contact' },
  { fieldId: 'contact.assigned_user', label: 'Usuario asignado', category: 'contact' },
  { fieldId: 'contact.stage', label: 'Etapa', category: 'contact' },

  // Conversación
  { fieldId: 'conversation.last_received', label: 'Último mensaje recibido', category: 'conversation' },
  { fieldId: 'conversation.last_sent', label: 'Último mensaje enviado', category: 'conversation' },
  { fieldId: 'conversation.channel', label: 'Canal de conversación', category: 'conversation' },
  { fieldId: 'conversation.last_reply_at', label: 'Fecha de última respuesta', category: 'conversation' },
  { fieldId: 'conversation.ai_response', label: 'Respuesta guardada por IA', category: 'conversation' },

  // Citas
  { fieldId: 'appointment.date', label: 'Fecha de cita', category: 'appointment' },
  { fieldId: 'appointment.time', label: 'Hora de cita', category: 'appointment' },
  { fieldId: 'appointment.calendar', label: 'Calendario', category: 'appointment' },
  { fieldId: 'appointment.type', label: 'Tipo de cita', category: 'appointment' },
  { fieldId: 'appointment.status', label: 'Estado de cita', category: 'appointment' },

  // Pagos
  { fieldId: 'payment.product', label: 'Producto', category: 'payment' },
  { fieldId: 'payment.amount', label: 'Monto', category: 'payment' },
  { fieldId: 'payment.currency', label: 'Moneda', category: 'payment' },
  { fieldId: 'payment.status', label: 'Estado de pago', category: 'payment' },
  { fieldId: 'payment.date', label: 'Fecha de pago', category: 'payment' },
  { fieldId: 'payment.id', label: 'ID de pago', category: 'payment' },

  // Formularios
  { fieldId: 'form.name', label: 'Nombre del formulario', category: 'form' },
  { fieldId: 'form.submitted_at', label: 'Fecha de envío', category: 'form' },
  { fieldId: 'form.answers', label: 'Respuestas del formulario', category: 'form' },

  // Automatización
  { fieldId: 'flow.name', label: 'Nombre del flujo', category: 'automation' },
  { fieldId: 'flow.current_node', label: 'Nombre del nodo actual', category: 'automation' },
  { fieldId: 'flow.previous_result', label: 'Resultado del nodo anterior', category: 'automation' }
]

/** Variables + campos personalizados reales del CRM (vía adaptador) */
export async function loadAllVariables(): Promise<FlowVariable[]> {
  try {
    const customFields = await getCatalog('contactFields')
    const custom = customFields
      .filter((field) => field.value.startsWith('custom:'))
      .map((field) => ({
        fieldId: `contact.custom.${field.value.slice('custom:'.length)}`,
        label: field.label,
        category: 'custom'
      }))
    return [...BASE_VARIABLES, ...custom]
  } catch {
    return BASE_VARIABLES
  }
}

// ---------------------------------------------------------------------------
// Variables dinámicas por bloque
// ---------------------------------------------------------------------------

const BLOCK_OUTPUT_ROOTS = [
  'webhook',
  'respuesta_whatsapp',
  'formulario',
  'chatgpt',
  'http_request',
  'calculadora',
  'formateador_numero',
  'formateador_fecha',
  'formateador_texto',
  'contacto',
  'contacto_actualizado',
  'cita',
  'crear_cita',
  'pago',
  'enviar_whatsapp'
]

export function isDynamicToken(fieldId: string): boolean {
  return BLOCK_OUTPUT_ROOTS.some((root) => fieldId === root || fieldId.startsWith(`${root}_`) || fieldId.startsWith(`${root}.`))
}

function tokenSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || 'campo'
}

function labelFromKey(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\p{L}/u, (match) => match.toLocaleUpperCase('es-MX'))
}

function typeFromValue(value: unknown): VariableValueType {
  if (Array.isArray(value)) return 'array'
  if (value === null || value === undefined) return 'unknown'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'object') return 'object'
  return 'unknown'
}

function fieldsFromSample(value: unknown): VariableSchemaField[] {
  if (!value || typeof value !== 'object') return []
  const source =
    Array.isArray(value) && value.length > 0 && typeof value[0] === 'object'
      ? (value[0] as Record<string, unknown>)
      : Array.isArray(value)
        ? {}
        : (value as Record<string, unknown>)

  return Object.entries(source).map(([key, child]) => {
    const type = typeFromValue(child)
    const children =
      child && typeof child === 'object'
        ? fieldsFromSample(Array.isArray(child) ? child[0] : child)
        : undefined
    return {
      label: labelFromKey(key),
      path: tokenSegment(key),
      type,
      ...(children && children.length > 0 ? { children } : {})
    }
  })
}

function flattenFields(
  fields: VariableSchemaField[],
  root: string,
  category: FlowVariableCategory,
  sourceId: string,
  parentPath: string[] = [],
  parentLabels: string[] = []
): FlowVariable[] {
  return fields.flatMap((candidate) => {
    const segment = tokenSegment(candidate.path || candidate.label)
    const nextPath = [...parentPath, segment]
    const nextLabels = [...parentLabels, candidate.label]
    const hasChildren = Boolean(candidate.children && candidate.children.length > 0)

    if (hasChildren) {
      return flattenFields(candidate.children || [], root, category, sourceId, nextPath, nextLabels)
    }

    const path = nextPath.join('.')
    return [{
      fieldId: `${root}.${path}`,
      label: candidate.label,
      category: category.id,
      categoryLabel: category.label,
      path,
      pathLabels: nextLabels,
      type: candidate.type || 'unknown',
      sourceId
    }]
  })
}

function nodeDisplayName(baseLabel: string, config: Record<string, unknown>, occurrence: number): string {
  const customTitle = typeof config.customTitle === 'string' ? config.customTitle.trim() : ''
  if (customTitle) {
    const base = baseLabel.split(' - ')[0]
    return `${base} - ${customTitle}`
  }
  if (baseLabel.includes(' - ')) return baseLabel
  return `${baseLabel} #${occurrence}`
}

function outputToVariables(
  output: NodeVariableOutput,
  config: Record<string, unknown>,
  sourceId: string,
  occurrence: number
): FlowVariableCatalog {
  const root = output.fixedTokenRoot && occurrence === 1
    ? output.fixedTokenRoot
    : output.fixedTokenRoot && occurrence > 1
      ? `${output.fixedTokenRoot}_${occurrence}`
      : `${output.baseId}_${occurrence}`

  const category: FlowVariableCategory = {
    id: root,
    label: nodeDisplayName(output.baseLabel, config, occurrence),
    unavailableReason: output.unavailableReason
  }

  if (output.unavailableReason || (output.requiresSample && !output.sampleResponse)) {
    return { categories: [category], variables: [] }
  }

  const fields = output.fields && output.fields.length > 0
    ? output.fields
    : fieldsFromSample(output.sampleResponse)

  return {
    categories: [category],
    variables: flattenFields(fields, root, category, sourceId)
  }
}

function startTriggersForTarget(nodes: AutomationNode[], edges: AutomationEdge[], targetNodeId: string | null): AutomationTriggerEntry[] {
  const startNode = nodes.find(isStartNode)
  if (!startNode) return []
  if (!targetNodeId) return []
  if (targetNodeId === startNode.id) return []
  const connected = hasPath(edges, startNode.id, targetNodeId)
  return connected ? getStartTriggers(startNode) : []
}

function previousNodesForTarget(nodes: AutomationNode[], edges: AutomationEdge[], targetNodeId: string | null): AutomationNode[] {
  if (!targetNodeId) return []
  return nodes.filter((node) => {
    if (node.id === targetNodeId || isStartNode(node)) return false
    return hasPath(edges, node.id, targetNodeId)
  })
}

export function buildFlowVariableCatalog(
  nodes: AutomationNode[],
  edges: AutomationEdge[],
  targetNodeId: string | null
): FlowVariableCatalog {
  const categories: FlowVariableCategory[] = []
  const variables: FlowVariable[] = []
  const occurrences = new Map<string, number>()

  const appendOutput = (
    output: NodeVariableOutput | null | undefined,
    config: Record<string, unknown>,
    sourceId: string
  ) => {
    if (!output) return
    const nextOccurrence = (occurrences.get(output.baseId) || 0) + 1
    occurrences.set(output.baseId, nextOccurrence)
    const catalog = outputToVariables(output, config, sourceId, nextOccurrence)
    categories.push(...catalog.categories)
    variables.push(...catalog.variables)
  }

  startTriggersForTarget(nodes, edges, targetNodeId).forEach((trigger) => {
    const definition = getNodeDefinition(trigger.type)
    appendOutput(definition?.variableOutput?.(trigger.config || {}), trigger.config || {}, trigger.id)
  })

  previousNodesForTarget(nodes, edges, targetNodeId).forEach((node) => {
    const definition = getNodeDefinition(node.type)
    appendOutput(definition?.variableOutput?.(node.config || {}), node.config || {}, node.id)
  })

  return { categories, variables }
}

// ---------------------------------------------------------------------------
// Tokens dentro del texto compilado
// ---------------------------------------------------------------------------

export function tokenFor(variable: Pick<FlowVariable, 'fieldId'>): string {
  return `{{${variable.fieldId}}}`
}

export const TOKEN_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g

export function extractTokens(compiled: string): string[] {
  return [...(compiled || '').matchAll(TOKEN_PATTERN)].map((match) => match[1])
}

export type TextPart =
  | { type: 'text'; value: string }
  | { type: 'variable'; fieldId: string; label: string; token: string }

/** Convierte el texto compilado ("Hola {{contact.first_name}}") en partes */
export function parseCompiledText(compiled: string, variables: FlowVariable[]): TextPart[] {
  const parts: TextPart[] = []
  let lastIndex = 0
  const text = compiled || ''
  const byId = new Map(variables.map((variable) => [variable.fieldId, variable]))

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, index) })
    }
    const fieldId = match[1]
    const known = byId.get(fieldId)
    parts.push({
      type: 'variable',
      fieldId,
      label: known?.label || fieldId,
      token: `{{${fieldId}}}`
    })
    lastIndex = index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) })
  }

  return parts
}

/** Une partes de texto/variables en el texto compilado con tokens */
export function compileParts(parts: TextPart[]): string {
  return parts
    .map((part) => (part.type === 'text' ? part.value : part.token))
    .join('')
}
