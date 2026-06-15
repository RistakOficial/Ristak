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
  /** etiqueta base del criterio dentro de la categoría */
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

function textOperatorPhrase(subject: string, param: AgentConditionParam) {
  const value = param.value || '…'
  switch (param.operator) {
    case 'is':
      return `${subject} es igual a "${value}"`
    case 'is_not':
      return `${subject} no es igual a "${value}"`
    case 'not_contains':
      return `${subject} no contiene "${value}"`
    case 'starts_with':
      return `${subject} empieza con "${value}"`
    case 'ends_with':
      return `${subject} termina con "${value}"`
    case 'empty':
    case 'no_has':
      return `${subject} está vacío`
    case 'not_empty':
    case 'has':
    case 'has_value':
      return `${subject} no está vacío`
    default:
      return `${subject} contiene "${value}"`
  }
}

function textOperators(subject: string, placeholder: string): OperatorDef[] {
  return [
    { id: 'contains', label: 'contiene', valueKind: 'text', placeholder, phrase: (p) => textOperatorPhrase(subject, p) },
    { id: 'not_contains', label: 'no contiene', valueKind: 'text', placeholder, phrase: (p) => textOperatorPhrase(subject, p) },
    { id: 'is', label: 'es igual a', valueKind: 'text', placeholder, phrase: (p) => textOperatorPhrase(subject, p) },
    { id: 'is_not', label: 'no es igual a', valueKind: 'text', placeholder, phrase: (p) => textOperatorPhrase(subject, p) },
    { id: 'starts_with', label: 'empieza con', valueKind: 'text', placeholder, phrase: (p) => textOperatorPhrase(subject, p) },
    { id: 'ends_with', label: 'termina con', valueKind: 'text', placeholder, phrase: (p) => textOperatorPhrase(subject, p) },
    { id: 'not_empty', label: 'no está vacío', valueKind: 'none', phrase: (p) => textOperatorPhrase(subject, p) },
    { id: 'empty', label: 'está vacío', valueKind: 'none', phrase: (p) => textOperatorPhrase(subject, p) }
  ]
}

function dateOperators(subject: string): OperatorDef[] {
  return [
    { id: 'within', label: 'hace menos de', valueKind: 'offset', phrase: (p) => `${subject} hace menos de ${offsetPhrase(p, '')}`.trim() },
    { id: 'older_than', label: 'hace más de', valueKind: 'offset', phrase: (p) => `${subject} hace más de ${offsetPhrase(p, '')}`.trim() },
    { id: 'before', label: 'antes de', valueKind: 'date', phrase: (p) => `${subject} antes de ${p.date || '…'}` },
    { id: 'after', label: 'después de', valueKind: 'date', phrase: (p) => `${subject} después de ${p.date || '…'}` },
    { id: 'between', label: 'entre fechas', valueKind: 'dateRange', phrase: (p) => `${subject} entre ${p.date || '…'} y ${p.dateEnd || '…'}` }
  ]
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
          { id: 'is', label: 'es', valueKind: 'channel', phrase: (p) => `llegó por ${channelLabel(p.value)}` },
          { id: 'is_not', label: 'no es', valueKind: 'channel', phrase: (p) => `no llegó por ${channelLabel(p.value)}` }
        ]
      }
    ]
  },
  {
    id: 'message',
    label: 'Mensaje',
    baseLabel: 'llegó cualquier mensaje',
    params: [
      {
        field: 'text',
        menuLabel: 'Texto del mensaje',
        operators: [
          { id: 'contains', label: 'contiene', valueKind: 'text', placeholder: 'Texto a buscar', phrase: (p) => `el mensaje contiene "${p.value || '…'}"` },
          { id: 'not_contains', label: 'no contiene', valueKind: 'text', placeholder: 'Texto a evitar', phrase: (p) => `el mensaje no contiene "${p.value || '…'}"` },
          { id: 'contains_any', label: 'contiene alguna de estas palabras', valueKind: 'list', placeholder: 'Palabra y Enter', phrase: (p) => `el mensaje contiene alguna de: ${(p.values || []).join(', ') || '…'}` },
          { id: 'contains_all', label: 'contiene todas estas palabras', valueKind: 'list', placeholder: 'Palabra y Enter', phrase: (p) => `el mensaje contiene todas: ${(p.values || []).join(', ') || '…'}` },
          { id: 'starts_with', label: 'empieza con', valueKind: 'text', placeholder: 'Primeras palabras', phrase: (p) => `el mensaje empieza con "${p.value || '…'}"` },
          { id: 'ends_with', label: 'termina con', valueKind: 'text', placeholder: 'Últimas palabras', phrase: (p) => `el mensaje termina con "${p.value || '…'}"` },
          { id: 'equals', label: 'es exactamente', valueKind: 'text', placeholder: 'Mensaje exacto', phrase: (p) => `el mensaje es "${p.value || '…'}"` }
        ]
      },
      {
        field: 'business_phone',
        menuLabel: 'Número donde llegó el mensaje',
        operators: [
          { id: 'is', label: 'llegó al número', valueKind: 'businessPhone', phrase: (p, h) => `llegó al número ${h.phoneLabel(p.value)}` },
          { id: 'is_not', label: 'no llegó al número', valueKind: 'businessPhone', phrase: (p, h) => `no llegó al número ${h.phoneLabel(p.value)}` }
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
          { id: 'has', label: 'Tiene', valueKind: 'tag', phrase: (p, h) => `tiene la etiqueta "${h.tagName(p.value)}"` },
          { id: 'not_has', label: 'No tiene', valueKind: 'tag', phrase: (p, h) => `no tiene la etiqueta "${h.tagName(p.value)}"` },
          { id: 'has_any', label: 'Tiene alguna', valueKind: 'tagList', phrase: (p, h) => `tiene alguna de: ${(p.values || []).map(h.tagName).join(', ') || '…'}` },
          { id: 'has_all', label: 'Tiene todas', valueKind: 'tagList', phrase: (p, h) => `tiene todas: ${(p.values || []).map(h.tagName).join(', ') || '…'}` },
          { id: 'has_none', label: 'No tiene ninguna', valueKind: 'tagList', phrase: (p, h) => `no tiene ninguna de: ${(p.values || []).map(h.tagName).join(', ') || '…'}` }
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
        menuLabel: 'Nombre completo',
        operators: textOperators('el nombre completo', 'Nombre completo')
      },
      {
        field: 'first_name',
        menuLabel: 'Nombre',
        operators: textOperators('el nombre', 'Nombre')
      },
      {
        field: 'last_name',
        menuLabel: 'Apellido',
        operators: textOperators('el apellido', 'Apellido')
      },
      {
        field: 'email',
        menuLabel: 'Correo electrónico',
        operators: [
          { id: 'contains', label: 'contiene', valueKind: 'text', placeholder: 'ej. @gmail.com', phrase: (p) => textOperatorPhrase('el correo', p) },
          { id: 'not_contains', label: 'no contiene', valueKind: 'text', placeholder: 'ej. @gmail.com', phrase: (p) => textOperatorPhrase('el correo', p) },
          { id: 'is', label: 'es igual a', valueKind: 'text', placeholder: 'correo@ejemplo.com', phrase: (p) => textOperatorPhrase('el correo', p) },
          { id: 'is_not', label: 'no es igual a', valueKind: 'text', placeholder: 'correo@ejemplo.com', phrase: (p) => textOperatorPhrase('el correo', p) },
          { id: 'starts_with', label: 'empieza con', valueKind: 'text', placeholder: 'inicio del correo', phrase: (p) => textOperatorPhrase('el correo', p) },
          { id: 'ends_with', label: 'termina con', valueKind: 'text', placeholder: '@dominio.com', phrase: (p) => textOperatorPhrase('el correo', p) },
          { id: 'has', label: 'no está vacío', valueKind: 'none', phrase: (p) => textOperatorPhrase('el correo', p) },
          { id: 'no_has', label: 'está vacío', valueKind: 'none', phrase: (p) => textOperatorPhrase('el correo', p) }
        ]
      },
      {
        field: 'phone',
        menuLabel: 'Teléfono',
        operators: textOperators('el teléfono', 'ej. 33 o +52')
      },
      {
        field: 'custom_field',
        menuLabel: 'Campo personalizado',
        operators: [
          { id: 'is', label: 'es igual a', valueKind: 'customFieldValue', phrase: (p, h) => `${h.customFieldLabel(p.fieldKey)} es igual a "${p.value || '…'}"` },
          { id: 'is_not', label: 'no es igual a', valueKind: 'customFieldValue', phrase: (p, h) => `${h.customFieldLabel(p.fieldKey)} no es igual a "${p.value || '…'}"` },
          { id: 'contains', label: 'contiene', valueKind: 'customFieldValue', phrase: (p, h) => `${h.customFieldLabel(p.fieldKey)} contiene "${p.value || '…'}"` },
          { id: 'not_contains', label: 'no contiene', valueKind: 'customFieldValue', phrase: (p, h) => `${h.customFieldLabel(p.fieldKey)} no contiene "${p.value || '…'}"` },
          { id: 'starts_with', label: 'empieza con', valueKind: 'customFieldValue', phrase: (p, h) => `${h.customFieldLabel(p.fieldKey)} empieza con "${p.value || '…'}"` },
          { id: 'ends_with', label: 'termina con', valueKind: 'customFieldValue', phrase: (p, h) => `${h.customFieldLabel(p.fieldKey)} termina con "${p.value || '…'}"` },
          { id: 'has_value', label: 'no está vacío', valueKind: 'customField', phrase: (p, h) => `${h.customFieldLabel(p.fieldKey)} no está vacío` },
          { id: 'empty', label: 'está vacío', valueKind: 'customField', phrase: (p, h) => `${h.customFieldLabel(p.fieldKey)} está vacío` }
        ]
      },
      {
        field: 'source',
        menuLabel: 'Fuente',
        operators: textOperators('la fuente', 'ej. meta_ads, google')
      },
      {
        field: 'attribution_source',
        menuLabel: 'Fuente de sesión',
        operators: textOperators('la fuente de sesión', 'ej. facebook, google')
      },
      {
        field: 'attribution_medium',
        menuLabel: 'Medio',
        operators: textOperators('el medio', 'ej. cpc, organic')
      },
      {
        field: 'attribution_ad',
        menuLabel: 'Anuncio atribuido',
        operators: textOperators('el anuncio atribuido', 'Nombre o ID del anuncio')
      },
      {
        field: 'visitor_id',
        menuLabel: 'Visitor ID',
        operators: textOperators('el visitor ID', 'ID del visitante')
      },
      {
        field: 'ghl_contact_id',
        menuLabel: 'ID de HighLevel',
        operators: textOperators('el ID de HighLevel', 'ID de contacto')
      },
      {
        field: 'preferred_phone',
        menuLabel: 'Número WhatsApp preferido',
        operators: [
          { id: 'is', label: 'es', valueKind: 'businessPhone', phrase: (p, h) => `usa ${h.phoneLabel(p.value)} como número preferido` },
          { id: 'is_not', label: 'no es', valueKind: 'businessPhone', phrase: (p, h) => `no usa ${h.phoneLabel(p.value)} como número preferido` },
          { id: 'not_empty', label: 'no está vacío', valueKind: 'none', phrase: () => 'tiene número WhatsApp preferido' },
          { id: 'empty', label: 'está vacío', valueKind: 'none', phrase: () => 'no tiene número WhatsApp preferido' }
        ]
      },
      {
        field: 'customer',
        menuLabel: 'Es cliente',
        operators: [
          { id: 'is_customer', label: 'ya es cliente (hizo una compra)', valueKind: 'none', phrase: () => 'es cliente' },
          { id: 'not_customer', label: 'todavía no es cliente', valueKind: 'none', phrase: () => 'no es cliente aún' }
        ]
      },
      {
        field: 'created',
        menuLabel: 'Fecha de creación',
        operators: dateOperators('se creó')
      },
      {
        field: 'updated',
        menuLabel: 'Fecha de actualización',
        operators: dateOperators('se actualizó')
      },
      {
        field: 'last_purchase',
        menuLabel: 'Última compra',
        operators: dateOperators('compró')
      },
      {
        field: 'assigned',
        menuLabel: 'Quién lo atiende',
        operators: [
          { id: 'to', label: 'lo atiende', valueKind: 'text', placeholder: 'Nombre del usuario', phrase: (p) => `lo atiende ${p.value || '…'}` },
          { id: 'not_to', label: 'no lo atiende', valueKind: 'text', placeholder: 'Nombre del usuario', phrase: (p) => `no lo atiende ${p.value || '…'}` },
          { id: 'any', label: 'tiene a alguien asignado', valueKind: 'none', phrase: () => 'tiene asignado' },
          { id: 'none', label: 'no tiene a nadie asignado', valueKind: 'none', phrase: () => 'sin asignar' }
        ]
      }
    ]
  },
  {
    id: 'appointments',
    label: 'Calendarios y citas',
    baseLabel: 'tiene una cita agendada',
    params: [
      {
        field: 'presence',
        menuLabel: 'Tiene o no tiene cita',
        operators: [
          { id: 'has', label: 'sí tiene cita', valueKind: 'none', phrase: () => 'tiene una cita' },
          { id: 'none', label: 'no tiene ninguna cita', valueKind: 'none', phrase: () => 'no tiene ninguna cita' }
        ]
      },
      {
        field: 'calendar',
        menuLabel: 'Calendario específico',
        operators: [
          { id: 'is', label: 'la cita está en', valueKind: 'calendar', phrase: (p, h) => `cita en "${h.calendarName(p.value)}"` },
          { id: 'is_not', label: 'la cita no está en', valueKind: 'calendar', phrase: (p, h) => `cita fuera de "${h.calendarName(p.value)}"` }
        ]
      },
      {
        field: 'status',
        menuLabel: 'Estado de la cita',
        operators: [
          { id: 'confirmed', label: 'confirmada', valueKind: 'none', phrase: () => 'cita confirmada' },
          { id: 'pending', label: 'pendiente de confirmar', valueKind: 'none', phrase: () => 'cita pendiente' },
          { id: 'cancelled', label: 'cancelada', valueKind: 'none', phrase: () => 'cita cancelada' },
          { id: 'showed', label: 'asistió a la cita', valueKind: 'none', phrase: () => 'asistió' },
          { id: 'noshow', label: 'no asistió a la cita', valueKind: 'none', phrase: () => 'no asistió' }
        ]
      },
      {
        field: 'timing',
        menuLabel: 'Cuándo es la cita',
        operators: [
          { id: 'upcoming', label: 'es en el futuro', valueKind: 'none', phrase: () => 'cita futura' },
          { id: 'past_due', label: 'ya pasó', valueKind: 'none', phrase: () => 'cita pasada' },
          { id: 'today', label: 'es hoy', valueKind: 'none', phrase: () => 'cita hoy' }
        ]
      },
      {
        field: 'date',
        menuLabel: 'Fecha de la cita',
        operators: [
          { id: 'is', label: 'es exactamente el', valueKind: 'date', phrase: (p) => `cita el ${p.date || '…'}` },
          { id: 'not', label: 'no es el', valueKind: 'date', phrase: (p) => `cita no el ${p.date || '…'}` },
          { id: 'before', label: 'es antes del', valueKind: 'date', phrase: (p) => `cita antes del ${p.date || '…'}` },
          { id: 'after', label: 'es después del', valueKind: 'date', phrase: (p) => `cita después del ${p.date || '…'}` },
          { id: 'between', label: 'está entre', valueKind: 'dateRange', phrase: (p) => `cita entre ${p.date || '…'} y ${p.dateEnd || '…'}` }
        ]
      },
      {
        field: 'window',
        menuLabel: 'Tiempo antes o después de la cita',
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
    baseLabel: 'tiene un pago registrado',
    params: [
      {
        field: 'presence',
        menuLabel: 'Tiene o no tiene pago',
        operators: [
          { id: 'has', label: 'sí tiene pago', valueKind: 'none', phrase: () => 'tiene un pago' },
          { id: 'none', label: 'no tiene ningún pago', valueKind: 'none', phrase: () => 'no tiene ningún pago' }
        ]
      },
      {
        field: 'status',
        menuLabel: 'Estado del pago',
        operators: [
          { id: 'received', label: 'pago recibido', valueKind: 'none', phrase: () => 'pago recibido' },
          { id: 'pending', label: 'pago pendiente', valueKind: 'none', phrase: () => 'pago pendiente' },
          { id: 'failed', label: 'pago fallido', valueKind: 'none', phrase: () => 'pago fallido' },
          { id: 'refunded', label: 'pago devuelto', valueKind: 'none', phrase: () => 'pago devuelto' }
        ]
      },
      {
        field: 'product',
        menuLabel: 'Producto comprado',
        operators: [
          { id: 'is', label: 'es igual a', valueKind: 'text', placeholder: 'Nombre del producto', phrase: (p) => `producto es igual a "${p.value || '…'}"` },
          { id: 'is_not', label: 'no es igual a', valueKind: 'text', placeholder: 'Nombre del producto', phrase: (p) => `producto no es igual a "${p.value || '…'}"` },
          { id: 'contains', label: 'contiene', valueKind: 'text', placeholder: 'Parte del nombre', phrase: (p) => `producto contiene "${p.value || '…'}"` },
          { id: 'not_contains', label: 'no contiene', valueKind: 'text', placeholder: 'Parte del nombre', phrase: (p) => `producto no contiene "${p.value || '…'}"` }
        ]
      },
      {
        field: 'amount',
        menuLabel: 'Monto del pago',
        operators: [
          { id: 'eq', label: 'es igual a', valueKind: 'amount', phrase: (p) => `monto de ${money(p.amount)}` },
          { id: 'gt', label: 'es mayor que', valueKind: 'amount', phrase: (p) => `monto mayor que ${money(p.amount)}` },
          { id: 'lt', label: 'es menor que', valueKind: 'amount', phrase: (p) => `monto menor que ${money(p.amount)}` },
          { id: 'between', label: 'está entre', valueKind: 'amountRange', phrase: (p) => `monto entre ${money(p.amount)} y ${money(p.amountMax)}` }
        ]
      }
    ]
  },
  {
    id: 'ads',
    label: 'Anuncios',
    baseLabel: 'llegó desde un anuncio de Meta',
    params: [
      {
        field: 'presence',
        menuLabel: 'Viene o no de un anuncio',
        operators: [
          { id: 'from_ad', label: 'sí llegó de un anuncio', valueKind: 'none', phrase: () => 'llegó de un anuncio' },
          { id: 'not_from_ad', label: 'no llegó de ningún anuncio', valueKind: 'none', phrase: () => 'no llegó de ningún anuncio' }
        ]
      },
      {
        field: 'ad',
        menuLabel: 'Anuncio específico',
        operators: [
          { id: 'is', label: 'el anuncio es igual a', valueKind: 'ad', phrase: (p, h) => `el anuncio es igual a "${h.adName(p.value)}"` },
          { id: 'is_not', label: 'el anuncio no es igual a', valueKind: 'ad', phrase: (p, h) => `el anuncio no es igual a "${h.adName(p.value)}"` }
        ]
      }
    ]
  },
  {
    id: 'schedule',
    label: 'Horario',
    baseLabel: 'a cualquier hora',
    defaultParams: [{ field: 'time', operator: 'between', timeStart: '09:00', timeEnd: '18:00' }],
    params: [
      {
        field: 'time',
        menuLabel: 'Rango de horas',
        operators: [
          { id: 'between', label: 'la hora está entre', valueKind: 'timeRange', phrase: (p) => `entre las ${p.timeStart || '…'} y las ${p.timeEnd || '…'}` },
          { id: 'outside', label: 'la hora está fuera de', valueKind: 'timeRange', phrase: (p) => `fuera de las ${p.timeStart || '…'} a las ${p.timeEnd || '…'}` }
        ]
      },
      {
        field: 'day',
        menuLabel: 'Día de la semana',
        operators: [
          { id: 'is', label: 'el día es', valueKind: 'weekdays', phrase: (p) => `los días: ${(p.values || []).map((d) => WEEKDAY_OPTIONS.find((w) => w.value === d)?.label || d).join(', ') || '…'}` }
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

function getConditionFieldOptions(category: CategoryDef) {
  return category.params.map((param) => ({
    id: param.field,
    label: param.menuLabel
  }))
}

function defaultParamFor(categoryId: ConditionCategory, field: string, operatorId?: string): AgentConditionParam {
  const operator = operatorId ? getOperatorDef(categoryId, field, operatorId) : getParamDef(categoryId, field).operators[0]
  const param: AgentConditionParam = { field, operator: operator.id }
  if (operator.valueKind === 'channel') param.value = 'whatsapp'
  if (operator.valueKind === 'list' || operator.valueKind === 'tagList' || operator.valueKind === 'weekdays') param.values = []
  if (operator.valueKind === 'offset') {
    const isContactDateField = field === 'created' || field === 'updated' || field === 'last_purchase'
    param.offsetValue = isContactDateField ? 7 : 30
    param.offsetUnit = isContactDateField ? 'days' : 'minutes'
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
    params: category.defaultParams
      ? category.defaultParams.map((param) => ({ ...param }))
      : category.params[0]
        ? [defaultParamFor(categoryId, category.params[0].field)]
        : []
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
      const tag = (contactTagsService.getCachedTags({ includeSystem: true }) || contactTagsService.getCachedTags() || [])
        .find((item) => item.id === id)
      return tag?.name || id || '…'
    },
    customFieldLabel: (key) => options?.customFields?.find((item) => item.key === key)?.label || key || 'el campo'
  }

  const params = condition.params || []

  const presence = params.find((param) => param.field === 'presence')
  let base = category.baseLabel
  if (presence) {
    base = getOperatorDef(condition.category, 'presence', presence.operator).phrase?.(presence, helpers) || base
  }

  const otherPhrases = params
    .filter((param) => param.field !== 'presence')
    .map((param) => {
      const operator = getOperatorDef(condition.category, param.field, param.operator)
      return operator.phrase ? operator.phrase(param, helpers) : operator.label
    })

  // Si hay parámetros específicos y no hay presence, los parámetros YA describen
  // la condición completa — la frase base sería redundante.
  if (otherPhrases.length > 0 && !presence) {
    return `${category.label}: ${otherPhrases.join(' · ')}`
  }

  return [`${category.label}: ${base}`, ...otherPhrases].join(' · ')
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
        return null
      case 'customFieldValue':
        return (
          <input
            className={styles.ruleInput}
            value={param.value || ''}
            placeholder="Valor"
            onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { value: event.target.value })}
          />
        )
      default:
        return null
    }
  }

  const renderParamSubfield = (param: AgentConditionParam, groupIndex: number, conditionIndex: number, paramIndex: number) => {
    if (param.field !== 'custom_field') return null
    return (
      <select
        className={`${styles.ruleSelect} ${styles.conditionSubfieldSelect}`}
        aria-label="Campo personalizado"
        value={param.fieldKey || ''}
        onChange={(event) => updateParam(groupIndex, conditionIndex, paramIndex, { fieldKey: event.target.value })}
      >
        <option value="">Elige campo</option>
        {(options?.customFields || []).map((field) => (
          <option key={field.key} value={field.key}>{field.label}</option>
        ))}
      </select>
    )
  }

  const renderEditingCondition = (condition: AgentCondition, groupIndex: number, conditionIndex: number, key: string) => {
    const category = getCategory(condition.category)
    const usedPresence = condition.params.some((param) => param.field === 'presence')
    const fieldOptions = getConditionFieldOptions(category)
    const showFieldSelect = category.params.length > 1
    const canAddCriterion = category.params.length > 1 || condition.params.length === 0
    const criterionMenuItems = canAddCriterion
      ? fieldOptions
        .filter((item) => item.id !== 'presence' || !usedPresence)
        .map((item) => ({ id: item.id, label: item.label }))
      : []
    const conditionTypeSelect = (
      <select
        className={`${styles.ruleSelect} ${styles.conditionTypeSelect}`}
        aria-label="Tipo de condición"
        value={condition.category}
        onChange={(event) => updateCondition(groupIndex, conditionIndex, defaultCondition(event.target.value as ConditionCategory))}
      >
        {CONDITION_CATEGORIES.map((item) => (
          <option key={item.id} value={item.id}>{item.label}</option>
        ))}
      </select>
    )
    const doneButton = (
      <button type="button" className={styles.ruleDelete} onClick={() => setEditing(key, false)} aria-label="Listo">
        <Check size={14} />
      </button>
    )

    return (
      <div className={styles.conditionEditPanel}>
        {condition.params.length === 0 && (
          <div className={`${styles.conditionParamRow} ${styles.conditionParamRowPrimary}`}>
            <span className={styles.conditionPrefix}>{conditionIndex === 0 ? 'Si' : 'Y'}</span>
            {conditionTypeSelect}
            <span className={styles.conditionBaseHint}>{category.baseLabel}</span>
            <span className={styles.conditionInlineActions}>
              {doneButton}
            </span>
          </div>
        )}

        {condition.params.map((param, paramIndex) => {
          const currentOperator = getOperatorDef(condition.category, param.field, param.operator)
          const paramDef = getParamDef(condition.category, param.field)
          const availableFieldOptions = fieldOptions.filter((item) => (
            item.id !== 'presence' || param.field === 'presence' || !usedPresence
          ))
          return (
            <div
              key={paramIndex}
              className={`${styles.conditionParamRow} ${paramIndex === 0 ? styles.conditionParamRowPrimary : ''}`}
            >
              {paramIndex === 0 ? (
                <>
                  <span className={styles.conditionPrefix}>{conditionIndex === 0 ? 'Si' : 'Y'}</span>
                  {conditionTypeSelect}
                </>
              ) : (
                <span className={styles.conditionParamJoin}>y</span>
              )}
              {showFieldSelect && (
                <select
                  className={`${styles.ruleSelect} ${styles.conditionFieldSelect}`}
                  aria-label="Campo"
                  value={param.field}
                  onChange={(event) => {
                    replaceParam(groupIndex, conditionIndex, paramIndex, defaultParamFor(condition.category, event.target.value))
                  }}
                >
                  {availableFieldOptions.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              )}
              {renderParamSubfield(param, groupIndex, conditionIndex, paramIndex)}
              <select
                className={`${styles.ruleSelect} ${styles.conditionOperatorSelect}`}
                aria-label="Operador"
                value={currentOperator.id}
                onChange={(event) => {
                  const nextOperator = getOperatorDef(condition.category, param.field, event.target.value)
                  if (nextOperator.valueKind === currentOperator.valueKind || param.field === 'custom_field') {
                    replaceParam(groupIndex, conditionIndex, paramIndex, { ...param, operator: nextOperator.id })
                  } else {
                    const fresh = defaultParamFor(condition.category, param.field, nextOperator.id)
                    replaceParam(groupIndex, conditionIndex, paramIndex, {
                      ...fresh,
                      fieldKey: param.fieldKey,
                      value: param.value
                    })
                  }
                }}
              >
                {paramDef.operators.map((operator) => (
                  <option key={operator.id} value={operator.id}>{operator.label}</option>
                ))}
              </select>
              {renderParamValue(condition, param, groupIndex, conditionIndex, paramIndex)}
              <span className={styles.conditionInlineActions}>
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
                {paramIndex === 0 && doneButton}
              </span>
            </div>
          )
        })}

        {criterionMenuItems.length > 0 && (
          <DropdownMenu
            label="Añadir criterio"
            small
            items={criterionMenuItems}
            onSelect={(id) => {
              updateCondition(groupIndex, conditionIndex, {
                ...condition,
                params: [...condition.params, defaultParamFor(condition.category, id)]
              })
            }}
          />
        )}
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
                  {editing ? (
                    renderEditingCondition(condition, groupIndex, conditionIndex, key)
                  ) : (
                    <>
                      <span className={styles.conditionSentence}>
                        <span className={styles.conditionPrefix}>{conditionIndex === 0 ? 'Si ' : 'Y '}</span>
                        {conditionSummary(condition, calendars, options)}
                      </span>
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
