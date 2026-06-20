import { getAppConfig, setAppConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'

export const WHATSAPP_QR_DRIP_CONFIG_KEY = 'whatsapp_qr_drip_settings'
export const WHATSAPP_QR_DRIP_MIN_DELAY_SECONDS = 15
export const WHATSAPP_QR_DRIP_MAX_DELAY_SECONDS = 600
export const WHATSAPP_QR_DRIP_DEFAULT_DELAY_SECONDS = 30

const DEFAULT_WHATSAPP_QR_DRIP_SETTINGS = {
  enabled: true,
  delaySeconds: WHATSAPP_QR_DRIP_DEFAULT_DELAY_SECONDS
}

let qrDripReservationQueue = Promise.resolve()
let nextQrDripAvailableAt = 0
let sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function cleanBoolean(value, fallback = false) {
  if (value === true || value === false) return value
  if (typeof value === 'number') return value !== 0
  const normalized = String(value || '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'si', 'sí', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function cleanNumber(value, fallback, { min, max } = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.round(parsed), min), max)
}

function parseStoredSettings(rawValue) {
  if (!rawValue) return {}
  if (typeof rawValue === 'object') return rawValue

  try {
    const parsed = JSON.parse(rawValue)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function normalizeWhatsAppQrDripSettings(input = {}) {
  const merged = {
    ...DEFAULT_WHATSAPP_QR_DRIP_SETTINGS,
    ...(input || {})
  }

  return {
    enabled: cleanBoolean(merged.enabled, DEFAULT_WHATSAPP_QR_DRIP_SETTINGS.enabled),
    delaySeconds: cleanNumber(merged.delaySeconds, DEFAULT_WHATSAPP_QR_DRIP_SETTINGS.delaySeconds, {
      min: WHATSAPP_QR_DRIP_MIN_DELAY_SECONDS,
      max: WHATSAPP_QR_DRIP_MAX_DELAY_SECONDS
    }),
    minDelaySeconds: WHATSAPP_QR_DRIP_MIN_DELAY_SECONDS,
    maxDelaySeconds: WHATSAPP_QR_DRIP_MAX_DELAY_SECONDS
  }
}

export async function getWhatsAppQrDripSettings() {
  const stored = parseStoredSettings(await getAppConfig(WHATSAPP_QR_DRIP_CONFIG_KEY))
  return normalizeWhatsAppQrDripSettings(stored)
}

export async function saveWhatsAppQrDripSettings(input = {}) {
  const current = await getWhatsAppQrDripSettings()
  const next = normalizeWhatsAppQrDripSettings({
    ...current,
    ...(input || {})
  })

  await setAppConfig(WHATSAPP_QR_DRIP_CONFIG_KEY, {
    enabled: next.enabled,
    delaySeconds: next.delaySeconds
  })

  if (!next.enabled) {
    nextQrDripAvailableAt = 0
  }

  return next
}

export async function reserveWhatsAppQrDripSlot({ settings = null, now = Date.now } = {}) {
  const activeSettings = normalizeWhatsAppQrDripSettings(settings || await getWhatsAppQrDripSettings())
  if (!activeSettings.enabled) {
    return {
      enabled: false,
      delayMs: 0,
      delaySeconds: activeSettings.delaySeconds,
      sendAt: new Date(now()).toISOString()
    }
  }

  const delayMsPerMessage = activeSettings.delaySeconds * 1000
  const reservation = qrDripReservationQueue.catch(() => undefined).then(() => {
    const currentTime = now()
    const sendAtMs = Math.max(nextQrDripAvailableAt, currentTime)
    const delayMs = Math.max(0, sendAtMs - currentTime)
    nextQrDripAvailableAt = sendAtMs + delayMsPerMessage

    return {
      enabled: true,
      delayMs,
      delaySeconds: activeSettings.delaySeconds,
      sendAt: new Date(sendAtMs).toISOString()
    }
  })

  qrDripReservationQueue = reservation.then(() => undefined, () => undefined)
  return reservation
}

export async function waitForWhatsAppQrDripSlot(context = {}) {
  const reservation = await reserveWhatsAppQrDripSlot()
  if (reservation.enabled && reservation.delayMs > 0) {
    const target = context.to ? ` para ${context.to}` : ''
    const type = context.type ? ` (${context.type})` : ''
    logger.info(`[WhatsApp QR] Sistema anti-bloqueos espera ${Math.ceil(reservation.delayMs / 1000)}s${target}${type}`)
    await sleep(reservation.delayMs)
  }

  return reservation
}

export function setWhatsAppQrDripSleepForTest(sleepImpl = null) {
  sleep = typeof sleepImpl === 'function'
    ? sleepImpl
    : (ms) => new Promise(resolve => setTimeout(resolve, ms))
}

export function resetWhatsAppQrDripRuntimeForTest() {
  qrDripReservationQueue = Promise.resolve()
  nextQrDripAvailableAt = 0
  setWhatsAppQrDripSleepForTest(null)
}
