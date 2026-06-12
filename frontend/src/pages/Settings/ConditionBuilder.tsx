import React, { useEffect, useRef, useState } from 'react'
import { Check, Copy, Pencil, Plus, X } from 'lucide-react'
import type {
  AgentCondition,
  AgentConditionParam,
  AgentFilterOptions,
  ConditionCategory,
  ConditionGroup,
  ConditionOffsetUnit
} from '@/services/conversationalAgentService'
import type { Calendar } from '@/services/calendarsService'
import { TagPicker, useContactTags } from '@/components/common'
import { contactTagsService } from '@/services/contactTagsService'
import styles from './AIAgentSettings.module.css'

/**
 * Constructor de condiciones jerárquico (estilo disparadores de workflow):
 *
 * - La CATEGORÍA sola ya dispara con su significado base ("agendó una cita",
 *   "vino de un anuncio", "recibió un mensaje").
 * - Cada PARÁMETRO agregado la afina de forma opcional y apilable:
 *   Citas → en calendario X → y confirmada → y 30 min antes.
 * - Los bloques se unen con O; dentro de un bloque todo es Y.
 *
 * Para agregar categorías o parámetros futuros basta con extender el catálogo
 * (el backend valida contra su propio CONDITION_SCHEMA espejo).
 */

type ValueKind =
  | 'none' | 'channel' | 'text' | 'list' | 'tag' | 'tagList' | 'calendar'
  | 'date' | 'dateRange' | 'offset' | 'amount' | 'amountRange'
  | 'ad' | 'businessPhone' | 'timeRange' | 'weekdays' | 'customField' | 'customFieldValue'

interface OperatorDef {
  id: string
  label: string
  valueKind: ValueKind
  placeholder?: string
  /** arma la frase del resumen; si falta se usa label + valor */
  phrase?: (param: AgentConditionParam, helpers: SummaryHelpers) => string
}

interface ParamDef {
  field: string
  /** etiqueta en el menú "+ Añadir parámetro" */
  menuLabel: string
  operators: OperatorDef[]
}

interface CategoryDef {
  id: ConditionCategory
  label: string
  /** frase base cuando no hay parámetros */
  baseLabel: string
  params: ParamDef[]
  /** parámetros con los que nace la condición (ej. Canal necesita uno) */
  defaultParams?: AgentConditionParam[]
}

interface SummaryHelpers {
  calendarName: (id?: string) => string
  adName: (id?: string) => string
  phoneLabel: (id?: string) => string
  tagName: (id?: string) => string
  customFieldLabel: (key?: string) => string
}

const CHANNEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'messenger', label: 'Facebook Messenger' },
  { value: 'webchat', label: 'Web Chat' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Correo' }
]

const OFFSET_UNIT_OPTIONS: Array<{ value: ConditionOffsetUnit; label: string }> = [
  { value: 'minutes', label: 'minutos' },
  { value: 'hours', label: 'horas' },
  { value: 'days', label: 'días' }
]

const WEEKDAY_OPTIONS: Array<{ value: string; label: string; short: string }> = [
  { value: 'mon', label: 'lunes', short: 'L' },
  { value: 'tue', label: 'martes', short: 'M' },
  { value: 'wed', label: 'miércoles', short: 'X' },
  { value: 'thu', label: 'jueves', short: 'J' },
  { value: 'fri', label: 'viernes', short: 'V' },
  { value: 'sat', label: 'sábado', short: 'S' },
  { value: 'sun', label: 'domingo', short: 'D' }
]

function offsetPhrase(param: AgentConditionParam, suffix: string) {
  const unit = OFFSET_UNIT_OPTIONS.find((option) => option.value === param.offsetUnit)?.label || 'minutos'
  return `${param.offsetValue || 0} ${unit} ${suffix}`
}

export const CONDITION_CATEGORIES: CategoryDef[] = [
  {
    id: 'channel',
    label: 'Canal',
    baseLabel: 'llegó por cualquier canal',
    defaultParams: [{ field: 'channel', operator: 'is', value: 'whatsapp' }],
    params: [
      {
        field: 'channel',
        menuLabel: 'Canal',
        operators: [
          { id: 'is', label: 'es', valueKind: 'channel', phrase: (p) => `es ${channelLabel(p.value)}` },
          { id: 'is_not', label: 'no es', valueKind: 'channel', phrase: (p) => `no es ${channelLabel(p.value)}` }
        ]
      }
    ]
  },
  {
    id: 'message',
    label: 'Mensaje',
    baseLabel: 'recibió un mensaje',
    params: [
      {
        field: 'text',
        menuLabel: 'Texto del mensaje',
        operators: [
          { id: 'contains', label: 'contiene', valueKind: 'text', placeholder: 'Texto a buscar', phrase: (p) => `contiene "${p.value || '…'}"` },
          { id: 'not_contains', label: 'no contiene', valueKind: 'text', placeholder: 'Texto a evitar', phrase: (p) => `no contiene "${p.value || '…'}"` },
          { id: 'contains_any', label: 'contiene alguna de estas frases', valueKind: 'list', placeholder: 'Frase y Enter', phrase: (p) => `contiene alguna de: ${(p.values || []).join(', ') || '…'}` },
          { id: 'contains_all', label: 'contiene todas estas frases', valueKind: 'list', placeholder: 'Frase y Enter', phrase: (p) => `contiene todas: ${(p.values || []).join(', ') || '…'}` },
          { id: 'starts_with', label: 'empieza con', valueKind: 'text', placeholder: 'Inicio del mensaje', phrase: (p) => `empieza con "${p.value || '…'}"` },
          { id: 'ends_with', label: 'termina con', valueKind: 'text', placeholder: 'Final del mensaje', phrase: (p) => `termina con "${p.value || '…'}"` },
          { id: 'equals', label: 'coincide exactamente con', valueKind: 'text', placeholder: 'Mensaje exacto', phrase: (p) => `es exactamente "${p.value || '…'}"` }
        ]
      },
      {
        field: 'business_phone',
        menuLabel: 'Número del negocio que lo recibió',
        operators: [
          { id: 'is', label: 'llegó al número', valueKind: 'businessPhone', phrase: (p, h) => `al número ${h.phoneLabel(p.value)}` },
          { id: 'is_not', label: 'no llegó al número', valueKind: 'businessPhone', phrase: (p, h) => `no al número ${h.phoneLabel(p.value)}` }
        ]
      }
    ]
  },
  {
    id: 'tags',
    label: 'Etiquetas',
    baseLabel: 'tiene alguna etiqueta',
    params: [
      {
        field: 'tag',
        menuLabel: 'Etiqueta',
        operators: [
          { id: 'has', label: 'tiene la etiqueta', valueKind: 'tag', phrase: (p, h) => `tiene "${h.tagName(p.value)}"` },
          { id: 'not_has', label: 'no tiene la etiqueta', valueKind: 'tag', phrase: (p, h) => `no tiene "${h.tagName(p.value)}"` },
          { id: 'has_any', label: 'tiene cualquiera de', valueKind: 'tagList', phrase: (p, h) => `tiene cualquiera de: ${(p.values || []).map(h.tagName).join(', ') || '…'}` },
          { id: 'has_all', label: 'tiene todas', valueKind: 'tagList', phrase: (p, h) => `tiene todas: ${(p.values || []).map(h.tagName).join(', ') || '…'}` },
          { id: 'has_none', label: 'no tiene ninguna de', valueKind: 'tagList', phrase: (p, h) => `no tiene ninguna de: ${(p.values || []).map(h.tagName).join(', ') || '…'}` }
        ]
      }
    ]
  },
  {
    id: 'contact',
    label: 'Contacto',
    baseLabel: 'cualquier contacto',
    params: [
      {
        field: 'name',
        menuLabel: 'Nombre',
        operators: [
          { id: 'contains', label: 'contiene', valueKind: 'text', placeholder: 'Parte del nombre', phrase: (p) => `el nombre contiene "${p.value || '…'}"` },
          { id: 'is', label: 'es', valueKind: 'text', placeholder: 'Nombre exacto', phrase: (p) => `el nombre es "${p.value || '…'}"` }
        ]
      },
      {
        field: 'email',
        menuLabel: 'Correo',
        operators: [
          { id: 'has', label: 'tiene correo registrado', valueKind: 'none', phrase: () => 'tiene correo' },
          { id: 'no_has', label: 'no tiene correo', valueKind: 'none', phrase: () => 'no tiene correo' },
          { id: 'is', label: 'el correo es', valueKind: 'text', placeholder: 'correo@ejemplo.com', phrase: (p) => `el correo es ${p.value || '…'}` },
          { id: 'contains', label: 'el correo contiene', valueKind: 'text', placeholder: 'ej. @gmail.com', phrase: (p) => `el correo contiene "${p.value || '…'}"` }
        ]
      },
      {
        field: 'phone',
        menuLabel: 'Teléfono',
        operators: [
          { id: 'contains', label: 'contiene', valueKind: 'text', placeholder: 'ej. 33 o +52', phrase: (p) => `el teléfono contiene "${p.value || '…'}"` }
        ]
      },
      {
        field: 'custom_field',
        menuLabel: 'Campo personalizado',
        operators: [
          { id: 'is', label: 'es', valueKind: 'customFieldValue', phrase: (p, h) => `${h.customFieldLabel(p.fieldKey)} es "${p.value || '…'}"` },
          { id: 'contains', label: 'contiene', valueKind: 'customFieldValue', phrase: (p, h) => `${h.customFieldLabel(p.fieldKey)} contiene "${p.value || '…'}"` },
          { id: 'has_value', label: 'tiene valor (se llenó)', valueKind: 'customField', phrase: (p, h) => `${h.customFieldLabel(p.fieldKey)} tiene valor` },
          { id: 'empty', label: 'está vacío', valueKind: 'customField', phrase: (p, h) => `${h.customFieldLabel(p.fieldKey)} está vacío` }
        ]
      },
      {
        field: 'source',
        menuLabel: 'Origen del contacto',
        operators: [
          { id: 'is', label: 'es', valueKind: 'text', placeholder: 'ej. meta_ads, google', phrase: (p) => `el origen es "${p.value || '…'}"` },
          { id: 'contains', label: 'contiene', valueKind: 'text', placeholder: 'Parte del origen', phrase: (p) => `el origen contiene "${p.value || '…'}"` }
        ]
      },
      {
        field: 'customer',
        menuLabel: 'Es cliente',
        operators: [
          { id: 'is_customer', label: 'es cliente (tiene compras)', valueKind: 'none', phrase: () => 'es cliente' },
          { id: 'not_customer', label: 'no es cliente todavía', valueKind: 'none', phrase: () => 'no es cliente' }
        ]
      },
      {
        field: 'created',
        menuLabel: 'Antigüedad',
        operators: [
          { id: 'within', label: 'se creó hace menos de', valueKind: 'offset', phrase: (p) => `creado hace menos de ${offsetPhrase(p, '')}`.trim() }
        ]
      },
      {
        field: 'assigned',
        menuLabel: 'Asignación',
        operators: [
          { id: 'to', label: 'está asignado a', valueKind: 'text', placeholder: 'Nombre del usuario', phrase: (p) => `asignado a ${p.value || '…'}` },
          { id: 'not_to', label: 'no está asignado a', valueKind: 'text', placeholder: 'Nombre del usuario', phrase: (p) => `no asignado a ${p.value || '…'}` },
          { id: 'any', label: 'tiene cualquier asignado', valueKind: 'none', phrase: () => 'tiene asignado' },
          { id: 'none', label: 'no tiene asignado', valueKind: 'none', phrase: () => 'sin asignar' }
        ]
      }
    ]
  },
  {
    id: 'appointments',
    label: 'Calendarios y citas',
    baseLabel: 'agendó una cita',
    params: [
      {
        field: 'presence',
        menuLabel: 'Tiene / no tiene cita',
        operators: [
          { id: 'has', label: 'tiene cita', valueKind: 'none', phrase: () => 'tiene cita' },
          { id: 'none', label: 'no tiene cita', valueKind: 'none', phrase: () => 'NO tiene cita (con estos filtros)' }
        ]
      },
      {
        field: 'calendar',
        menuLabel: 'Calendario específico',
        operators: [
          { id: 'is', label: 'está agendado en', valueKind: 'calendar', phrase: (p, h) => `en ${h.calendarName(p.value)}` },
          { id: 'is_not', label: 'no está agendado en', valueKind: 'calendar', phrase: (p, h) => `no en ${h.calendarName(p.value)}` }
        ]
      },
      {
        field: 'status',
        menuLabel: 'Estado de la cita',
        operators: [
          { id: 'confirmed', label: 'confirmada', valueKind: 'none', phrase: () => 'confirmada' },
          { id: 'pending', label: 'pendiente de confirmar', valueKind: 'none', phrase: () => 'pendiente' },
          { id: 'cancelled', label: 'cancelada', valueKind: 'none', phrase: () => 'cancelada' },
          { id: 'showed', label: 'asistió', valueKind: 'none', phrase: () => 'asistió' },
          { id: 'noshow', label: 'no asistió', valueKind: 'none', phrase: () => 'no asistió' }
        ]
      },
      {
        field: 'timing',
        menuLabel: 'Cuándo es la cita',
        operators: [
          { id: 'upcoming', label: 'es próxima (futura)', valueKind: 'none', phrase: () => 'próxima' },
          { id: 'past_due', label: 'ya venció (pasada)', valueKind: 'none', phrase: () => 'vencida' },
          { id: 'today', label: 'es hoy', valueKind: 'none', phrase: () => 'es hoy' }
        ]
      },
      {
        field: 'date',
        menuLabel: 'Fecha de la cita',
        operators: [
          { id: 'is', label: 'es exactamente el', valueKind: 'date', phrase: (p) => `el ${p.date || '…'}` },
          { id: 'not', label: 'no es el', valueKind: 'date', phrase: (p) => `no el ${p.date || '…'}` },
          { id: 'before', label: 'antes del', valueKind: 'date', phrase: (p) => `antes del ${p.date || '…'}` },
          { id: 'after', label: 'después del', valueKind: 'date', phrase: (p) => `después del ${p.date || '…'}` },
          { id: 'between', label: 'entre', valueKind: 'dateRange', phrase: (p) => `entre ${p.date || '…'} y ${p.dateEnd || '…'}` }
        ]
      },
      {
        field: 'window',
        menuLabel: 'Tiempo relativo a la cita',
        operators: [
          { id: 'before', label: 'antes de la cita', valueKind: 'offset', phrase: (p) => offsetPhrase(p, 'antes de la cita') },
          { id: 'after', label: 'después de la cita', valueKind: 'offset', phrase: (p) => offsetPhrase(p, 'después de la cita') }
        ]
      }
    ]
  },
  {
    id: 'payments',
    label: 'Pagos',
    baseLabel: 'tiene un pago',
    params: [
      {
        field: 'presence',
        menuLabel: 'Tiene / no tiene pago',
        operators: [
          { id: 'has', label: 'tiene pago', valueKind: 'none', phrase: () => 'tiene pago' },
          { id: 'none', label: 'no tiene pagos', valueKind: 'none', phrase: () => 'NO tiene pagos (con estos filtros)' }
        ]
      },
      {
        field: 'status',
        menuLabel: 'Estado del pago',
        operators: [
          { id: 'received', label: 'recibido', valueKind: 'none', phrase: () => 'recibido' },
          { id: 'pending', label: 'pendiente', valueKind: 'none', phrase: () => 'pendiente' },
          { id: 'failed', label: 'fallido', valueKind: 'none', phrase: () => 'fallido' },
          { id: 'refunded', label: 'reembolsado', valueKind: 'none', phrase: () => 'reembolsado' }
        ]
      },
      {
        field: 'product',
        menuLabel: 'Producto',
        operators: [
          { id: 'is', label: 'es', valueKind: 'text', placeholder: 'Nombre del producto', phrase: (p) => `producto "${p.value || '…'}"` },
          { id: 'is_not', label: 'no es', valueKind: 'text', placeholder: 'Nombre del producto', phrase: (p) => `producto distinto de "${p.value || '…'}"` },
          { id: 'contains', label: 'contiene', valueKind: 'text', placeholder: 'Parte del nombre', phrase: (p) => `producto contiene "${p.value || '…'}"` },
          { id: 'not_contains', label: 'no contiene', valueKind: 'text', placeholder: 'Parte del nombre', phrase: (p) => `producto no contiene "${p.value || '…'}"` }
        ]
      },
      {
        field: 'amount',
        menuLabel: 'Monto',
        operators: [
          { id: 'eq', label: 'igual a', valueKind: 'amount', phrase: (p) => `monto igual a ${money(p.amount)}` },
          { id: 'gt', label: 'mayor que', valueKind: 'amount', phrase: (p) => `monto mayor que ${money(p.amount)}` },
          { id: 'lt', label: 'menor que', valueKind: 'amount', phrase: (p) => `monto menor que ${money(p.amount)}` },
          { id: 'between', label: 'entre', valueKind: 'amountRange', phrase: (p) => `monto entre ${money(p.amount)} y ${money(p.amountMax)}` }
        ]
      }
    ]
  },
  {
    id: 'ads',
    label: 'Anuncios',
    baseLabel: 'vino de un anuncio (clic de WhatsApp)',
    params: [
      {
        field: 'presence',
        menuLabel: 'Vino / no vino de anuncio',
        operators: [
          { id: 'from_ad', label: 'vino de anuncio', valueKind: 'none', phrase: () => 'vino de anuncio' },
          { id: 'not_from_ad', label: 'no vino de anuncio', valueKind: 'none', phrase: () => 'NO vino de anuncio' }
        ]
      },
      {
        field: 'ad',
        menuLabel: 'Anuncio específico',
        operators: [
          { id: 'is', label: 'el anuncio es', valueKind: 'ad', phrase: (p, h) => `el anuncio es "${h.adName(p.value)}"` },
          { id: 'is_not', label: 'el anuncio no es', valueKind: 'ad', phrase: (p, h) => `el anuncio no es "${h.adName(p.value)}"` }
        ]
      }
    ]
  },
  {
    id: 'schedule',
    label: 'Fecha y hora',
    baseLabel: 'en cualquier momento',
    defaultParams: [{ field: 'time', operator: 'between', timeStart: '09:00', timeEnd: '18:00' }],
    params: [
      {
        field: 'time',
        menuLabel: 'Hora del día',
        operators: [
          { id: 'between', label: 'la hora está entre', valueKind: 'timeRange', phrase: (p) => `entre ${p.timeStart || '…'} y ${p.timeEnd || '…'}` },
          { id: 'outside', label: 'la hora está fuera de', valueKind: 'timeRange', phrase: (p) => `fuera de ${p.timeStart || '…'} a ${p.timeEnd || '…'}` }
        ]
      },
      {
        field: 'day',
        menuLabel: 'Día de la semana',
        operators: [
          { id: 'is', label: 'el día es', valueKind: 'weekdays', phrase: (p) => `los días ${(p.values || []).map((d) => WEEKDAY_OPTIONS.find((w) => w.value === d)?.label || d).join(', ') || '…'}` }
        ]
      }
    ]
  }
]

function channelLabel(value?: string) {
  return CHANNEL_OPTIONS.find((option) => option.value === value)?.label || value || '…'
}

function money(value?: number) {
  return `$${Number(value || 0).toLocaleString('es-MX')}`
}

function getCategory(categoryId: string): CategoryDef {
  return CONDITION_CATEGORIES.find((category) => category.id === categoryId) || CONDITION_CATEGORIES[0]
}

function getParamDef(categoryId: string, field: string): ParamDef {
  const category = getCategory(categoryId)
  return category.params.find((param) => param.field === field) || category.params[0]
}

function getOperatorDef(categoryId: string, field: string, operatorId: string): OperatorDef {
  const paramDef = getParamDef(categoryId, field)
  return paramDef.operators.find((operator) => operator.id === operatorId) || paramDef.operators[0]
}

function defaultParamFor(categoryId: ConditionCategory, field: string): AgentConditionParam {
  const operator = getParamDef(categoryId, field).operators[0]
  const param: AgentConditionParam = { field, operator: operator.id }
  if (operator.valueKind === 'channel') param.value = 'whatsapp'
  if (operator.valueKind === 'list' || operator.valueKind === 'tagList' || operator.valueKind === 'weekdays') param.values = []
  if (operator.valueKind === 'offset') {
    param.offsetValue = field === 'created' ? 7 : 30
    param.offsetUnit = field === 'created' ? 'days' : 'minutes'
  }
  if (operator.valueKind === 'timeRange') {
    param.timeStart = '09:00'
    param.timeEnd = '18:00'
  }
  return param
}

function defaultCondition(categoryId: ConditionCategory): AgentCondition {
  const category = getCategory(categoryId)
  return {
    category: categoryId,
    params: (category.defaultParams || []).map((param) => ({ ...param }))
  }
}

/** Frase legible de una condición: base + parámetros unidos con " · ". */
export function conditionSummary(condition: AgentCondition, calendars: Calendar[], options?: AgentFilterOptions): string {
  const category = getCategory(condition.category)
  const helpers: SummaryHelpers = {
    calendarName: (id) => calendars.find((item) => item.id === id)?.name || '…',
    adName: (id) => options?.ads.find((item) => item.id === id)?.name || id || '…',
    phoneLabel: (id) => options?.businessPhones.find((item) => item.id === id)?.label || id || '…',
    tagName: (id) => {
      const tag = (contactTagsService.getCachedTags() || []).find((item) => item.id === id)
      return tag?.name || id || '…'
    },
    customFieldLabel: (key) => options?.customFields?.find((item) => item.key === key)?.label || key || 'el campo'
  }

  const params = condition.params || []

  // El parámetro presence reemplaza la frase base
  const presence = params.find((param) => param.field === 'presence')
  let base = category.baseLabel
  if (presence) {
    base = getOperatorDef(condition.category, 'presence', presence.operator).phrase?.(presence, helpers) || base
  }

  const phrases = params
    .filter((param) => param.field !== 'presence')
    .map((param) => {
      const operator = getOperatorDef(condition.category, param.field, param.operator)
      return operator.phrase ? operator.phrase(param, helpers) : operator.label
    })

  return [`${category.label}: ${base}`, ...phrases].join(' · ')
}

/** Editor compacto de listas de frases dentro del parámetro en edición. */
const ListEditor: React.FC<{
  values: string[]
  placeholder: string
  onChange: (values: string[]) => void
}> = ({ values, placeholder, onChange }) => {
  const [draft, setDraft] = useState('')

  const commit = () => {
    const value = draft.trim()
    if (!value) return
    if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) {
      onChange([...values, value])
    }
    setDraft('')
  }

  return (
    <span className={styles.conditionListEditor}>
      {values.map((value) => (
        <span key={value} className={styles.conditionListChip}>
          {value}
          <button type="button" onClick={() => onChange(values.filter((item) => item !== value))} aria-label={`Quitar ${value}`}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        className={styles.ruleInput}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Backspace' && !draft && values.length) {
            onChange(values.slice(0, -1))
          }
        }}
        onBlur={commit}
      />
    </span>
  )
}

const DropdownMenu: React.FC<{
  label: string
  items: Array<{ id: string; label: string }>
  small?: boolean
  onSelect: (id: string) => void
}> = ({ label, items, small, onSelect }) => {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div className={styles.ruleAddWrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.ruleAddButton} ${small ? styles.ruleAddButtonSmall : ''}`}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus size={small ? 12 : 14} />
        {label}
      </button>
      {open && (
        <div className={styles.ruleAddMenu} role="menu">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={styles.ruleAddMenuItem}
              onClick={() => {
                onSelect(item.id)
                setOpen(false)
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface ConditionBuilderProps {
  groups: ConditionGroup[]
  mode: 'entry' | 'exit'
  calendars: Calendar[]
  options?: AgentFilterOptions
  emptyText: string
  onChange: (groups: ConditionGroup[]) => void
}

export const ConditionBuilder: React.FC<ConditionBuilderProps> = ({ groups, calendars, options, emptyText, onChange }) => {
  // Carga el catálogo de etiquetas para mostrar nombres y no IDs
  useContactTags()
  // Filas en edición, identificadas por "grupo:índice"
  const [editingKeys, setEditingKeys] = useState<Set<string>>(new Set())

  const setEditing = (key: string, editing: boolean) => {
    setEditingKeys((current) => {
      const next = new Set(current)
      if (editing) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const updateCondition = (groupIndex: number, conditionIndex: number, next: AgentCondition) => {
    onChange(groups.map((group, gi) => (
      gi !== groupIndex ? group : {
        conditions: group.conditions.map((condition, ci) => (ci !== conditionIndex ? condition : next))
      }
    )))
  }

  const updateParam = (groupIndex: number, conditionIndex: number, paramIndex: number, patch: Partial<AgentConditionParam>) => {
    const condition = groups[groupIndex].conditions[conditionIndex]
    updateCondition(groupIndex, conditionIndex, {
      ...condition,
      params: condition.params.map((param, pi) => (pi !== paramIndex ? param : { ...param, ...patch }))
    })
  }

  const replaceParam = (groupIndex: number, conditionIndex: number, paramIndex: number, next: AgentConditionParam) => {
    const condition = groups[groupIndex].conditions[conditionIndex]
    updateCondition(groupIndex, conditionIndex, {
      ...condition,
      params: condition.params.map((param, pi) => (pi !== paramIndex ? param : next))
    })
  }

  const removeCondition = (groupIndex: number, conditionIndex: number) => {
    const next = groups
      .map((group, gi) => (
        gi !== groupIndex ? group : { conditions: group.conditions.filter((_, ci) => ci !== conditionIndex) }
      ))
      .filter((group) => group.conditions.length > 0)
    setEditingKeys(new Set())
    onChange(next)
  }

  const duplicateCondition = (groupIndex: number, conditionIndex: number) => {
    const source = groups[groupIndex].conditions[conditionIndex]
    const clone: AgentCondition = {
      category: source.category,
      params: source.params.map((param) => ({ ...param, values: param.values ? [...param.values] : undefined }))
    }
    onChange(groups.map((group, gi) => (
      gi !== groupIndex ? group : {
        conditions: [
          ...group.conditions.slice(0, conditionIndex + 1),
          clone,
          ...group.conditions.slice(conditionIndex + 1)
        ]
      }
    )))
  }

  const addCondition = (groupIndex: number, category: ConditionCategory) => {
    const condition = defaultCondition(category)
    const next = groups.map((group, gi) => (
      gi !== groupIndex ? group : { conditions: [...group.conditions, condition] }
    ))
    onChange(next)
    setEditing(`${groupIndex}:${next[groupIndex].conditions.length - 1}`, true)
  }

  const addGroup = (category: ConditionCategory) => {
    onChange([...groups, { conditions: [defaultCondition(category)] }])
    setEditing(`${groups.length}:0`, true)
  }

  const renderParamValue = (condition: AgentCondition, param: AgentConditionParam, groupIndex: number, conditionIndex: number, paramIndex: number) => {
    const operator = getOperatorDef(condition.category, param.field, param.operator)
    switch (operator.valueKind) {
      case 'channel':
        return (
          <select
            className={styles.ruleSelect}
            value={param.value || 'whatsapp'}
            onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { value: event.target.value })}
          >
            {CHANNEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        )
      case 'text':
        return (
          <input
            className={styles.ruleInput}
            value={param.value || ''}
            placeholder={operator.placeholder || 'Valor'}
            onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { value: event.target.value })}
          />
        )
      case 'list':
        return (
          <ListEditor
            values={param.values || []}
            placeholder={operator.placeholder || 'Valor y Enter'}
            onChange={(values) => updateParam(groupIndex, conditionIndex, paramIndex, { values })}
          />
        )
      case 'tag':
        return (
          <div className={styles.conditionTagPicker}>
            <TagPicker
              value={param.value || ''}
              onValueChange={(tagId) => updateParam(groupIndex, conditionIndex, paramIndex, { value: tagId })}
              includeSystem
              allowCreate
              portal
              placeholder="Elige una etiqueta"
              aria-label="Etiqueta de la condición"
            />
          </div>
        )
      case 'tagList':
        return (
          <div className={styles.conditionTagPicker}>
            <TagPicker
              multiple
              selectedIds={param.values || []}
              onChange={(values) => updateParam(groupIndex, conditionIndex, paramIndex, { values })}
              includeSystem
              allowCreate
              portal
              aria-label="Etiquetas de la condición"
            />
          </div>
        )
      case 'calendar':
        return (
          <select
            className={styles.ruleSelect}
            value={param.value || ''}
            onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { value: event.target.value })}
          >
            <option value="">Elige un calendario</option>
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
            ))}
          </select>
        )
      case 'date':
        return (
          <input
            type="date"
            className={styles.ruleInput}
            value={param.date || ''}
            onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { date: event.target.value })}
          />
        )
      case 'dateRange':
        return (
          <>
            <input
              type="date"
              className={styles.ruleInput}
              value={param.date || ''}
              onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { date: event.target.value })}
            />
            <span>y</span>
            <input
              type="date"
              className={styles.ruleInput}
              value={param.dateEnd || ''}
              onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { dateEnd: event.target.value })}
            />
          </>
        )
      case 'offset':
        return (
          <>
            <input
              type="number"
              min={1}
              className={`${styles.ruleInput} ${styles.conditionNumberInput}`}
              value={param.offsetValue ?? 30}
              onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { offsetValue: Number(event.target.value) || 0 })}
            />
            <select
              className={styles.ruleSelect}
              value={param.offsetUnit || 'minutes'}
              onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { offsetUnit: event.target.value as ConditionOffsetUnit })}
            >
              {OFFSET_UNIT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </>
        )
      case 'amount':
        return (
          <input
            type="number"
            min={0}
            className={`${styles.ruleInput} ${styles.conditionNumberInput}`}
            value={param.amount ?? ''}
            placeholder="0"
            onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { amount: Number(event.target.value) || 0 })}
          />
        )
      case 'amountRange':
        return (
          <>
            <input
              type="number"
              min={0}
              className={`${styles.ruleInput} ${styles.conditionNumberInput}`}
              value={param.amount ?? ''}
              placeholder="Mínimo"
              onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { amount: Number(event.target.value) || 0 })}
            />
            <span>y</span>
            <input
              type="number"
              min={0}
              className={`${styles.ruleInput} ${styles.conditionNumberInput}`}
              value={param.amountMax ?? ''}
              placeholder="Máximo"
              onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { amountMax: Number(event.target.value) || 0 })}
            />
          </>
        )
      case 'ad':
        return (
          <select
            className={styles.ruleSelect}
            value={param.value || ''}
            onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { value: event.target.value })}
          >
            <option value="">Elige un anuncio</option>
            {(options?.ads || []).map((ad) => (
              <option key={ad.id} value={ad.id}>
                {ad.detected ? '● ' : ''}{ad.name}{ad.campaign ? ` — ${ad.campaign}` : ''}
              </option>
            ))}
          </select>
        )
      case 'businessPhone':
        return (
          <select
            className={styles.ruleSelect}
            value={param.value || ''}
            onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { value: event.target.value })}
          >
            <option value="">Elige un número</option>
            {(options?.businessPhones || []).map((phone) => (
              <option key={phone.id} value={phone.id}>{phone.label}</option>
            ))}
          </select>
        )
      case 'timeRange':
        return (
          <>
            <input
              type="time"
              className={`${styles.ruleInput} ${styles.conditionNumberInput}`}
              value={param.timeStart || '09:00'}
              onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { timeStart: event.target.value })}
            />
            <span>y</span>
            <input
              type="time"
              className={`${styles.ruleInput} ${styles.conditionNumberInput}`}
              value={param.timeEnd || '18:00'}
              onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { timeEnd: event.target.value })}
            />
          </>
        )
      case 'customField':
      case 'customFieldValue':
        return (
          <>
            <select
              className={styles.ruleSelect}
              value={param.fieldKey || ''}
              onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { fieldKey: event.target.value })}
            >
              <option value="">Elige el campo</option>
              {(options?.customFields || []).map((field) => (
                <option key={field.key} value={field.key}>{field.label}</option>
              ))}
            </select>
            {operator.valueKind === 'customFieldValue' && (
              <input
                className={styles.ruleInput}
                value={param.value || ''}
                placeholder="Valor"
                onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { value: event.target.value })}
              />
            )}
          </>
        )
      default:
        return null
    }
  }

  const renderEditingCondition = (condition: AgentCondition, groupIndex: number, conditionIndex: number, key: string) => {
    const category = getCategory(condition.category)
    const usedPresence = condition.params.some((param) => param.field === 'presence')
    const paramMenuItems = category.params
      .filter((param) => param.field !== 'presence' || !usedPresence)
      .map((param) => ({ id: param.field, label: param.menuLabel }))

    return (
      <div className={styles.conditionEditPanel}>
        <div className={styles.conditionEditHeader}>
          <select
            className={styles.ruleSelect}
            value={condition.category}
            onChange={(event) => updateCondition(groupIndex, conditionIndex, defaultCondition(event.target.value as ConditionCategory))}
          >
            {CONDITION_CATEGORIES.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
          <span className={styles.conditionBaseHint}>{category.baseLabel}</span>
          <button type="button" className={styles.ruleDelete} onClick={() => setEditing(key, false)} aria-label="Listo">
            <Check size={14} />
          </button>
        </div>

        {condition.params.map((param, paramIndex) => {
          const paramDef = getParamDef(condition.category, param.field)
          return (
            <div key={paramIndex} className={styles.conditionParamRow}>
              <select
                className={styles.ruleSelect}
                value={param.field}
                onChange={(event) => replaceParam(groupIndex, conditionIndex, paramIndex, defaultParamFor(condition.category, event.target.value))}
              >
                {category.params.map((item) => (
                  <option key={item.field} value={item.field}>{item.menuLabel}</option>
                ))}
              </select>
              {paramDef.operators.length > 1 && (
                <select
                  className={styles.ruleSelect}
                  value={param.operator}
                  onChange={(event) => {
                    const nextOperator = getOperatorDef(condition.category, param.field, event.target.value)
                    const fresh = defaultParamFor(condition.category, param.field)
                    fresh.operator = nextOperator.id
                    // Conserva los valores cuando el tipo de dato coincide
                    if (nextOperator.valueKind === getOperatorDef(condition.category, param.field, param.operator).valueKind) {
                      replaceParam(groupIndex, conditionIndex, paramIndex, { ...param, operator: nextOperator.id })
                    } else {
                      replaceParam(groupIndex, conditionIndex, paramIndex, fresh)
                    }
                  }}
                >
                  {paramDef.operators.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              )}
              {renderParamValue(condition, param, groupIndex, conditionIndex, paramIndex)}
              <button
                type="button"
                className={styles.ruleDelete}
                onClick={() => updateCondition(groupIndex, conditionIndex, {
                  ...condition,
                  params: condition.params.filter((_, pi) => pi !== paramIndex)
                })}
                aria-label="Quitar parámetro"
              >
                <X size={13} />
              </button>
            </div>
          )
        })}

        <DropdownMenu
          label="Añadir parámetro"
          small
          items={paramMenuItems}
          onSelect={(field) => updateCondition(groupIndex, conditionIndex, {
            ...condition,
            params: [...condition.params, defaultParamFor(condition.category, field)]
          })}
        />
      </div>
    )
  }

  const categoryMenuItems = CONDITION_CATEGORIES.map((category) => ({ id: category.id, label: category.label }))

  return (
    <div className={styles.conditionBuilder}>
      {groups.length === 0 && <p className={styles.ruleEmptyHint}>{emptyText}</p>}

      {groups.map((group, groupIndex) => (
        <React.Fragment key={groupIndex}>
          {groupIndex > 0 && (
            <div className={styles.orDivider} aria-hidden="true">
              <span />
              <strong>O</strong>
              <span />
            </div>
          )}

          <div className={styles.conditionGroup}>
            {group.conditions.map((condition, conditionIndex) => {
              const key = `${groupIndex}:${conditionIndex}`
              const editing = editingKeys.has(key)

              return (
                <div key={key} className={`${styles.conditionRow} ${editing ? styles.conditionRowEditing : ''}`}>
                  <span className={styles.rulePrefix}>
                    {conditionIndex === 0 ? 'Si' : 'Y'}
                  </span>

                  {editing ? (
                    renderEditingCondition(condition, groupIndex, conditionIndex, key)
                  ) : (
                    <>
                      <span className={styles.conditionSentence}>{conditionSummary(condition, calendars, options)}</span>
                      <div className={styles.conditionActions}>
                        <button type="button" className={styles.ruleDelete} onClick={() => setEditing(key, true)} aria-label="Editar condición">
                          <Pencil size={13} />
                        </button>
                        <button type="button" className={styles.ruleDelete} onClick={() => duplicateCondition(groupIndex, conditionIndex)} aria-label="Duplicar condición">
                          <Copy size={13} />
                        </button>
                        <button type="button" className={styles.ruleDelete} onClick={() => removeCondition(groupIndex, conditionIndex)} aria-label="Eliminar condición">
                          <X size={14} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )
            })}

            <DropdownMenu label="Añadir condición" items={categoryMenuItems} onSelect={(id) => addCondition(groupIndex, id as ConditionCategory)} />
          </div>
        </React.Fragment>
      ))}

      <DropdownMenu
        label={groups.length ? 'Añadir grupo "O"' : 'Añadir condición'}
        items={categoryMenuItems}
        onSelect={(id) => addGroup(id as ConditionCategory)}
      />
    </div>
  )
}
