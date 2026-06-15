import nodemailer from 'nodemailer'
import { getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'

// Configuración del remitente de correo de la cuenta.
// El password SMTP se guarda cifrado en una llave separada de app_config.
const EMAIL_CONFIG_KEY = 'email_smtp_config'
const EMAIL_PASSWORD_KEY = 'email_smtp_password'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Transporter cacheado: se invalida cuando cambia la configuración guardada.
let cachedTransporter = null
let cachedTransporterSignature = ''

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function maskUsername(username) {
  const value = cleanString(username)
  if (!value) return ''
  const [user, domain] = value.split('@')
  if (!domain) {
    return value.length <= 4 ? '****' : `${value.slice(0, 2)}****${value.slice(-2)}`
  }
  const visible = user.slice(0, 2)
  return `${visible}${'*'.repeat(Math.max(user.length - 2, 2))}@${domain}`
}

async function readStoredConfig() {
  const raw = await getAppConfig(EMAIL_CONFIG_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function readStoredPassword() {
  const encrypted = await getAppConfig(EMAIL_PASSWORD_KEY)
  if (!encrypted) return ''
  try {
    return decrypt(encrypted)
  } catch (error) {
    logger.error(`No se pudo desencriptar el password SMTP: ${error.message}`)
    return ''
  }
}

/**
 * Traduce errores técnicos de nodemailer a mensajes accionables.
 * El caso real más común es el typo "smpt." en lugar de "smtp.".
 */
function friendlySmtpError(error, host) {
  const code = String(error?.code || '').toUpperCase()
  const responseCode = Number(error?.responseCode) || 0

  if (code === 'EDNS' || code === 'ENOTFOUND' || /ENOTFOUND/i.test(error?.message || '')) {
    const suggestion = /smpt/i.test(host) ? ` ¿Quisiste decir "${host.replace(/smpt/gi, 'smtp')}"?` : ''
    return `El servidor "${host}" no existe. Revisa que esté bien escrito (por ejemplo smtp.gmail.com).${suggestion}`
  }

  if (code === 'EAUTH' || responseCode === 535 || responseCode === 534) {
    return 'El servidor rechazó el usuario o password. Si usas Gmail, necesitas un app password (no tu contraseña normal): actívalo en myaccount.google.com/apppasswords.'
  }

  if (['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNREFUSED'].includes(code)) {
    return `No se pudo alcanzar ${host}. Revisa el servidor y el puerto (587 o 465 normalmente).`
  }

  return `No se pudo conectar al servidor SMTP: ${error.message}`
}

function buildTransporter(config, password) {
  const port = Number(config.port) || 587
  return nodemailer.createTransport({
    host: config.host,
    port,
    // 465 usa SSL implícito; el resto negocia STARTTLS.
    secure: port === 465,
    auth: {
      user: config.username,
      pass: password
    }
  })
}

async function getTransporter(config, password) {
  const signature = JSON.stringify([config.host, config.port, config.username, password])
  if (!cachedTransporter || cachedTransporterSignature !== signature) {
    cachedTransporter = buildTransporter(config, password)
    cachedTransporterSignature = signature
  }
  return cachedTransporter
}

function invalidateTransporter() {
  cachedTransporter = null
  cachedTransporterSignature = ''
}

export async function getEmailStatus() {
  const config = await readStoredConfig()
  const hasPassword = Boolean(await getAppConfig(EMAIL_PASSWORD_KEY))
  const configured = Boolean(config?.host && config?.username && hasPassword)
  const connected = Boolean(configured && config?.connected)

  return {
    provider: 'smtp',
    connected,
    configured,
    smtp: {
      host: config?.host || '',
      port: Number(config?.port) || 587,
      usernameMasked: maskUsername(config?.username),
      hasPassword
    },
    sender: {
      fromName: config?.fromName || '',
      fromEmail: config?.fromEmail || '',
      replyTo: config?.replyTo || ''
    },
    timestamps: {
      connectedAt: config?.connectedAt || null,
      disconnectedAt: config?.disconnectedAt || null,
      lastVerifiedAt: config?.lastVerifiedAt || null,
      lastTestAt: config?.lastTestAt || null
    },
    lastError: config?.lastError || null
  }
}

/**
 * Guarda y verifica la conexión SMTP. Hace transporter.verify() contra el
 * servidor antes de marcarla como conectada, para que "conectado" siempre
 * signifique que se puede enviar de verdad.
 */
export async function connectEmail(payload = {}) {
  const previous = await readStoredConfig()

  const host = cleanString(payload.host) || previous?.host || ''
  const port = Number(payload.port) || Number(previous?.port) || 587
  const username = cleanString(payload.username) || previous?.username || ''
  const fromEmail = cleanString(payload.fromEmail).toLowerCase() || previous?.fromEmail || username.toLowerCase()
  const fromName = cleanString(payload.fromName) || previous?.fromName || ''
  const replyTo = cleanString(payload.replyTo).toLowerCase()

  if (!host) throw httpError(400, 'Escribe el servidor SMTP (por ejemplo smtp.gmail.com)')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'El puerto SMTP no es válido')
  if (!username) throw httpError(400, 'Escribe el usuario SMTP (normalmente es tu correo)')
  if (!EMAIL_PATTERN.test(fromEmail)) throw httpError(400, 'El correo del remitente no es válido')
  if (replyTo && !EMAIL_PATTERN.test(replyTo)) throw httpError(400, 'El correo de respuestas no es válido')

  const newPassword = cleanString(payload.password)
  const password = newPassword || await readStoredPassword()
  if (!password) throw httpError(400, 'Escribe el password o app password SMTP')

  const candidate = { host, port, username, fromEmail, fromName, replyTo }
  const transporter = buildTransporter(candidate, password)

  try {
    await transporter.verify()
  } catch (error) {
    logger.warn(`Verificación SMTP fallida para ${host}: ${error.message}`)
    throw httpError(400, friendlySmtpError(error, host))
  }

  const now = new Date().toISOString()
  if (newPassword) {
    await setAppConfig(EMAIL_PASSWORD_KEY, encrypt(newPassword))
  }
  await setAppConfig(EMAIL_CONFIG_KEY, {
    ...candidate,
    connected: true,
    connectedAt: previous?.connectedAt || now,
    lastVerifiedAt: now,
    disconnectedAt: null,
    lastTestAt: previous?.lastTestAt || null,
    lastError: null
  })
  invalidateTransporter()

  logger.info(`Correo conectado por SMTP (${host}:${port}) como ${maskUsername(username)}`)
  return getEmailStatus()
}

/**
 * Envía un correo usando la configuración de la cuenta.
 * Es el punto único de salida para que otras features lo reutilicen después.
 */
export async function sendEmail({ to, subject, text, html, replyTo } = {}) {
  const config = await readStoredConfig()
  const password = await readStoredPassword()

  if (!config?.connected || !config?.host || !config?.username || !password) {
    throw httpError(409, 'El correo no está conectado. Configúralo en Configuración > Correos')
  }

  const recipient = cleanString(to).toLowerCase()
  if (!EMAIL_PATTERN.test(recipient)) throw httpError(400, 'El correo del destinatario no es válido')
  if (!cleanString(subject)) throw httpError(400, 'El correo necesita un asunto')
  if (!cleanString(text) && !cleanString(html)) throw httpError(400, 'El correo necesita contenido')

  const transporter = await getTransporter(config, password)
  const fromEmail = config.fromEmail || config.username
  const from = config.fromName ? `"${config.fromName}" <${fromEmail}>` : fromEmail

  try {
    const result = await transporter.sendMail({
      from,
      to: recipient,
      subject: cleanString(subject),
      text: cleanString(text) || undefined,
      html: cleanString(html) || undefined,
      replyTo: cleanString(replyTo) || config.replyTo || undefined
    })

    return {
      messageId: result.messageId || null,
      accepted: result.accepted || [],
      rejected: result.rejected || []
    }
  } catch (error) {
    logger.error(`Error enviando correo a ${recipient}: ${error.message}`)
    const friendly = friendlySmtpError(error, config.host)
    await setAppConfig(EMAIL_CONFIG_KEY, { ...config, lastError: friendly })
    throw httpError(502, friendly)
  }
}

export async function sendTestEmail(to) {
  const status = await getEmailStatus()
  const result = await sendEmail({
    to,
    subject: 'Correo de prueba de Ristak',
    text: 'Tu cuenta de correo quedó conectada a Ristak. Este es un envío de prueba para confirmar que todo funciona.',
    html: `
      <div style="font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 12px; color: #0f172a;">Tu correo está conectado ✅</h2>
        <p style="margin: 0 0 8px; color: #334155; line-height: 1.5;">
          Este es un envío de prueba desde <strong>Ristak</strong> usando
          <strong>${status.sender.fromEmail || status.smtp.usernameMasked}</strong>.
        </p>
        <p style="margin: 0; color: #64748b; font-size: 13px;">Si recibiste este correo, la configuración SMTP funciona correctamente.</p>
      </div>
    `
  })

  const config = await readStoredConfig()
  if (config) {
    await setAppConfig(EMAIL_CONFIG_KEY, {
      ...config,
      lastTestAt: new Date().toISOString(),
      lastError: null
    })
  }

  return result
}

/**
 * Pausa la conexión sin borrar credenciales (mismo criterio que WhatsApp).
 */
export async function disconnectEmail() {
  const config = await readStoredConfig()
  if (config) {
    await setAppConfig(EMAIL_CONFIG_KEY, {
      ...config,
      connected: false,
      disconnectedAt: new Date().toISOString()
    })
  }
  invalidateTransporter()
  return getEmailStatus()
}

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}
