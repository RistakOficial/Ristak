import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'
import { listLocalProducts } from '../../services/localProductService.js'
import {
  createSinglePaymentLink,
  createInstallmentPaymentFlow,
  updateScheduledInstallmentPayment,
  cancelScheduledInstallmentPayment
} from '../../services/paymentFlowService.js'

/**
 * Herramientas avanzadas de cobro (links de pago, parcialidades) portadas del
 * agente original. Usan paymentFlowService directamente: requieren HighLevel
 * conectado para emitir invoices; si no lo está, devuelven el error tal cual
 * para que el agente lo explique.
 */

async function getPaymentContact(contactId) {
  const row = await db.get('SELECT id, full_name, email, phone FROM contacts WHERE id = ?', [contactId])
  if (!row) return null
  return { id: row.id, name: row.full_name, email: row.email, phone: row.phone }
}

function buildChannels(channel) {
  const normalized = String(channel || '').toLowerCase()
  return {
    email: normalized === 'email' || normalized === 'all',
    whatsapp: normalized === 'whatsapp' || normalized === 'all',
    sms: normalized === 'sms' || normalized === 'all'
  }
}

const CHANNEL_PARAM = z.enum(['email', 'whatsapp', 'sms', 'all'])
  .describe('Canal por el que se envía el link. SIEMPRE pregunta al usuario por cuál canal enviarlo antes de llamar la herramienta.')

export const listProductsTool = tool({
  name: 'list_products',
  description: 'Lista los productos del catálogo con sus precios (id, monto, moneda). Úsala para cobrar el precio correcto de un producto.',
  parameters: z.object({
    query: z.string().nullable().describe('Texto para filtrar por nombre o descripción'),
    limit: z.number().int().min(1).max(50).nullable().describe('Máximo de productos (default 20)')
  }),
  execute: async ({ query, limit }) => {
    const result = await listLocalProducts({ query: query || '', limit: limit || 20, includePrices: true })
    const products = (result?.products || result || []).map?.((product) => ({
      id: product.id,
      name: product.name,
      description: product.description || null,
      prices: (product.prices || []).map((price) => ({
        id: price.id,
        amount: Number(price.amount),
        currency: price.currency,
        name: price.name || null
      }))
    })) || []
    return { ok: true, total: products.length, products }
  }
})

export const createPaymentLinkTool = tool({
  name: 'create_payment_link',
  description: 'Crea y envía un link de pago único (invoice de HighLevel) a un contacto. Antes de llamarla: 1) identifica el contacto real, 2) confirma con el usuario monto, concepto y canal de envío, 3) pasa confirm=true solo cuando el usuario ya aprobó el cobro.',
  parameters: z.object({
    contactId: z.string().describe('ID del contacto a cobrar (usa search_contacts)'),
    amount: z.number().positive().describe('Monto del cobro'),
    currency: z.string().nullable().describe('Moneda ISO (default: moneda de la cuenta)'),
    concept: z.string().describe('Concepto del cobro, ej. "Mensualidad junio"'),
    dueDate: z.string().nullable().describe('Fecha límite de pago YYYY-MM-DD (opcional)'),
    channel: CHANNEL_PARAM,
    confirm: z.boolean().describe('true solo si el usuario ya confirmó explícitamente el cobro')
  }),
  execute: async ({ contactId, amount, currency, concept, dueDate, channel, confirm }) => {
    if (!confirm) {
      return { ok: false, error: 'Falta confirmación del usuario. Resume el cobro (contacto, monto, concepto, canal) y pide aprobación antes de crear el link.' }
    }
    const contact = await getPaymentContact(contactId)
    if (!contact) return { ok: false, error: 'Contacto no encontrado' }

    try {
      const result = await createSinglePaymentLink({
        contact,
        amount,
        currency: currency || undefined,
        description: concept,
        concept,
        title: concept,
        dueDate: dueDate || undefined,
        channels: buildChannels(channel),
        source: 'ai_agent'
      })
      return {
        ok: true,
        invoiceId: result.invoiceId,
        paymentLink: result.paymentLink,
        sendMethod: result.sendMethod,
        amount: result.amount,
        currency: result.currency,
        status: result.status
      }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
})

export const createInstallmentPlanTool = tool({
  name: 'create_installment_plan',
  description: 'Crea un plan de pagos por parcialidades para un contacto: primer pago opcional + pagos restantes con fechas. La suma del primer pago y los restantes debe ser igual al total. Confirma con el usuario el plan completo (montos, fechas, canal) y pasa confirm=true solo cuando ya aprobó.',
  parameters: z.object({
    contactId: z.string().describe('ID del contacto'),
    totalAmount: z.number().positive().describe('Total a cobrar (debe coincidir con la suma de los pagos)'),
    currency: z.string().nullable().describe('Moneda ISO (default: moneda de la cuenta)'),
    concept: z.string().describe('Concepto del plan, ej. "Programa de 3 meses"'),
    firstPayment: z.object({
      amount: z.number().positive().describe('Monto del primer pago'),
      date: z.string().nullable().describe('Fecha del primer pago YYYY-MM-DD (default hoy)'),
      method: z.enum(['cash', 'transfer', 'deposit', 'card', 'other']).describe('Método del primer pago')
    }).nullable().describe('Primer pago inmediato; null si el plan no tiene primer pago'),
    remainingPayments: z.array(z.object({
      amount: z.number().positive().describe('Monto de la parcialidad'),
      dueDate: z.string().describe('Fecha de cobro YYYY-MM-DD')
    })).min(1).describe('Pagos restantes programados'),
    remainingAutomatic: z.boolean().describe('true para cobrar automáticamente con tarjeta domiciliada; false para enviar invoices a pagar manualmente'),
    channel: CHANNEL_PARAM,
    confirm: z.boolean().describe('true solo si el usuario ya confirmó explícitamente el plan')
  }),
  execute: async ({ contactId, totalAmount, currency, concept, firstPayment, remainingPayments, remainingAutomatic, channel, confirm }) => {
    if (!confirm) {
      return { ok: false, error: 'Falta confirmación del usuario. Resume el plan (total, primer pago, parcialidades con fechas, canal) y pide aprobación.' }
    }
    const contact = await getPaymentContact(contactId)
    if (!contact) return { ok: false, error: 'Contacto no encontrado' }

    try {
      const result = await createInstallmentPaymentFlow({
        contact,
        totalAmount,
        currency: currency || undefined,
        description: concept,
        concept,
        firstPayment: firstPayment
          ? { enabled: true, amount: firstPayment.amount, date: firstPayment.date || undefined, method: firstPayment.method }
          : { enabled: false },
        remainingPayments: remainingPayments.map((payment) => ({ amount: payment.amount, dueDate: payment.dueDate })),
        remainingAutomatic,
        channels: buildChannels(channel),
        source: 'ai_agent'
      })
      return { ok: true, flowId: result?.flowId || result?.id || null, summary: result?.summary || null, result }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
})

export const listScheduledPaymentsTool = tool({
  name: 'list_scheduled_payments',
  description: 'Lista los cobros programados (parcialidades) con su ID, contacto, monto, fecha y estatus. Úsala antes de reprogramar o cancelar un cobro.',
  parameters: z.object({
    contactId: z.string().nullable().describe('Filtrar por contacto'),
    status: z.string().nullable().describe('Filtrar por estatus, ej. scheduled | pending | paid | cancelled'),
    limit: z.number().int().min(1).max(50).nullable().describe('Máximo de cobros (default 20)')
  }),
  execute: async ({ contactId, status, limit }) => {
    const params = []
    let sql = `
      SELECT i.id, i.flow_id, i.sequence, i.amount, i.due_date, i.status, i.payment_method,
             f.contact_id, f.contact_name, f.currency, f.concept
      FROM installment_payments i
      JOIN payment_flows f ON f.id = i.flow_id
      WHERE 1 = 1`
    if (contactId) {
      sql += ' AND f.contact_id = ?'
      params.push(contactId)
    }
    if (status) {
      sql += ' AND i.status = ?'
      params.push(String(status).toLowerCase())
    }
    sql += ' ORDER BY i.due_date ASC LIMIT ?'
    params.push(limit || 20)

    const rows = await db.all(sql, params)
    return {
      ok: true,
      total: rows.length,
      scheduledPayments: rows.map((row) => ({
        installmentId: row.id,
        flowId: row.flow_id,
        sequence: row.sequence,
        amount: Number(row.amount),
        currency: row.currency,
        dueDate: row.due_date,
        status: row.status,
        contactId: row.contact_id,
        contactName: row.contact_name,
        concept: row.concept
      }))
    }
  }
})

export const rescheduleScheduledPaymentTool = tool({
  name: 'reschedule_scheduled_payment',
  description: 'Modifica un cobro programado: nueva fecha y/o nuevo monto. Usa list_scheduled_payments para obtener el installmentId. Confirma el cambio con el usuario y pasa confirm=true solo cuando ya aprobó.',
  parameters: z.object({
    installmentId: z.string().describe('ID del cobro programado'),
    newDueDate: z.string().nullable().describe('Nueva fecha de cobro YYYY-MM-DD'),
    newAmount: z.number().positive().nullable().describe('Nuevo monto del cobro'),
    confirm: z.boolean().describe('true solo si el usuario ya confirmó explícitamente')
  }),
  execute: async ({ installmentId, newDueDate, newAmount, confirm }) => {
    if (!confirm) {
      return { ok: false, error: 'Falta confirmación del usuario antes de modificar el cobro programado.' }
    }
    if (!newDueDate && !newAmount) {
      return { ok: false, error: 'Indica qué cambiar: nueva fecha (newDueDate) y/o nuevo monto (newAmount).' }
    }
    try {
      const result = await updateScheduledInstallmentPayment({
        installmentId,
        ...(newDueDate ? { newDueDate } : {}),
        ...(newAmount ? { amount: newAmount } : {})
      })
      return { ok: true, result }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
})

export const cancelScheduledPaymentTool = tool({
  name: 'cancel_scheduled_payment',
  description: 'Cancela un cobro programado (parcialidad). ACCIÓN DESTRUCTIVA: pide confirmación explícita al usuario y pasa confirm=true solo cuando ya confirmó.',
  parameters: z.object({
    installmentId: z.string().describe('ID del cobro programado a cancelar'),
    confirm: z.boolean().describe('true solo si el usuario ya confirmó explícitamente')
  }),
  execute: async ({ installmentId, confirm }) => {
    if (!confirm) {
      return { ok: false, error: 'Falta confirmación del usuario antes de cancelar el cobro programado.' }
    }
    try {
      const result = await cancelScheduledInstallmentPayment({ installmentId })
      return { ok: true, result }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
})

export const paymentFlowTools = [
  listProductsTool,
  createPaymentLinkTool,
  createInstallmentPlanTool,
  listScheduledPaymentsTool,
  rescheduleScheduledPaymentTool,
  cancelScheduledPaymentTool
]
