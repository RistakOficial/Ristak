import fs from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { db } from '../config/database.js'
import { buildPhoneMatchCandidates, normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { logger } from '../utils/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const QR_AUTH_ROOT = join(__dirname, '../../storage/whatsapp-qr-auth')
const QR_CONSENT_TEXT = 'Acepto que esta conexion usa WhatsApp Web por QR y no la API oficial de Meta. Entiendo que puede desconectarse, fallar o poner en riesgo el numero. Ristak solo la usara para mensajes individuales cuando yo lo active.'
const CONNECT_TIMEOUT_MS = 20000

const liveSessions = new Map()

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function nowIso() {
  return new Date().toISOString()
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify({ unserializable: true })
  }
}

function normalizeConnectedPhone(value = '') {
  const text = cleanString(value)
  const bare = text.split('@')[0]?.split(':')[0] || text
  return normalizePhoneForStorage(bare) || bare.replace(/\D/g, '')
}

function phoneMatches(left = '', right = '') {
  const leftCandidates = buildPhoneMatchCandidates(left)
  const rightCandidates = buildPhoneMatchCandidates(right)
  return leftCandidates.some(candidate => rightCandidates.includes(candidate))
}

function getSessionId(phoneNumberId) {
  return `qr_${phoneNumberId}`
}

function getAuthDir(phoneNumberId) {
  return join(QR_AUTH_ROOT, cleanString(phoneNumberId).replace(/[^a-z0-9_-]/gi, '_'))
}

async function loadBaileys() {
  try {
    const baileys = await import('@whiskeysockets/baileys')
    const makeWASocket = baileys.default || baileys.makeWASocket

    if (!makeWASocket || !baileys.useMultiFileAuthState) {
      throw new Error('El paquete de QR no trae los metodos esperados')
    }

    return {
      makeWASocket,
      useMultiFileAuthState: baileys.useMultiFileAuthState,
      DisconnectReason: baileys.DisconnectReason || {},
      Browsers: baileys.Browsers || null
    }
  } catch (error) {
    throw new Error(`La conexion por QR no esta instalada correctamente: ${error.message}`)
  }
}

async function loadQrCode() {
  try {
    return await import('qrcode')
  } catch (error) {
    logger.warn(`[WhatsApp QR] No se pudo cargar qrcode: ${error.message}`)
    return null
  }
}

async function getPhoneRow(phoneNumberId) {
  const id = cleanString(phoneNumberId)
  if (!id) throw new Error('Elige el numero que quieres conectar por QR')

  const row = await db.get(`
    SELECT *
    FROM whatsapp_api_phone_numbers
    WHERE id = ?
  `, [id])

  if (!row) {
    throw new Error('No encontramos ese numero en la conexion oficial de WhatsApp')
  }

  const expectedPhone = normalizePhoneForStorage(row.phone_number || row.display_phone_number) ||
    cleanString(row.phone_number || row.display_phone_number)

  if (!expectedPhone) {
    throw new Error('Ese numero no tiene telefono guardado para validar el QR')
  }

  return {
    ...row,
    expectedPhone
  }
}

async function resolveQrPhone({ phoneNumberId, from } = {}) {
  if (phoneNumberId) return getPhoneRow(phoneNumberId)

  const normalizedFrom = normalizePhoneForStorage(from) || cleanString(from)
  if (!normalizedFrom) throw new Error('Elige el numero que enviara por QR')

  const rows = await db.all(`
    SELECT *
    FROM whatsapp_api_phone_numbers
    WHERE qr_send_enabled = 1
  `)

  const row = rows.find(item => phoneMatches(item.phone_number || item.display_phone_number, normalizedFrom))
  if (!row) {
    throw new Error('Ese numero no tiene QR conectado para enviar mensajes')
  }

  return getPhoneRow(row.id)
}

async function getSessionRow(phoneNumberId) {
  return db.get(`
    SELECT *
    FROM whatsapp_qr_sessions
    WHERE phone_number_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `, [phoneNumberId])
}

async function updatePhoneQrState(phoneNumberId, values = {}) {
  const updates = []
  const params = []

  for (const [column, value] of Object.entries(values)) {
    updates.push(`${column} = ?`)
    params.push(value)
  }

  if (!updates.length) return

  updates.push('updated_at = CURRENT_TIMESTAMP')
  params.push(phoneNumberId)
  await db.run(`
    UPDATE whatsapp_api_phone_numbers
    SET ${updates.join(', ')}
    WHERE id = ?
  `, params)
}

async function upsertSession(phone, values = {}) {
  const id = getSessionId(phone.id)
  const existing = await getSessionRow(phone.id)
  const next = {
    expectedPhone: phone.expectedPhone,
    connectedPhone: values.connectedPhone ?? existing?.connected_phone ?? null,
    status: values.status ?? existing?.status ?? 'disconnected',
    qrCode: values.qrCode ?? existing?.qr_code ?? null,
    qrCodeDataUrl: values.qrCodeDataUrl ?? existing?.qr_code_data_url ?? null,
    consentAccepted: values.consentAccepted ?? Number(existing?.consent_accepted || 0),
    consentText: values.consentText ?? existing?.consent_text ?? QR_CONSENT_TEXT,
    consentAcceptedAt: values.consentAcceptedAt ?? existing?.consent_accepted_at ?? null,
    consentAcceptedBy: values.consentAcceptedBy ?? existing?.consent_accepted_by ?? null,
    lastError: values.lastError ?? existing?.last_error ?? null,
    lastConnectedAt: values.lastConnectedAt ?? existing?.last_connected_at ?? null,
    lastDisconnectedAt: values.lastDisconnectedAt ?? existing?.last_disconnected_at ?? null
  }

  await db.run(`
    INSERT INTO whatsapp_qr_sessions (
      id, phone_number_id, expected_phone, connected_phone, status,
      qr_code, qr_code_data_url, consent_accepted, consent_text,
      consent_accepted_at, consent_accepted_by, last_error,
      last_connected_at, last_disconnected_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      expected_phone = excluded.expected_phone,
      connected_phone = excluded.connected_phone,
      status = excluded.status,
      qr_code = excluded.qr_code,
      qr_code_data_url = excluded.qr_code_data_url,
      consent_accepted = excluded.consent_accepted,
      consent_text = excluded.consent_text,
      consent_accepted_at = excluded.consent_accepted_at,
      consent_accepted_by = excluded.consent_accepted_by,
      last_error = excluded.last_error,
      last_connected_at = excluded.last_connected_at,
      last_disconnected_at = excluded.last_disconnected_at,
      updated_at = CURRENT_TIMESTAMP
  `, [
    id,
    phone.id,
    next.expectedPhone,
    next.connectedPhone,
    next.status,
    next.qrCode,
    next.qrCodeDataUrl,
    next.consentAccepted ? 1 : 0,
    next.consentText,
    next.consentAcceptedAt,
    next.consentAcceptedBy,
    next.lastError,
    next.lastConnectedAt,
    next.lastDisconnectedAt
  ])

  await updatePhoneQrState(phone.id, {
    qr_send_enabled: next.status === 'connected' ? 1 : Number(next.consentAccepted || 0),
    qr_status: next.status,
    qr_connected_phone: next.connectedPhone || null,
    qr_consent_accepted_at: next.consentAcceptedAt,
    qr_consent_accepted_by: next.consentAcceptedBy,
    qr_last_connected_at: next.lastConnectedAt,
    qr_last_disconnected_at: next.lastDisconnectedAt,
    qr_last_error: next.lastError
  })

  return getSessionRow(phone.id)
}

function mapSessionForResponse(row = {}) {
  if (!row) return null

  return {
    id: row.id,
    phoneNumberId: row.phone_number_id,
    expectedPhone: row.expected_phone,
    connectedPhone: row.connected_phone,
    status: row.status || 'disconnected',
    qrCode: row.qr_code || '',
    qrCodeDataUrl: row.qr_code_data_url || '',
    consentAccepted: Number(row.consent_accepted || 0) === 1,
    consentText: row.consent_text || QR_CONSENT_TEXT,
    consentAcceptedAt: row.consent_accepted_at || null,
    consentAcceptedBy: row.consent_accepted_by || null,
    lastError: row.last_error || '',
    lastConnectedAt: row.last_connected_at || null,
    lastDisconnectedAt: row.last_disconnected_at || null,
    updatedAt: row.updated_at || null
  }
}

function closeLiveSession(phoneNumberId) {
  const live = liveSessions.get(phoneNumberId)
  liveSessions.delete(phoneNumberId)

  if (!live?.sock) return

  try {
    if (typeof live.sock.end === 'function') live.sock.end()
  } catch (error) {
    logger.warn(`[WhatsApp QR] No se pudo cerrar socket ${phoneNumberId}: ${error.message}`)
  }
}

async function openSocket(phone, { requireConsent = true } = {}) {
  const existing = await getSessionRow(phone.id)
  if (requireConsent && Number(existing?.consent_accepted || 0) !== 1) {
    throw new Error('Primero acepta el riesgo de usar conexion por QR para este numero')
  }

  closeLiveSession(phone.id)
  await fs.mkdir(getAuthDir(phone.id), { recursive: true })

  const { makeWASocket, useMultiFileAuthState, Browsers } = await loadBaileys()
  const { state, saveCreds } = await useMultiFileAuthState(getAuthDir(phone.id))

  let resolveOpen
  let rejectOpen
  const openPromise = new Promise((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = reject
  })

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    browser: Browsers?.macOS ? Browsers.macOS('Ristak') : undefined
  })

  liveSessions.set(phone.id, {
    sock,
    openPromise,
    connected: false
  })

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async (update = {}) => {
    const live = liveSessions.get(phone.id)

    if (update.qr) {
      const qrModule = await loadQrCode()
      const qrCodeDataUrl = qrModule?.toDataURL
        ? await qrModule.toDataURL(update.qr, { margin: 1, width: 320 })
        : ''

      await upsertSession(phone, {
        status: 'qr_pending',
        qrCode: update.qr,
        qrCodeDataUrl,
        lastError: null
      })
      return
    }

    if (update.connection === 'open') {
      const connectedPhone = normalizeConnectedPhone(sock.user?.id || sock.user?.lid || '')

      if (!phoneMatches(connectedPhone, phone.expectedPhone)) {
        const message = `El QR conecto ${connectedPhone || 'otro numero'}, pero esperabamos ${phone.expectedPhone}`
        await upsertSession(phone, {
          status: 'number_mismatch',
          connectedPhone: connectedPhone || null,
          qrCode: null,
          qrCodeDataUrl: null,
          lastError: message,
          lastDisconnectedAt: nowIso()
        })
        rejectOpen(new Error(message))
        closeLiveSession(phone.id)
        return
      }

      if (live) live.connected = true
      await upsertSession(phone, {
        status: 'connected',
        connectedPhone,
        qrCode: null,
        qrCodeDataUrl: null,
        lastError: null,
        lastConnectedAt: nowIso()
      })
      resolveOpen(sock)
      return
    }

    if (update.connection === 'close') {
      const statusCode = update.lastDisconnect?.error?.output?.statusCode
      const lastError = update.lastDisconnect?.error?.message || ''
      const status = statusCode ? `disconnected_${statusCode}` : 'disconnected'
      const liveStillCurrent = liveSessions.get(phone.id)?.sock === sock

      await upsertSession(phone, {
        status,
        qrCode: null,
        qrCodeDataUrl: null,
        lastError,
        lastDisconnectedAt: nowIso()
      })

      if (liveStillCurrent) liveSessions.delete(phone.id)
      rejectOpen(new Error(lastError || 'La conexion por QR se desconecto'))
    }
  })

  return {
    sock,
    openPromise
  }
}

async function waitForSessionReady(phoneNumberId, timeoutMs = 6000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const row = await getSessionRow(phoneNumberId)
    if (['qr_pending', 'connected', 'number_mismatch'].includes(row?.status)) {
      return row
    }
    await new Promise(resolve => setTimeout(resolve, 350))
  }

  return getSessionRow(phoneNumberId)
}

async function ensureOpenSocket(phone) {
  const live = liveSessions.get(phone.id)
  if (live?.sock && live.connected) return live.sock

  const { sock, openPromise } = await openSocket(phone)
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('El QR no esta conectado. Abre Configuracion > WhatsApp y escanea el codigo.')), CONNECT_TIMEOUT_MS)
  })

  await Promise.race([openPromise, timeout])
  return sock
}

export async function getWhatsAppQrSessions() {
  const rows = await db.all(`
    SELECT *
    FROM whatsapp_qr_sessions
    ORDER BY updated_at DESC
  `)

  return rows.map(mapSessionForResponse)
}

export async function getWhatsAppQrSession(phoneNumberId) {
  return mapSessionForResponse(await getSessionRow(phoneNumberId))
}

export async function startWhatsAppQrConnection({ phoneNumberId, acceptedRisk, acceptedBy } = {}) {
  const phone = await getPhoneRow(phoneNumberId)
  if (!acceptedRisk) {
    throw new Error('Para usar QR necesitas aceptar el aviso de riesgo')
  }

  const acceptedAt = nowIso()
  await upsertSession(phone, {
    status: 'starting',
    consentAccepted: 1,
    consentText: QR_CONSENT_TEXT,
    consentAcceptedAt: acceptedAt,
    consentAcceptedBy: cleanString(acceptedBy) || 'usuario',
    qrCode: null,
    qrCodeDataUrl: null,
    lastError: null
  })

  openSocket(phone, { requireConsent: true })
    .then(({ openPromise }) => {
      openPromise.catch(error => {
        logger.warn(`[WhatsApp QR] Conexion pendiente/fallida ${phone.id}: ${error.message}`)
      })
    })
    .catch(error => {
      logger.warn(`[WhatsApp QR] No se pudo abrir QR ${phone.id}: ${error.message}`)
    })

  const row = await waitForSessionReady(phone.id)
  return mapSessionForResponse(row)
}

export async function disconnectWhatsAppQrConnection({ phoneNumberId } = {}) {
  const phone = await getPhoneRow(phoneNumberId)

  try {
    const live = liveSessions.get(phone.id)
    if (live?.sock?.logout) await live.sock.logout()
  } catch (error) {
    logger.warn(`[WhatsApp QR] No se pudo cerrar sesion QR ${phone.id}: ${error.message}`)
  }

  closeLiveSession(phone.id)

  try {
    await fs.rm(getAuthDir(phone.id), { recursive: true, force: true })
  } catch (error) {
    logger.warn(`[WhatsApp QR] No se pudo borrar auth ${phone.id}: ${error.message}`)
  }

  const row = await upsertSession(phone, {
    status: 'disconnected',
    connectedPhone: null,
    qrCode: null,
    qrCodeDataUrl: null,
    lastError: null,
    lastDisconnectedAt: nowIso()
  })

  await updatePhoneQrState(phone.id, {
    qr_send_enabled: 0,
    qr_status: 'disconnected',
    qr_connected_phone: null
  })

  return mapSessionForResponse(row)
}

export async function sendWhatsAppQrTextMessage({ phoneNumberId, from, to, text, externalId } = {}) {
  const phone = await resolveQrPhone({ phoneNumberId, from })
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const body = cleanString(text)

  if (Number(phone.qr_send_enabled || 0) !== 1) {
    throw new Error('Ese numero no tiene el envio por QR activado')
  }
  if (!toPhone) throw new Error('Falta el numero destino')
  if (!body) throw new Error('Falta el texto del mensaje')

  const sock = await ensureOpenSocket(phone)
  const jid = `${toPhone.replace(/\D/g, '')}@s.whatsapp.net`
  const response = await sock.sendMessage(jid, { text: body })

  return {
    id: response?.key?.id || externalId || '',
    wamid: response?.key?.id || '',
    from: phone.expectedPhone,
    to: toPhone,
    type: 'text',
    text: { body },
    status: 'sent',
    transport: 'qr',
    createTime: nowIso(),
    raw: response ? safeJson(response) : null
  }
}

export { QR_CONSENT_TEXT }
