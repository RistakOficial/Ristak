import { db } from '../config/database.js'
import { getAccountTimezone, normalizeDateOnlyInTimezone, businessTodayDateOnly } from '../utils/dateUtils.js'
import { getPaymentSettings } from './paymentSettingsService.js'

const LOCAL_PROVIDERS = new Set(['offline', 'stripe', 'conekta', 'rebill', 'mercadopago'])
const CLOSED = new Set(['paid', 'registered', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'refunded', 'void', 'deleted', 'cancelled', 'canceled'])
const BUSY = new Set(['processing', 'requires_action', 'authorized', 'card_authorized'])
const clean = value => String(value || '').trim()
const status = value => clean(value).toLowerCase()
const json = value => { try { return JSON.parse(value || '{}') || {} } catch { return {} } }
const fail = (message, code = 409) => { throw Object.assign(new Error(message), { status: code }) }

async function resolveSavedCard(provider, contactId, methodId, currency) {
  let config, sources
  if (provider === 'stripe') {
    const service = await import('./stripePaymentService.js')
    config = await service.getStripePaymentConfig()
    sources = await service.getStripeSavedPaymentMethods(contactId)
  } else if (provider === 'conekta') {
    if (currency !== 'MXN') fail('Conekta sólo permite domiciliar este plan en MXN.', 400)
    const service = await import('./conektaPaymentService.js')
    config = await service.getConektaPaymentConfig()
    sources = await service.getConektaSavedPaymentSources(contactId)
  } else if (provider === 'rebill') {
    const service = await import('./rebillPaymentService.js')
    service.assertRebillCurrency(currency)
    config = await service.getRebillPaymentConfig()
    sources = await service.listRebillSavedPaymentSources(contactId)
  } else {
    fail('Elige una tarjeta guardada en Stripe, Conekta o Rebill. Mercado Pago y CLIP se usan por enlace dentro de un plan offline.', 400)
  }
  if (!config.configured) fail('Conecta la pasarela en el modo de pagos actual antes de domiciliar el plan.')
  const source = sources.find(item => methodId && [item.id, item.stripePaymentMethodId, item.conektaPaymentSourceId, item.rebillCardId].includes(methodId))
  if (!source) fail('La tarjeta seleccionada no pertenece a este contacto en el modo de pagos actual.', 400)
  return { source, mode: config.mode }
}

async function persistMirror(flowId, provider) {
  const names = {
    offline: ['offlinePaymentPlanService', 'persistOfflinePaymentPlanMirror'],
    stripe: ['stripePaymentService', 'persistStripePaymentPlanMirror'],
    conekta: ['conektaPaymentService', 'persistConektaPaymentPlanMirror'],
    rebill: ['rebillPaymentService', 'persistRebillPaymentPlanMirror']
  }
  const [module, method] = names[provider]
  return (await import(`./${module}.js`))[method](flowId)
}

/** Cambia la decisión de cobro, conservando el plan, sus IDs y todo pago histórico. */
export async function changePaymentPlanCollectionMode(flowId, input = {}, { actorId = '' } = {}) {
  const mode = clean(input.collectionMode)
  if (!['offline', 'automatic'].includes(mode)) fail('Elige offline o domiciliación automática.', 400)
  const allowed = new Set(['collectionMode', 'paymentProvider', 'paymentMethodId', 'reminderDaysBefore', 'reminderTime'])
  if (Object.keys(input).some(key => !allowed.has(key))) {
    fail('Guarda la forma de cobro por separado de los importes, fechas y textos del calendario.', 400)
  }
  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [clean(flowId)])
  if (!flow) fail('Plan de pagos no encontrado.', 404)
  if (!LOCAL_PROVIDERS.has(flow.payment_provider)) fail('Este cambio sólo aplica a planes locales de Ristak.', 400)
  if (['editing', 'creating', 'creation_failed_review'].includes(status(flow.current_state)) || /cancelled|canceled|deleted/.test(status(flow.current_state))) {
    fail('Este plan no puede cambiar de forma de cobro en su estado actual.')
  }
  let metadata = json(flow.metadata)
  const automatic = mode === 'automatic'
  const provider = automatic ? clean(input.paymentProvider || flow.payment_provider) : 'offline'
  const card = automatic ? await resolveSavedCard(provider, flow.contact_id, clean(input.paymentMethodId), flow.currency) : null
  const settings = await getPaymentSettings()
  const timezone = await getAccountTimezone()
  const today = businessTodayDateOnly(timezone)
  const now = new Date().toISOString()
  const paused = /paused/.test(status(flow.current_state))
  const targetState = automatic ? (paused ? 'paused' : 'installment_plan_active') : (paused ? 'offline_plan_paused' : 'offline_plan_active')
  const paymentMode = card?.mode || metadata.paymentMode || settings.paymentMode

  await db.transaction(async tx => {
    // El mismo bloqueo que revisa el cron. Si el cargo ganó primero, no fingimos que se detuvo.
    const claim = await tx.run(
      `UPDATE payment_flows SET current_state = 'editing'
       WHERE id = ? AND payment_provider = ? AND current_state = ?
         AND COALESCE(first_payment_status, '') NOT IN ('processing', 'requires_action', 'authorized', 'card_authorized')
         AND NOT EXISTS (SELECT 1 FROM installment_payments i WHERE i.flow_id = payment_flows.id AND i.status IN ('processing', 'requires_action', 'authorized', 'card_authorized'))`,
      [flow.id, flow.payment_provider, flow.current_state]
    )
    if (Number(claim.changes) !== 1) fail('El plan cambió o hay un cobro en proceso. Actualiza el detalle antes de continuar.')
    Object.assign(flow, await tx.get('SELECT * FROM payment_flows WHERE id = ?', [flow.id]))
    metadata = json(flow.metadata)
    const reminderDaysBefore = input.reminderDaysBefore ?? metadata.reminderDaysBefore ?? 0
    const reminderTime = input.reminderTime ?? metadata.reminderTime ?? '12:00'
    const reminderChannel = metadata.reminderChannel || settings.automations.reminderChannel
    if (!Number.isInteger(reminderDaysBefore) || reminderDaysBefore < 0 || reminderDaysBefore > 365 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) {
      fail('Configura una anticipación de 0 a 365 días y una hora de recordatorio válida.', 400)
    }
    const installments = await tx.all('SELECT * FROM installment_payments WHERE flow_id = ? ORDER BY sequence', [flow.id])
    // Relee después de tomar el bloqueo: un cron pudo ganar mientras esperábamos.
    if (BUSY.has(status(flow.first_payment_status)) || installments.some(row => BUSY.has(status(row.status)))) {
      fail('Hay un cobro en proceso. Resuélvelo antes de cambiar la forma de cobro del plan.')
    }
    const paymentIds = [...installments.map(row => row.payment_id), flow.first_payment_invoice_id, flow.card_setup_invoice_id].filter(Boolean)
    const payments = paymentIds.length ? await tx.all(`SELECT * FROM payments WHERE id IN (${paymentIds.map(() => '?').join(',')})`, paymentIds) : []
    const byId = new Map(payments.map(row => [row.id, row]))
    const editable = installments.filter(row => !CLOSED.has(status(row.status)) && !CLOSED.has(status(byId.get(row.payment_id)?.status)))
    const firstEditable = Number(flow.first_payment_amount) > 0 && !CLOSED.has(status(flow.first_payment_status)) && !CLOSED.has(status(byId.get(flow.first_payment_invoice_id)?.status))
    const pendingPayments = [...editable.map(row => byId.get(row.payment_id)), ...(firstEditable ? [byId.get(flow.first_payment_invoice_id)] : [])]
    const setup = byId.get(flow.card_setup_invoice_id)
    if (setup && !CLOSED.has(status(setup.status))) pendingPayments.push(setup)
    for (const payment of pendingPayments) {
      if (!payment) fail('Falta el registro de un pago pendiente. Revisa el calendario antes de cambiar el cobro.')
      if (BUSY.has(status(payment.status)) || payment.stripe_payment_intent_id || payment.stripe_charge_id || payment.conekta_order_id || payment.conekta_charge_id || payment.mercadopago_payment_id || payment.mercadopago_preference_id || payment.clip_payment_id || payment.rebill_payment_id || payment.rebill_subscription_id || json(payment.metadata_json).rebillHostedPaymentLink?.id) {
        fail('Un pago pendiente ya tiene actividad en la pasarela. Resuélvelo antes de cambiar la forma de cobro del plan.')
      }
    }
    if (!editable.length && !firstEditable) fail('Este plan ya no tiene pagos pendientes para cambiar.')
    if (automatic) {
      const first = byId.get(flow.first_payment_invoice_id)
      const dated = [...editable.map(row => row.due_date), ...(firstEditable ? [flow.first_payment_date || first?.due_date || first?.date] : [])]
      if (dated.some(value => !value || normalizeDateOnlyInTimezone(value, timezone) < today)) {
        fail('Reprograma los pagos vencidos antes de domiciliar el plan. No se cobrarán atrasos automáticamente.')
      }
    }
    const paymentMethod = automatic ? `${provider}_saved_card` : 'offline'
    for (const row of editable) {
      const payment = byId.get(row.payment_id)
      const paymentMetadata = json(payment.metadata_json)
      const nextStatus = automatic ? 'scheduled' : (status(payment.status) === 'sent' ? 'sent' : 'pending')
      await tx.run(
        `UPDATE installment_payments SET automatic = ?, payment_method = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [automatic ? 1 : 0, paymentMethod, nextStatus, automatic ? `Domiciliación elegida expresamente con ${card.source.label}.` : 'Sólo recordatorio offline. Una tarjeta guardada no autoriza cargos.', row.id]
      )
      await tx.run(
        `UPDATE payments SET payment_provider = ?, payment_method = ?, payment_mode = ?, status = ?, metadata_json = ?,
           conekta_payment_source_id = NULL, rebill_customer_id = NULL, rebill_card_id = NULL,
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [provider, paymentMethod, paymentMode, nextStatus, JSON.stringify({
          ...paymentMetadata,
          offlineReminder: !automatic,
          reminderTiming: automatic ? null : 'scheduled',
          reminderChannel,
          reminderDaysBefore,
          reminderTime,
          paymentPlan: { ...paymentMetadata.paymentPlan, flowId: flow.id, installmentId: row.id, sequence: row.sequence, trigger: automatic ? 'scheduled_installment' : 'offline_reminder' }
        }), payment.id]
      )
    }
    if (firstEditable) {
      const first = byId.get(flow.first_payment_invoice_id)
      const firstMetadata = json(first.metadata_json)
      await tx.run(`UPDATE payments SET payment_provider = ?, payment_method = ?, payment_mode = ?, status = ?, metadata_json = ?,
        conekta_payment_source_id = NULL, rebill_customer_id = NULL, rebill_card_id = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
        provider, paymentMethod, paymentMode, automatic ? 'scheduled' : 'pending', JSON.stringify({ ...firstMetadata, offlineReminder: !automatic, reminderTiming: automatic ? null : 'scheduled', reminderChannel, reminderDaysBefore, reminderTime, paymentPlan: { ...firstMetadata.paymentPlan, flowId: flow.id, trigger: automatic ? 'first_payment_saved_card' : 'first_payment_offline' } }), first.id
      ])
    }
    if (setup && !CLOSED.has(status(setup.status))) await tx.run("UPDATE payments SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [setup.id])
    const updatedMetadata = {
      ...metadata,
      collectionMode: mode,
      paymentMode,
      defaultPaymentMethod: automatic ? `${provider}_auto` : 'offline',
      reminderTiming: automatic ? null : 'scheduled',
      reminderChannel,
      reminderDaysBefore,
      reminderTime,
      collectionModeHistory: [...(Array.isArray(metadata.collectionModeHistory) ? metadata.collectionModeHistory : []), { mode, provider, actorId: clean(actorId), at: now }]
    }
    const stateHistory = json(flow.state_history)
    await tx.run(
      `UPDATE payment_flows SET payment_provider = ?, remaining_automatic = ?, current_state = ?,
         first_payment_method = ?, first_payment_status = ?, card_setup_required = 0, card_setup_payment_link = NULL,
         stripe_customer_id = ?, stripe_payment_method_id = ?, stripe_payment_method_label = ?,
         conekta_customer_id = ?, conekta_payment_source_id = ?, conekta_payment_source_label = ?,
         rebill_customer_id = ?, rebill_card_id = ?, rebill_card_label = ?,
         card_authorized_at = ?, metadata = ?, state_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND current_state = 'editing'`,
      [provider, automatic ? 1 : 0, targetState,
        firstEditable ? (automatic ? 'saved_card' : 'offline') : flow.first_payment_method,
        firstEditable ? (automatic ? 'scheduled' : 'pending') : flow.first_payment_status,
        card?.source.stripeCustomerId || flow.stripe_customer_id, card?.source.stripePaymentMethodId || flow.stripe_payment_method_id, provider === 'stripe' ? card.source.label : flow.stripe_payment_method_label,
        card?.source.conektaCustomerId || flow.conekta_customer_id, card?.source.conektaPaymentSourceId || flow.conekta_payment_source_id, provider === 'conekta' ? card.source.label : flow.conekta_payment_source_label,
        card?.source.rebillCustomerId || flow.rebill_customer_id, card?.source.rebillCardId || flow.rebill_card_id, provider === 'rebill' ? card.source.label : flow.rebill_card_label,
        automatic ? now : flow.card_authorized_at, JSON.stringify(updatedMetadata), JSON.stringify([...(Array.isArray(stateHistory) ? stateHistory : []), { state: targetState, at: now }]), flow.id]
    )
    await persistMirror(flow.id, provider)
  })
  return { flowId: flow.id, collectionMode: mode, paymentProvider: provider }
}
