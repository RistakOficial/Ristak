import crypto from 'crypto'
import {
  getPaymentSettings,
  normalizePaymentSettings,
  resolvePaymentSettingsBusinessProfile,
  savePaymentSettings
} from '../services/paymentSettingsService.js'
import { getAccountBusinessProfile } from '../services/accountBusinessProfileService.js'
import { renderPaymentReceiptPreviewHtml } from '../services/paymentReceiptPreviewService.js'
import { logger } from '../utils/logger.js'
import { syncRegisteredIntegrationCronsForProvider } from '../jobs/integrationCronRegistry.js'
import {
  getGigstackFiscalProfile,
  requeueBlockedGigstackInvoiceJobs,
  testGigstackConnection
} from '../services/gigstackInvoiceService.js'

const PAYMENT_RECEIPT_PREVIEW_TTL_MS = 60 * 60 * 1000
const paymentReceiptPreviewSessions = new Map()

function sendPaymentSettingsError(res, error, fallback = 'No se pudo guardar la configuración de pagos') {
  res.status(error.status || 500).json({
    success: false,
    error: error.message || fallback
  })
}

function getRequestOrigin(req) {
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'http'
  const host = req.get('x-forwarded-host') || req.get('host')
  return host ? `${protocol}://${host}` : ''
}

function getPreviewUserId(req) {
  return String(req.user?.userId || req.user?.id || req.user?.email || 'user')
}

function cleanupPaymentReceiptPreviewSessions() {
  const now = Date.now()
  for (const [token, session] of paymentReceiptPreviewSessions.entries()) {
    if (!session?.expiresAt || session.expiresAt <= now) {
      paymentReceiptPreviewSessions.delete(token)
    }
  }
}

function getPaymentReceiptPreviewCookieName(token) {
  return `rstk_payment_receipt_preview_${String(token || '').slice(0, 18).replace(/[^a-zA-Z0-9_-]/g, '')}`
}

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const separatorIndex = part.indexOf('=')
      if (separatorIndex < 0) return acc
      const key = part.slice(0, separatorIndex)
      const value = part.slice(separatorIndex + 1)
      acc[key] = decodeURIComponent(value || '')
      return acc
    }, {})
}

function setPaymentReceiptPreviewCookie(req, res, token) {
  res.cookie(getPaymentReceiptPreviewCookieName(token), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.get('x-forwarded-proto') === 'https',
    maxAge: PAYMENT_RECEIPT_PREVIEW_TTL_MS,
    path: '/api/settings/payments'
  })
}

function cleanCurrency(value) {
  const normalized = String(value || 'MXN').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(normalized) ? normalized : 'MXN'
}

async function buildPaymentSettingsPreviewSnapshot(input = {}) {
  const current = await getPaymentSettings()
  const draft = input?.settings && typeof input.settings === 'object' ? input.settings : input

  const normalized = normalizePaymentSettings({
    paymentMode: draft.paymentMode ?? current.paymentMode,
    checkout: { ...current.checkout, ...(draft.checkout || {}) },
    receipt: { ...current.receipt, ...(draft.receipt || {}) },
    automations: { ...current.automations, ...(draft.automations || {}) },
    taxes: { ...current.taxes, ...(draft.taxes || {}) }
  })

  return resolvePaymentSettingsBusinessProfile(normalized, await getAccountBusinessProfile())
}

export async function getPaymentSettingsView(_req, res) {
  try {
    const settings = await getPaymentSettings()
    res.json({ success: true, data: settings })
  } catch (error) {
    logger.error(`Error obteniendo configuración de pagos: ${error.message}`)
    sendPaymentSettingsError(res, error, 'No se pudo obtener la configuración de pagos')
  }
}

export async function savePaymentSettingsView(req, res) {
  try {
    const settings = await savePaymentSettings(req.body || {})
    await syncRegisteredIntegrationCronsForProvider('stripe', { reason: 'payment-mode-changed' })
    await syncRegisteredIntegrationCronsForProvider('conekta', { reason: 'payment-mode-changed' })
    await syncRegisteredIntegrationCronsForProvider('mercadopago', { reason: 'payment-mode-changed' })
    await syncRegisteredIntegrationCronsForProvider('rebill', { reason: 'payment-mode-changed' })
    await requeueBlockedGigstackInvoiceJobs()
    await syncRegisteredIntegrationCronsForProvider('gigstack', { reason: 'gigstack-settings-changed' })
    res.json({ success: true, data: settings })
  } catch (error) {
    logger.error(`Error guardando configuración de pagos: ${error.message}`)
    sendPaymentSettingsError(res, error)
  }
}

export async function testGigstackConnectionView(req, res) {
  try {
    const result = await testGigstackConnection({
      mode: req.body?.mode,
      token: req.body?.token
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.warn(`Validación de conexión Gigstack rechazada: ${error.message}`)
    sendPaymentSettingsError(res, error, 'No se pudo validar la conexión con Gigstack')
  }
}

export async function syncGigstackFiscalProfileView(req, res) {
  try {
    const current = await getPaymentSettings({ includeSecrets: true, resolveBusinessProfile: false })
    const draft = req.body?.settings && typeof req.body.settings === 'object'
      ? req.body.settings
      : current
    const mode = req.body?.mode || draft.paymentMode || current.paymentMode
    const draftTaxes = { ...current.taxes, ...(draft.taxes || {}) }
    const token = req.body?.token || (mode === 'live'
      ? draftTaxes.gigstackLiveApiToken
      : draftTaxes.gigstackTestApiToken)
    const profile = await getGigstackFiscalProfile({ mode, token })

    const settings = await savePaymentSettings({
      ...current,
      ...draft,
      taxes: {
        ...draftTaxes,
        enabled: true,
        gigstackEnabled: true,
        gigstackFiscalSource: 'gigstack',
        gigstackSatConnected: profile.satConnected,
        gigstackTeamId: profile.teamId,
        taxName: profile.taxName,
        rateType: 'percentage',
        rateValue: profile.rateValue,
        rateSource: 'gigstack',
        gigstackTaxFactor: profile.taxFactor,
        calculationMode: profile.calculationMode,
        country: profile.country,
        fiscalId: profile.fiscalId,
        fiscalLegalName: profile.fiscalLegalName,
        fiscalPostalCode: profile.fiscalPostalCode,
        fiscalRegime: profile.fiscalRegime,
        ...(profile.defaultDescription ? { gigstackDefaultDescription: profile.defaultDescription } : {}),
        ...(profile.productKey ? { gigstackDefaultProductKey: profile.productKey } : {}),
        ...(profile.unitKey ? { gigstackDefaultUnitKey: profile.unitKey } : {}),
        ...(profile.unitName ? { gigstackDefaultUnitName: profile.unitName } : {})
      }
    }, { allowGigstackFiscalOverride: true })

    await requeueBlockedGigstackInvoiceJobs()
    await syncRegisteredIntegrationCronsForProvider('gigstack', { reason: 'gigstack-fiscal-profile-synced' })
    res.json({ success: true, data: settings })
  } catch (error) {
    logger.warn(`Sincronización fiscal de Gigstack rechazada: ${error.message}`)
    sendPaymentSettingsError(res, error, 'No se pudo importar la configuración fiscal desde Gigstack')
  }
}

export async function createPaymentReceiptPreviewSessionView(req, res) {
  try {
    const settingsSnapshot = await buildPaymentSettingsPreviewSnapshot(req.body || {})

    cleanupPaymentReceiptPreviewSessions()
    const token = crypto.randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + PAYMENT_RECEIPT_PREVIEW_TTL_MS

    paymentReceiptPreviewSessions.set(token, {
      token,
      userId: getPreviewUserId(req),
      settingsSnapshot,
      currency: cleanCurrency(req.body?.currency || req.body?.accountCurrency),
      expiresAt
    })
    setPaymentReceiptPreviewCookie(req, res, token)

    const params = new URLSearchParams()
    params.set('no_track', '1')
    const origin = getRequestOrigin(req)
    const path = `/api/settings/payments/receipt-preview-session/${encodeURIComponent(token)}`

    res.json({
      success: true,
      data: {
        url: `${origin}${path}?${params.toString()}`,
        expiresAt: new Date(expiresAt).toISOString()
      }
    })
  } catch (error) {
    logger.error(`Error creando preview temporal de comprobante: ${error.message}`)
    sendPaymentSettingsError(res, error, 'No se pudo crear la previsualización del comprobante')
  }
}

export async function previewPaymentReceiptSessionView(req, res) {
  try {
    cleanupPaymentReceiptPreviewSessions()
    const token = String(req.params.token || '')
    const session = paymentReceiptPreviewSessions.get(token)
    const cookieValue = parseCookies(req)[getPaymentReceiptPreviewCookieName(token)]

    if (!session || cookieValue !== token) {
      return res.status(403).type('html').send('Preview expirado o no autorizado')
    }

    res.set('Cache-Control', 'no-store')
    res.status(200).type('html').send(renderPaymentReceiptPreviewHtml(session.settingsSnapshot, {
      currency: session.currency,
      generatedAt: new Date()
    }))
  } catch (error) {
    logger.error(`Error previsualizando sesión temporal de comprobante: ${error.message}`)
    return res.status(500).type('html').send('Error previsualizando comprobante')
  }
}
