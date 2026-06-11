import { getCatalog } from '@/services/automationCatalogsService'

/**
 * Catálogo de variables insertables en mensajes, prompts, webhooks y campos
 * dinámicos. En la interfaz se ven como chips con su etiqueta legible
 * ("Primer nombre"); internamente se guardan como tokens identificables
 * ("{{contact.first_name}}") dentro del texto compilado.
 */

export interface FlowVariable {
  /** Identificador del campo, p. ej. "contact.first_name" */
  fieldId: string
  /** Etiqueta legible que se muestra en el chip */
  label: string
  category: string
}

export interface FlowVariableCategory {
  id: string
  label: string
}

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
// Tokens dentro del texto compilado
// ---------------------------------------------------------------------------

export function tokenFor(variable: Pick<FlowVariable, 'fieldId'>): string {
  return `{{${variable.fieldId}}}`
}

const TOKEN_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}/g

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
