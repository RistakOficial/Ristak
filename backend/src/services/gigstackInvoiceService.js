import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { calculatePaymentTax, getPaymentSettings } from './paymentSettingsService.js'

const GIGSTACK_API_BASE_URL = (process.env.GIGSTACK_API_BASE_URL || 'https://api.gigstack.io/v2').replace(/\/+$/, '')

function cleanString(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function roundMoney(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.round(parsed * 100) / 100
}

function resolvePaymentForm(method = '') {
  const normalized = cleanString(method).toLowerCase()
  if (['card', 'stripe', 'stripe_saved_card', 'mercadopago', 'mercadopago_checkout'].includes(normalized)) return '04'
  if (['bank_transfer', 'transfer', 'spei'].includes(normalized)) return '03'
  if (['cash', 'deposit'].includes(normalized)) return '01'
  if (normalized === 'check') return '02'
  return '99'
}

function getPaymentTax(row, settings) {
  const metadata = parseJson(row.metadata_json)
  const storedTax = metadata.tax && typeof metadata.tax === 'object' ? metadata.tax : null

  if (storedTax?.enabled && Number(storedTax.taxAmount) > 0) {
    return {
      enabled: true,
      taxName: cleanString(storedTax.taxName || storedTax.name) || settings.taxes.taxName,
      rateType: 'percentage',
      rateValue: roundMoney(storedTax.rateValue || storedTax.rate || settings.taxes.rateValue),
      rateSource: storedTax.rateSource || settings.taxes.rateSource,
      calculationMode: storedTax.calculationMode || settings.taxes.calculationMode,
      country: storedTax.country || settings.taxes.country,
      fiscalId: storedTax.fiscalId || settings.taxes.fiscalId,
      fiscalLegalName: storedTax.fiscalLegalName || settings.taxes.fiscalLegalName,
      fiscalPostalCode: storedTax.fiscalPostalCode || settings.taxes.fiscalPostalCode,
      fiscalRegime: storedTax.fiscalRegime || settings.taxes.fiscalRegime,
      provider: 'gigstack',
      subtotalAmount: roundMoney(storedTax.subtotalAmount),
      taxAmount: roundMoney(storedTax.taxAmount),
      totalAmount: roundMoney(storedTax.totalAmount || row.amount)
    }
  }

  return calculatePaymentTax(row.amount, settings.taxes)
}

function buildGigstackPayload(row, settings, tax) {
  const taxes = settings.taxes
  const contactName = cleanString(row.contact_name || row.contact_full_name || row.contact_email || row.contact_phone || 'Cliente')
  const description = cleanString(row.description || row.title || 'Pago')

  return {
    external_id: row.id,
    payment_form: resolvePaymentForm(row.payment_method || row.payment_provider),
    client: {
      id: cleanString(row.contact_id),
      name: contactName,
      email: cleanString(row.contact_email),
      phone: cleanString(row.contact_phone)
    },
    issuer: {
      tax_id: cleanString(taxes.fiscalId),
      legal_name: cleanString(taxes.fiscalLegalName),
      tax_regime: cleanString(taxes.fiscalRegime),
      postal_code: cleanString(taxes.fiscalPostalCode),
      country: cleanString(taxes.country || 'MX')
    },
    payment: {
      id: row.id,
      amount: tax.totalAmount,
      currency: cleanString(row.currency || 'MXN').toUpperCase(),
      paid_at: row.paid_at || row.date || new Date().toISOString(),
      method: cleanString(row.payment_method || row.payment_provider || 'other'),
      reference: cleanString(row.reference || row.public_payment_id || row.ghl_invoice_id)
    },
    items: [
      {
        description,
        quantity: 1,
        unit_price: tax.subtotalAmount,
        tax: {
          name: tax.taxName,
          rate: tax.rateValue,
          amount: tax.taxAmount,
          calculation_mode: tax.calculationMode
        }
      }
    ],
    metadata: {
      ristak_payment_id: row.id,
      provider: cleanString(row.payment_provider || 'manual'),
      mode: cleanString(row.payment_mode || 'live')
    }
  }
}

async function updateGigstackMetadata(paymentId, patch) {
  const row = await db.get('SELECT metadata_json FROM payments WHERE id = ?', [paymentId])
  const metadata = parseJson(row?.metadata_json)
  metadata.gigstack = {
    ...(metadata.gigstack || {}),
    ...patch,
    updatedAt: new Date().toISOString()
  }
  await db.run(
    'UPDATE payments SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [JSON.stringify(metadata), paymentId]
  )
}

export async function registerGigstackPaymentForTransaction(paymentId) {
  const cleanPaymentId = cleanString(paymentId, 160)
  if (!cleanPaymentId) return { skipped: true, reason: 'missing_payment_id' }

  const settings = await getPaymentSettings({ includeSecrets: true })
  const taxes = settings.taxes || {}
  if (!taxes.enabled || !taxes.gigstackEnabled) return { skipped: true, reason: 'gigstack_disabled' }
  if (!taxes.gigstackApiToken) return { skipped: true, reason: 'missing_gigstack_token' }

  const row = await db.get(
    `SELECT
      p.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone
    FROM payments p
    LEFT JOIN contacts c ON c.id = p.contact_id
    WHERE p.id = ?`,
    [cleanPaymentId]
  )

  if (!row) return { skipped: true, reason: 'payment_not_found' }
  if (!['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success'].includes(cleanString(row.status).toLowerCase())) {
    return { skipped: true, reason: 'payment_not_paid' }
  }

  const existingMetadata = parseJson(row.metadata_json)
  if (existingMetadata.gigstack?.status === 'registered' || existingMetadata.gigstack?.status === 'stamped') {
    return { skipped: true, reason: 'already_registered' }
  }

  const tax = getPaymentTax(row, settings)
  if (!tax?.enabled || tax.taxAmount <= 0) return { skipped: true, reason: 'missing_tax' }

  const payload = buildGigstackPayload(row, settings, tax)
  const response = await fetch(`${GIGSTACK_API_BASE_URL}/payments/register`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${taxes.gigstackApiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    const message = data?.message || data?.error || `GYStack respondió ${response.status}`
    await updateGigstackMetadata(cleanPaymentId, {
      status: 'error',
      error: message
    })
    const error = new Error(message)
    error.status = response.status
    throw error
  }

  await updateGigstackMetadata(cleanPaymentId, {
    status: data?.status || data?.invoice?.status || 'registered',
    id: data?.id || data?.payment?.id || data?.invoice?.id || '',
    uuid: data?.uuid || data?.invoice?.uuid || '',
    pdfUrl: data?.pdf_url || data?.invoice?.pdf_url || '',
    registeredAt: new Date().toISOString()
  })

  logger.info(`Pago ${cleanPaymentId} registrado en GYStack para timbrado automático.`)
  return { registered: true, data }
}

export function registerGigstackPaymentForTransactionInBackground(paymentId) {
  registerGigstackPaymentForTransaction(paymentId).catch((error) => {
    logger.warn(`No se pudo registrar pago ${paymentId} en GYStack: ${error.message}`)
  })
}
