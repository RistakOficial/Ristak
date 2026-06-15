import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'
import { createTransaction, updateTransaction, deleteTransaction } from '../../controllers/transactionsController.js'
import { invokeController, toToolResult } from '../invokeController.js'

const PAYMENT_FIELDS = (row) => ({
  id: row.id,
  contactId: row.contact_id,
  contactName: row.contact_name || null,
  amount: Number(row.amount),
  currency: row.currency,
  status: row.status,
  method: row.payment_method,
  title: row.title,
  date: row.date,
  reference: row.reference
})

// En la tabla payments conviven estatus locales y de HighLevel/Stripe:
// "pagado" puede venir como paid, succeeded o completed.
const PAID_STATUSES = ['paid', 'succeeded', 'completed']

/**
 * payments.date se guarda como texto "YYYY-MM-DD HH:MM:SS" (con espacio) en
 * SQLite. Un parámetro ISO con "T" rompe la comparación de strings (el espacio
 * ordena antes que la T), así que normalizamos al formato con espacio, que
 * también castea bien a timestamp en Postgres.
 */
function normalizePaymentDateParam(value, { endOfDay = false } = {}) {
  const raw = String(value || '').trim()
    .replace('T', ' ')
    .replace(/Z$/, '')
    .replace(/[+-]\d{2}:?\d{2}$/, '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return endOfDay ? `${raw} 23:59:59` : `${raw} 00:00:00`
  }
  return raw
}

export const listPaymentsTool = tool({
  name: 'list_payments',
  description: 'Lista pagos/transacciones con filtros por contacto, estatus o rango de fechas. El filtro "paid" agrupa todos los estatus de pago exitoso (paid, succeeded, completed). Devuelve totalPaid (suma de pagos exitosos) y totalPending por separado.',
  parameters: z.object({
    contactId: z.string().nullable().describe('Filtrar por contacto'),
    status: z.string().nullable().describe('Filtrar por estatus: paid (incluye succeeded/completed) | pending | failed | refunded'),
    startDate: z.string().nullable().describe('Fecha mínima ISO 8601'),
    endDate: z.string().nullable().describe('Fecha máxima ISO 8601'),
    limit: z.number().int().min(1).max(100).nullable().describe('Máximo de pagos (default 30)')
  }),
  execute: async ({ contactId, status, startDate, endDate, limit }) => {
    const params = []
    let sql = `
      SELECT p.id, p.contact_id, p.amount, p.currency, p.status, p.payment_method,
             p.title, p.date, p.reference, c.full_name AS contact_name
      FROM payments p
      LEFT JOIN contacts c ON c.id = p.contact_id
      WHERE 1 = 1`
    if (contactId) {
      sql += ' AND p.contact_id = ?'
      params.push(contactId)
    }
    const normalizedStatus = status ? String(status).toLowerCase() : null
    if (normalizedStatus === 'paid') {
      sql += ` AND p.status IN (${PAID_STATUSES.map(() => '?').join(', ')})`
      params.push(...PAID_STATUSES)
    } else if (normalizedStatus) {
      sql += ' AND p.status = ?'
      params.push(normalizedStatus)
    }
    if (startDate) {
      sql += ' AND p.date >= ?'
      params.push(normalizePaymentDateParam(startDate))
    }
    if (endDate) {
      sql += ' AND p.date <= ?'
      params.push(normalizePaymentDateParam(endDate, { endOfDay: true }))
    }
    sql += ' ORDER BY p.date DESC LIMIT ?'
    params.push(limit || 30)

    const rows = await db.all(sql, params)
    const totalAmount = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
    const totalPaid = rows
      .filter((row) => PAID_STATUSES.includes(String(row.status || '').toLowerCase()))
      .reduce((sum, row) => sum + Number(row.amount || 0), 0)
    const totalPending = rows
      .filter((row) => String(row.status || '').toLowerCase() === 'pending')
      .reduce((sum, row) => sum + Number(row.amount || 0), 0)
    return { ok: true, total: rows.length, totalAmount, totalPaid, totalPending, payments: rows.map(PAYMENT_FIELDS) }
  }
})

export const recordPaymentTool = tool({
  name: 'record_payment',
  description: 'Registra un pago manual (efectivo, transferencia, tarjeta, etc.). Asócialo a un contacto existente con contactId (usa search_contacts); si no existe, puedes pasar contactName/email/phone y se crea el contacto automáticamente.',
  parameters: z.object({
    contactId: z.string().nullable().describe('ID del contacto (preferido)'),
    contactName: z.string().nullable().describe('Nombre del contacto si no tienes contactId'),
    email: z.string().nullable().describe('Correo del contacto si no tienes contactId'),
    phone: z.string().nullable().describe('Teléfono del contacto si no tienes contactId'),
    amount: z.number().positive().describe('Monto del pago (mayor a 0)'),
    currency: z.string().nullable().describe('Moneda ISO, ej. MXN o USD (default: moneda de la cuenta)'),
    method: z.string().nullable().describe('Método: cash | transfer | card | other (default cash)'),
    status: z.string().nullable().describe('Estatus: paid | pending (default paid)'),
    title: z.string().nullable().describe('Concepto del pago'),
    description: z.string().nullable().describe('Descripción adicional'),
    date: z.string().nullable().describe('Fecha del pago ISO 8601 (default ahora)')
  }),
  execute: async ({ contactId, contactName, email, phone, amount, currency, method, status, title, description, date }) => {
    const result = await invokeController(createTransaction, {
      body: {
        contactId: contactId || undefined,
        contactName: contactName || undefined,
        email: email || undefined,
        phone: phone || undefined,
        amount,
        currency: currency || undefined,
        paymentMethod: method || undefined,
        status: status || undefined,
        title: title || undefined,
        description: description || undefined,
        date: date || undefined
      }
    })
    return toToolResult(result, (data) => ({
      id: data?.id,
      contactId: data?.contactId || data?.contact_id,
      amount: data?.amount,
      currency: data?.currency,
      status: data?.status,
      date: data?.date
    }))
  }
})

export const updatePaymentTool = tool({
  name: 'update_payment',
  description: 'Edita un pago existente: monto, estatus, método, concepto o fecha. Solo envía los campos que cambian.',
  parameters: z.object({
    paymentId: z.string().describe('ID del pago (usa list_payments para obtenerlo)'),
    amount: z.number().positive().nullable().describe('Nuevo monto'),
    status: z.string().nullable().describe('Nuevo estatus: paid | pending | failed | refunded'),
    method: z.string().nullable().describe('Nuevo método de pago'),
    title: z.string().nullable().describe('Nuevo concepto'),
    description: z.string().nullable().describe('Nueva descripción'),
    date: z.string().nullable().describe('Nueva fecha ISO 8601')
  }),
  execute: async ({ paymentId, amount, status, method, title, description, date }) => {
    const body = {}
    if (amount !== null && amount !== undefined) body.amount = amount
    if (status !== null && status !== undefined) body.status = status
    if (method !== null && method !== undefined) body.paymentMethod = method
    if (title !== null && title !== undefined) body.title = title
    if (description !== null && description !== undefined) body.description = description
    if (date !== null && date !== undefined) body.date = date

    if (!Object.keys(body).length) {
      return { ok: false, error: 'No enviaste ningún campo a actualizar' }
    }

    const result = await invokeController(updateTransaction, { params: { id: paymentId }, body })
    return toToolResult(result, (data) => ({
      id: data?.id,
      amount: data?.amount,
      status: data?.status,
      date: data?.date
    }))
  }
})

export const deletePaymentTool = tool({
  name: 'delete_payment',
  description: 'Elimina un pago registrado. ACCIÓN DESTRUCTIVA: pide confirmación explícita al usuario antes y pasa confirm=true solo cuando ya confirmó.',
  parameters: z.object({
    paymentId: z.string().describe('ID del pago a eliminar'),
    confirm: z.boolean().describe('true solo si el usuario ya confirmó explícitamente')
  }),
  execute: async ({ paymentId, confirm }) => {
    if (!confirm) {
      return { ok: false, error: 'Falta confirmación del usuario. Pregunta antes de borrar el pago.' }
    }
    const result = await invokeController(deleteTransaction, { params: { id: paymentId } })
    return toToolResult(result)
  }
})

export const paymentReadTools = [listPaymentsTool]
export const paymentWriteTools = [recordPaymentTool, updatePaymentTool, deletePaymentTool]
export const paymentTools = [...paymentReadTools, ...paymentWriteTools]
