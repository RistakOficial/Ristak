import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Pencil, Plus, X } from 'lucide-react'
import type { AgentCondition, AgentFilterOptions, ConditionCategory, ConditionGroup, ConditionOffsetUnit } from '@/services/conversationalAgentService'
import type { Calendar } from '@/services/calendarsService'
import { TagPicker, useContactTags } from '@/components/common'
import { contactTagsService } from '@/services/contactTagsService'
import styles from './AIAgentSettings.module.css'

/**
 * Constructor de condiciones profesional para los agentes conversacionales.
 *
 * Estructura: bloques unidos por O; dentro de cada bloque las condiciones se
 * unen por Y. Cada condición se muestra como fila compacta (frase legible) con
 * editar / duplicar / eliminar; al editar se eligen categoría → operador →
 * valor. Para agregar categorías u operadores futuros basta con extender el
 * catálogo de abajo (el backend valida contra el suyo propio).
 */

type ValueKind =
  | 'none' | 'channel' | 'text' | 'list' | 'calendar' | 'date' | 'dateRange'
  | 'offset' | 'amount' | 'amountRange' | 'ad' | 'businessPhone' | 'timeRange' | 'weekdays'

interface OperatorDef {
  id: string
  label: string
  valueKind: ValueKind
  /** placeholder del input de texto/lista */
  placeholder?: string
}

interface CategoryDef {
  id: ConditionCategory
  label: string
  operators: OperatorDef[]
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

export const CONDITION_CATEGORIES: CategoryDef[] = [
  {
    id: 'channel',
    label: 'Canal',
    operators: [
      { id: 'is', label: 'es', valueKind: 'channel' },
      { id: 'is_not', label: 'no es', valueKind: 'channel' }
    ]
  },
  {
    id: 'message',
    label: 'Mensaje',
    operators: [
      { id: 'contains', label: 'contiene', valueKind: 'text', placeholder: 'Texto a buscar' },
      { id: 'not_contains', label: 'no contiene', valueKind: 'text', placeholder: 'Texto a evitar' },
      { id: 'contains_any', label: 'contiene alguna de estas frases', valueKind: 'list', placeholder: 'Frase y Enter' },
      { id: 'contains_all', label: 'contiene todas estas frases', valueKind: 'list', placeholder: 'Frase y Enter' },
      { id: 'starts_with', label: 'empieza con', valueKind: 'text', placeholder: 'Inicio del mensaje' },
      { id: 'ends_with', label: 'termina con', valueKind: 'text', placeholder: 'Final del mensaje' },
      { id: 'equals', label: 'coincide exactamente con', valueKind: 'text', placeholder: 'Mensaje exacto' }
    ]
  },
  {
    id: 'tags',
    label: 'Etiquetas',
    operators: [
      { id: 'has', label: 'tiene la etiqueta', valueKind: 'text', placeholder: 'Nombre de la etiqueta' },
      { id: 'not_has', label: 'no tiene la etiqueta', valueKind: 'text', placeholder: 'Nombre de la etiqueta' },
      { id: 'has_any', label: 'tiene cualquiera de estas etiquetas', valueKind: 'list', placeholder: 'Etiqueta y Enter' },
      { id: 'has_all', label: 'tiene todas estas etiquetas', valueKind: 'list', placeholder: 'Etiqueta y Enter' },
      { id: 'has_none', label: 'no tiene ninguna de estas etiquetas', valueKind: 'list', placeholder: 'Etiqueta y Enter' }
    ]
  },
  {
    id: 'appointments',
    label: 'Calendarios y citas',
    operators: [
      { id: 'has_appointment', label: 'tiene cita', valueKind: 'none' },
      { id: 'no_appointment', label: 'no tiene cita', valueKind: 'none' },
      { id: 'has_upcoming', label: 'tiene cita próxima', valueKind: 'none' },
      { id: 'no_upcoming', label: 'no tiene cita próxima', valueKind: 'none' },
      { id: 'has_past_due', label: 'tiene cita vencida', valueKind: 'none' },
      { id: 'has_cancelled', label: 'tiene cita cancelada', valueKind: 'none' },
      { id: 'has_confirmed', label: 'tiene cita confirmada', valueKind: 'none' },
      { id: 'in_calendar', label: 'está agendado en', valueKind: 'calendar' },
      { id: 'not_in_calendar', label: 'no está agendado en', valueKind: 'calendar' },
      { id: 'date_is', label: 'la cita es exactamente el', valueKind: 'date' },
      { id: 'date_not', label: 'la cita no es el', valueKind: 'date' },
      { id: 'date_before', label: 'la cita es antes del', valueKind: 'date' },
      { id: 'date_after', label: 'la cita es después del', valueKind: 'date' },
      { id: 'date_between', label: 'la cita es entre', valueKind: 'dateRange' },
      { id: 'time_before', label: 'antes de la cita', valueKind: 'offset' },
      { id: 'time_after', label: 'después de la cita', valueKind: 'offset' }
    ]
  },
  {
    id: 'payments',
    label: 'Pagos',
    operators: [
      { id: 'payment_received', label: 'pago recibido', valueKind: 'none' },
      { id: 'payment_pending', label: 'pago pendiente', valueKind: 'none' },
      { id: 'payment_failed', label: 'pago fallido', valueKind: 'none' },
      { id: 'payment_refunded', label: 'pago reembolsado', valueKind: 'none' },
      { id: 'product_is', label: 'producto es', valueKind: 'text', placeholder: 'Nombre del producto' },
      { id: 'product_not', label: 'producto no es', valueKind: 'text', placeholder: 'Nombre del producto' },
      { id: 'product_contains', label: 'producto contiene', valueKind: 'text', placeholder: 'Parte del nombre' },
      { id: 'product_not_contains', label: 'producto no contiene', valueKind: 'text', placeholder: 'Parte del nombre' },
      { id: 'amount_eq', label: 'monto igual a', valueKind: 'amount' },
      { id: 'amount_gt', label: 'monto mayor que', valueKind: 'amount' },
      { id: 'amount_lt', label: 'monto menor que', valueKind: 'amount' },
      { id: 'amount_between', label: 'monto entre', valueKind: 'amountRange' }
    ]
  },
  {
    id: 'assignee',
    label: 'Contacto asignado',
    operators: [
      { id: 'assigned_to', label: 'está asignado a', valueKind: 'text', placeholder: 'Nombre del usuario' },
      { id: 'not_assigned_to', label: 'no está asignado a', valueKind: 'text', placeholder: 'Nombre del usuario' },
      { id: 'has_assignee', label: 'tiene cualquier asignado', valueKind: 'none' },
      { id: 'no_assignee', label: 'no tiene asignado', valueKind: 'none' }
    ]
  },
  {
    id: 'ads',
    label: 'Anuncios',
    operators: [
      { id: 'from_ad', label: 'vino de un anuncio (clic de WhatsApp)', valueKind: 'none' },
      { id: 'not_from_ad', label: 'no vino de anuncio', valueKind: 'none' },
      { id: 'ad_is', label: 'el anuncio es', valueKind: 'ad' },
      { id: 'ad_is_not', label: 'el anuncio no es', valueKind: 'ad' }
    ]
  },
  {
    id: 'contact',
    label: 'Perfil del contacto',
    operators: [
      { id: 'is_customer', label: 'es cliente (tiene compras)', valueKind: 'none' },
      { id: 'not_customer', label: 'no es cliente todavía', valueKind: 'none' },
      { id: 'has_email', label: 'tiene email registrado', valueKind: 'none' },
      { id: 'no_email', label: 'no tiene email', valueKind: 'none' },
      { id: 'source_is', label: 'el origen es', valueKind: 'text', placeholder: 'ej. meta_ads, google, referido' },
      { id: 'source_contains', label: 'el origen contiene', valueKind: 'text', placeholder: 'Parte del origen' },
      { id: 'created_within', label: 'se creó hace menos de', valueKind: 'offset' }
    ]
  },
  {
    id: 'schedule',
    label: 'Fecha y hora',
    operators: [
      { id: 'time_between', label: 'la hora actual está entre', valueKind: 'timeRange' },
      { id: 'time_outside', label: 'la hora actual está fuera de', valueKind: 'timeRange' },
      { id: 'day_is', label: 'el día es', valueKind: 'weekdays' }
    ]
  },
  {
    id: 'business_phone',
    label: 'Número del negocio',
    operators: [
      { id: 'is', label: 'el mensaje llegó al número', valueKind: 'businessPhone' },
      { id: 'is_not', label: 'el mensaje no llegó al número', valueKind: 'businessPhone' }
    ]
  }
]

function getCategory(categoryId: string): CategoryDef {
  return CONDITION_CATEGORIES.find((category) => category.id === categoryId) || CONDITION_CATEGORIES[0]
}

function getOperator(categoryId: string, operatorId: string): OperatorDef {
  const category = getCategory(categoryId)
  return category.operators.find((operator) => operator.id === operatorId) || category.operators[0]
}

function defaultCondition(categoryId: ConditionCategory): AgentCondition {
  const operator = getCategory(categoryId).operators[0]
  const condition: AgentCondition = { category: categoryId, operator: operator.id }
  if (operator.valueKind === 'channel') condition.value = 'whatsapp'
  if (operator.valueKind === 'list' || operator.valueKind === 'weekdays') condition.values = []
  if (operator.valueKind === 'offset') {
    condition.offsetValue = 30
    condition.offsetUnit = categoryId === 'contact' ? 'days' : 'minutes'
  }
  if (operator.valueKind === 'timeRange') {
    condition.timeStart = '09:00'
    condition.timeEnd = '18:00'
  }
  return condition
}

function formatAmount(value?: number) {
  return `$${Number(value || 0).toLocaleString('es-MX')}`
}

/** Nombre legible de una etiqueta: las condiciones guardan el ID del catálogo */
function tagDisplayName(value: string): string {
  const tag = (contactTagsService.getCachedTags() || []).find((item) => item.id === value)
  return tag?.name || value
}

/** Frase legible de una condición para la fila compacta. */
export function conditionSummary(condition: AgentCondition, calendars: Calendar[], options?: AgentFilterOptions): string {
  const category = getCategory(condition.category)
  const operator = getOperator(condition.category, condition.operator)
  const isTagCondition = condition.category === 'tags'

  switch (operator.valueKind) {
    case 'ad': {
      const ad = options?.ads.find((item) => item.id === condition.value)
      return `${category.label}: ${operator.label} "${ad?.name || condition.value || '…'}"`
    }
    case 'businessPhone': {
      const phone = options?.businessPhones.find((item) => item.id === condition.value)
      return `${category.label}: ${operator.label} ${phone?.label || condition.value || '…'}`
    }
    case 'timeRange':
      return `${category.label}: ${operator.label} ${condition.timeStart || '…'} y ${condition.timeEnd || '…'}`
    case 'weekdays': {
      const days = (condition.values || [])
        .map((value) => WEEKDAY_OPTIONS.find((option) => option.value === value)?.label || value)
      return `${category.label}: ${operator.label} ${days.length ? days.join(', ') : '…'}`
    }
    case 'channel': {
      const channel = CHANNEL_OPTIONS.find((option) => option.value === condition.value)
      return `${category.label} ${operator.label} ${channel?.label || condition.value || '…'}`
    }
    case 'text': {
      const display = isTagCondition ? tagDisplayName(condition.value || '') : condition.value
      return `${category.label} ${operator.label} "${display || '…'}"`
    }
    case 'list': {
      const list = (condition.values || []).filter(Boolean).map((value) => (isTagCondition ? tagDisplayName(value) : value))
      return `${category.label} ${operator.label}: ${list.length ? list.join(', ') : '…'}`
    }
    case 'calendar': {
      const calendar = calendars.find((item) => item.id === condition.calendarId)
      return `${category.label} ${operator.label} ${calendar?.name || '…'}`
    }
    case 'date':
      return `${category.label}: ${operator.label} ${condition.date || '…'}`
    case 'dateRange':
      return `${category.label}: ${operator.label} ${condition.date || '…'} y ${condition.dateEnd || '…'}`
    case 'offset': {
      const unit = OFFSET_UNIT_OPTIONS.find((option) => option.value === condition.offsetUnit)
      return `${category.label}: ${condition.offsetValue || 0} ${unit?.label || 'minutos'} ${operator.label}`
    }
    case 'amount':
      return `${category.label}: ${operator.label} ${formatAmount(condition.amount)}`
    case 'amountRange':
      return `${category.label}: ${operator.label} ${formatAmount(condition.amount)} y ${formatAmount(condition.amountMax)}`
    default:
      return `${category.label}: ${operator.label}`
  }
}

/** Editor compacto de listas de frases/etiquetas dentro de la fila en edición. */
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

const AddConditionMenu: React.FC<{
  label: string
  onSelect: (category: ConditionCategory) => void
}> = ({ label, onSelect }) => {
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
      <button type="button" className={styles.ruleAddButton} onClick={() => setOpen((current) => !current)}>
        <Plus size={14} />
        {label}
      </button>
      {open && (
        <div className={styles.ruleAddMenu} role="menu">
          {CONDITION_CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              role="menuitem"
              className={styles.ruleAddMenuItem}
              onClick={() => {
                onSelect(category.id)
                setOpen(false)
              }}
            >
              {category.label}
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

export const ConditionBuilder: React.FC<ConditionBuilderProps> = ({ groups, mode, calendars, options, emptyText, onChange }) => {
  // Carga el catálogo de etiquetas para que las frases muestren nombres y no IDs
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

  const updateCondition = (groupIndex: number, conditionIndex: number, patch: Partial<AgentCondition>) => {
    onChange(groups.map((group, gi) => (
      gi !== groupIndex ? group : {
        conditions: group.conditions.map((condition, ci) => (
          ci !== conditionIndex ? condition : { ...condition, ...patch }
        ))
      }
    )))
  }

  const replaceCondition = (groupIndex: number, conditionIndex: number, next: AgentCondition) => {
    onChange(groups.map((group, gi) => (
      gi !== groupIndex ? group : {
        conditions: group.conditions.map((condition, ci) => (ci !== conditionIndex ? condition : next))
      }
    )))
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
    onChange(groups.map((group, gi) => (
      gi !== groupIndex ? group : {
        conditions: [
          ...group.conditions.slice(0, conditionIndex + 1),
          { ...group.conditions[conditionIndex], values: group.conditions[conditionIndex].values ? [...group.conditions[conditionIndex].values!] : undefined },
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
    const condition = defaultCondition(category)
    onChange([...groups, { conditions: [condition] }])
    setEditing(`${groups.length}:0`, true)
  }

  const renderValueControls = (condition: AgentCondition, groupIndex: number, conditionIndex: number) => {
    const operator = getOperator(condition.category, condition.operator)
    switch (operator.valueKind) {
      case 'channel':
        return (
          <select
            className={styles.ruleSelect}
            value={condition.value || 'whatsapp'}
            onChange={(event) => updateCondition(groupIndex, conditionIndex, { value: event.target.value })}
          >
            {CHANNEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        )
      case 'text':
        // Etiquetas: selector con buscador y "crear etiqueta" inline; guarda el ID
        if (condition.category === 'tags') {
          return (
            <div className={styles.conditionTagPicker}>
              <TagPicker
                value={condition.value || ''}
                onValueChange={(tagId) => updateCondition(groupIndex, conditionIndex, { value: tagId })}
                includeSystem
                allowCreate
                portal
                placeholder="Elige una etiqueta"
                aria-label="Etiqueta de la condición"
              />
            </div>
          )
        }
        return (
          <input
            className={styles.ruleInput}
            value={condition.value || ''}
            placeholder={operator.placeholder || 'Valor'}
            onChange={(event) => updateCondition(groupIndex, conditionIndex, { value: event.target.value })}
          />
        )
      case 'list':
        if (condition.category === 'tags') {
          return (
            <div className={styles.conditionTagPicker}>
              <TagPicker
                multiple
                selectedIds={condition.values || []}
                onChange={(values) => updateCondition(groupIndex, conditionIndex, { values })}
                includeSystem
                allowCreate
                portal
                aria-label="Etiquetas de la condición"
              />
            </div>
          )
        }
        return (
          <ListEditor
            values={condition.values || []}
            placeholder={operator.placeholder || 'Valor y Enter'}
            onChange={(values) => updateCondition(groupIndex, conditionIndex, { values })}
          />
        )
      case 'calendar':
        return (
          <select
            className={styles.ruleSelect}
            value={condition.calendarId || ''}
            onChange={(event) => updateCondition(groupIndex, conditionIndex, { calendarId: event.target.value })}
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
            value={condition.date || ''}
            onChange={(event) => updateCondition(groupIndex, conditionIndex, { date: event.target.value })}
          />
        )
      case 'dateRange':
        return (
          <>
            <input
              type="date"
              className={styles.ruleInput}
              value={condition.date || ''}
              onChange={(event) => updateCondition(groupIndex, conditionIndex, { date: event.target.value })}
            />
            <span>y</span>
            <input
              type="date"
              className={styles.ruleInput}
              value={condition.dateEnd || ''}
              onChange={(event) => updateCondition(groupIndex, conditionIndex, { dateEnd: event.target.value })}
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
              value={condition.offsetValue ?? 30}
              onChange={(event) => updateCondition(groupIndex, conditionIndex, { offsetValue: Number(event.target.value) || 0 })}
            />
            <select
              className={styles.ruleSelect}
              value={condition.offsetUnit || 'minutes'}
              onChange={(event) => updateCondition(groupIndex, conditionIndex, { offsetUnit: event.target.value as ConditionOffsetUnit })}
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
            value={condition.amount ?? ''}
            placeholder="0"
            onChange={(event) => updateCondition(groupIndex, conditionIndex, { amount: Number(event.target.value) || 0 })}
          />
        )
      case 'amountRange':
        return (
          <>
            <input
              type="number"
              min={0}
              className={`${styles.ruleInput} ${styles.conditionNumberInput}`}
              value={condition.amount ?? ''}
              placeholder="Mínimo"
              onChange={(event) => updateCondition(groupIndex, conditionIndex, { amount: Number(event.target.value) || 0 })}
            />
            <span>y</span>
            <input
              type="number"
              min={0}
              className={`${styles.ruleInput} ${styles.conditionNumberInput}`}
              value={condition.amountMax ?? ''}
              placeholder="Máximo"
              onChange={(event) => updateCondition(groupIndex, conditionIndex, { amountMax: Number(event.target.value) || 0 })}
            />
          </>
        )
      case 'ad':
        return (
          <select
            className={styles.ruleSelect}
            value={condition.value || ''}
            onChange={(event) => updateCondition(groupIndex, conditionIndex, { value: event.target.value })}
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
            value={condition.value || ''}
            onChange={(event) => updateCondition(groupIndex, conditionIndex, { value: event.target.value })}
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
              value={condition.timeStart || '09:00'}
              onChange={(event) => updateCondition(groupIndex, conditionIndex, { timeStart: event.target.value })}
            />
            <span>y</span>
            <input
              type="time"
              className={`${styles.ruleInput} ${styles.conditionNumberInput}`}
              value={condition.timeEnd || '18:00'}
              onChange={(event) => updateCondition(groupIndex, conditionIndex, { timeEnd: event.target.value })}
            />
          </>
        )
      case 'weekdays': {
        const selected = condition.values || []
        return (
          <span className={styles.weekdayPicker}>
            {WEEKDAY_OPTIONS.map((day) => {
              const active = selected.includes(day.value)
              return (
                <button
                  key={day.value}
                  type="button"
                  className={`${styles.weekdayButton} ${active ? styles.weekdayButtonActive : ''}`}
                  aria-pressed={active}
                  title={day.label}
                  onClick={() => updateCondition(groupIndex, conditionIndex, {
                    values: active ? selected.filter((value) => value !== day.value) : [...selected, day.value]
                  })}
                >
                  {day.short}
                </button>
              )
            })}
          </span>
        )
      }
      default:
        return null
    }
  }

  const connectorLabel = useMemo(() => (mode === 'entry' ? 'Y' : 'Y'), [mode])

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
              const category = getCategory(condition.category)
              const operator = getOperator(condition.category, condition.operator)

              return (
                <div key={key} className={`${styles.conditionRow} ${editing ? styles.conditionRowEditing : ''}`}>
                  <span className={styles.rulePrefix}>
                    {conditionIndex === 0 ? 'Si' : connectorLabel}
                  </span>

                  {editing ? (
                    <>
                      <select
                        className={styles.ruleSelect}
                        value={condition.category}
                        onChange={(event) => {
                          replaceCondition(groupIndex, conditionIndex, defaultCondition(event.target.value as ConditionCategory))
                        }}
                      >
                        {CONDITION_CATEGORIES.map((item) => (
                          <option key={item.id} value={item.id}>{item.label}</option>
                        ))}
                      </select>
                      <select
                        className={styles.ruleSelect}
                        value={operator.id}
                        onChange={(event) => {
                          const nextOperator = getOperator(condition.category, event.target.value)
                          const next = defaultCondition(condition.category)
                          next.operator = nextOperator.id
                          // Conserva el valor cuando el tipo de dato coincide
                          if (nextOperator.valueKind === getOperator(condition.category, condition.operator).valueKind) {
                            Object.assign(next, condition, { operator: nextOperator.id })
                          }
                          replaceCondition(groupIndex, conditionIndex, next)
                        }}
                      >
                        {category.operators.map((item) => (
                          <option key={item.id} value={item.id}>{item.label}</option>
                        ))}
                      </select>
                      {renderValueControls(condition, groupIndex, conditionIndex)}
                      <div className={styles.conditionActions}>
                        <button type="button" className={styles.ruleDelete} onClick={() => setEditing(key, false)} aria-label="Listo">
                          <Check size={14} />
                        </button>
                      </div>
                    </>
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

            <AddConditionMenu label="Añadir condición" onSelect={(category) => addCondition(groupIndex, category)} />
          </div>
        </React.Fragment>
      ))}

      <AddConditionMenu
        label={groups.length ? 'Añadir grupo "O"' : 'Añadir condición'}
        onSelect={addGroup}
      />
    </div>
  )
}
