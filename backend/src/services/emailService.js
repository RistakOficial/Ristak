import { promises as dns } from 'node:dns'
import nodemailer from 'nodemailer'
import { getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { clearEmailIntegrationCredentials } from './integrationCredentialsCleanupService.js'

// Configuración del remitente de correo de la cuenta.
// El password SMTP se guarda cifrado en una llave separada de app_config.
const EMAIL_CONFIG_KEY = 'email_smtp_config'
const EMAIL_PASSWORD_KEY = 'email_smtp_password'
const EMAIL_SIGNATURE_CONFIG_KEY = 'email_signature_config'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SMTP_SECURITY_TYPES = new Set(['starttls', 'ssl', 'none'])
const SIGNATURE_HTML_LIMIT = 70000
const SIGNATURE_TEXT_LIMIT = 8000
const SIGNATURE_IMAGE_LIMIT = 2 * 1024 * 1024
const ALLOWED_SIGNATURE_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'div',
  'em',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  's',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul'
])
const VOID_SIGNATURE_TAGS = new Set(['br', 'hr', 'img'])
const ALLOWED_SIGNATURE_STYLE_PROPS = new Set([
  'background-color',
  'border',
  'border-bottom',
  'border-left',
  'border-radius',
  'border-right',
  'border-top',
  'color',
  'display',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'height',
  'line-height',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-width',
  'min-width',
  'object-fit',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'text-align',
  'text-decoration',
  'vertical-align',
  'white-space',
  'width'
])

const EMAIL_PROVIDER_DEFINITIONS = [
  {
    id: 'google',
    label: 'Google Gmail / Workspace',
    domainPatterns: [/^(gmail|googlemail)\.com$/i],
    mxPatterns: [/google\.com$/i, /googlemail\.com$/i],
    smtp: { host: 'smtp.gmail.com', port: 587, security: 'starttls' }
  },
  {
    id: 'microsoft',
    label: 'Microsoft 365 / Outlook',
    domainPatterns: [/^(outlook|hotmail|live|msn)\.com$/i],
    mxPatterns: [/protection\.outlook\.com$/i, /outlook\.com$/i],
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' }
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    domainPatterns: [/^(yahoo|ymail|rocketmail)\.com$/i],
    mxPatterns: [/yahoodns\.net$/i, /yahoo\.com$/i],
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'ssl' }
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    domainPatterns: [/^(icloud|me|mac)\.com$/i],
    mxPatterns: [/mail\.icloud\.com$/i],
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' }
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    domainPatterns: [/^zoho\.[a-z.]+$/i],
    mxPatterns: [/zoho\.[a-z.]+$/i, /zohomail\.[a-z.]+$/i],
    smtp: { host: 'smtp.zoho.com', port: 465, security: 'ssl' }
  },
  {
    id: 'godaddy',
    label: 'GoDaddy / Microsoft email',
    mxPatterns: [/secureserver\.net$/i],
    smtp: { host: 'smtpout.secureserver.net', port: 465, security: 'ssl' }
  },
  {
    id: 'titan',
    label: 'Titan Email',
    mxPatterns: [/titan\.email$/i],
    smtp: { host: 'smtp.titan.email', port: 465, security: 'ssl' }
  },
  {
    id: 'privateemail',
    label: 'Namecheap Private Email',
    mxPatterns: [/privateemail\.com$/i],
    smtp: { host: 'mail.privateemail.com', port: 465, security: 'ssl' }
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    domainPatterns: [/^fastmail\.[a-z.]+$/i],
    mxPatterns: [/messagingengine\.com$/i],
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'ssl' }
  },
  {
    id: 'aol',
    label: 'AOL Mail',
    domainPatterns: [/^aol\.com$/i],
    mxPatterns: [/aol\.com$/i],
    smtp: { host: 'smtp.aol.com', port: 465, security: 'ssl' }
  },
  {
    id: 'yandex',
    label: 'Yandex Mail',
    domainPatterns: [/^yandex\.[a-z.]+$/i],
    mxPatterns: [/yandex\.[a-z.]+$/i],
    smtp: { host: 'smtp.yandex.com', port: 465, security: 'ssl' }
  }
]

// Transporter cacheado: se invalida cuando cambia la configuración guardada.
let cachedTransporter = null
let cachedTransporterSignature = ''
let smtpTransportFactory = (options) => nodemailer.createTransport(options)
let emailMxResolver = (domain) => dns.resolveMx(domain)

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function limitString(value, maxLength) {
  const normalized = cleanString(value)
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized
}

function escapeHtml(value) {
  return cleanString(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;')
}

function decodeHtmlEntities(value) {
  return cleanString(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  const normalized = cleanString(value).toLowerCase()
  if (['true', '1', 'yes', 'si', 'sí'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  return fallback
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

function normalizeHostname(value) {
  return cleanString(value).toLowerCase().replace(/\.$/, '')
}

function normalizeSecurity(value, port) {
  const security = cleanString(value).toLowerCase()
  if (SMTP_SECURITY_TYPES.has(security)) return security
  return Number(port) === 465 ? 'ssl' : 'starttls'
}

function getEmailDomain(email) {
  const value = cleanString(email).toLowerCase()
  const atIndex = value.lastIndexOf('@')
  return atIndex >= 0 ? normalizeHostname(value.slice(atIndex + 1)) : ''
}

function sanitizeMxRecords(records = []) {
  return records
    .map(record => ({
      exchange: normalizeHostname(record?.exchange),
      priority: Number.isFinite(Number(record?.priority)) ? Number(record.priority) : 0
    }))
    .filter(record => record.exchange)
    .sort((a, b) => a.priority - b.priority || a.exchange.localeCompare(b.exchange))
}

async function resolveMxRecords(domain) {
  try {
    const records = await emailMxResolver(domain)
    return { records: sanitizeMxRecords(records), error: null }
  } catch (error) {
    return {
      records: [],
      error: cleanString(error?.code || error?.message) || 'MX_LOOKUP_FAILED'
    }
  }
}

function providerMatchesDomain(provider, domain) {
  return (provider.domainPatterns || []).some(pattern => pattern.test(domain))
}

function providerMatchesMx(provider, mxRecords) {
  return mxRecords.some(record =>
    (provider.mxPatterns || []).some(pattern => pattern.test(record.exchange))
  )
}

function findKnownProvider(domain, mxRecords) {
  const mx = EMAIL_PROVIDER_DEFINITIONS.find(provider => providerMatchesMx(provider, mxRecords))
  if (mx) return { provider: mx, detectedBy: 'mx' }

  const direct = EMAIL_PROVIDER_DEFINITIONS.find(provider => providerMatchesDomain(provider, domain))
  if (direct) return { provider: direct, detectedBy: 'domain' }

  return null
}

function buildFallbackProvider(domain, mxRecords) {
  const domainMx = mxRecords.find(record =>
    record.exchange === `mail.${domain}` || record.exchange.endsWith(`.${domain}`)
  )
  const firstMailMx = mxRecords.find(record => record.exchange.startsWith('mail.'))
  const host = domainMx?.exchange || firstMailMx?.exchange || `smtp.${domain}`

  return {
    id: 'custom_smtp',
    label: 'SMTP del dominio',
    detectedBy: mxRecords.length ? 'mx' : 'domain',
    smtp: { host, port: 587, security: 'starttls' }
  }
}

function buildDetectionResponse({ email, domain, mxRecords, mxError, match }) {
  const provider = match
    ? {
        id: match.provider.id,
        label: match.provider.label,
        detectedBy: match.detectedBy,
        confidence: 'high'
      }
    : {
        id: 'custom_smtp',
        label: 'SMTP del dominio',
        detectedBy: mxRecords.length ? 'mx' : 'domain',
        confidence: 'medium'
      }
  const smtp = match?.provider.smtp || buildFallbackProvider(domain, mxRecords).smtp

  return {
    email,
    domain,
    provider,
    smtp: {
      host: smtp.host,
      port: Number(smtp.port) || 587,
      security: normalizeSecurity(smtp.security, smtp.port),
      username: email,
      usernameMasked: maskUsername(email)
    },
    mx: {
      checked: true,
      found: mxRecords.length > 0,
      records: mxRecords,
      error: mxError
    }
  }
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

async function readStoredSignatureConfig() {
  const raw = await getAppConfig(EMAIL_SIGNATURE_CONFIG_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isSafeSignatureUrl(value, type = 'href') {
  const url = cleanString(value)
  if (!url) return false
  if (/[\u0000-\u001f<>"`]/.test(url)) return false
  if (type === 'src' && /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(url)) {
    return url.length <= SIGNATURE_IMAGE_LIMIT
  }
  if (type === 'href' && /^(mailto:|tel:|#)/i.test(url)) return true
  return /^https?:\/\//i.test(url)
}

function sanitizeSignatureStyle(value) {
  const style = cleanString(value)
  if (!style) return ''

  return style
    .split(';')
    .map(rule => rule.trim())
    .filter(Boolean)
    .map(rule => {
      const separatorIndex = rule.indexOf(':')
      if (separatorIndex <= 0) return ''
      const property = rule.slice(0, separatorIndex).trim().toLowerCase()
      const propertyValue = rule.slice(separatorIndex + 1).trim()
      if (!ALLOWED_SIGNATURE_STYLE_PROPS.has(property)) return ''
      if (!propertyValue || /url\s*\(|expression\s*\(|javascript:|@import|[{}<>]/i.test(propertyValue)) return ''
      return `${property}: ${propertyValue}`
    })
    .filter(Boolean)
    .join('; ')
}

function sanitizeSignatureAttributes(tagName, rawAttributes = '') {
  const attrs = []
  const attrPattern = /([a-z0-9:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi
  let match = null

  while ((match = attrPattern.exec(rawAttributes)) !== null) {
    const name = cleanString(match[1]).toLowerCase()
    const value = cleanString(match[3] ?? match[4] ?? match[5] ?? '')
    if (!name || name.startsWith('on')) continue

    if (name === 'style') {
      const style = sanitizeSignatureStyle(value)
      if (style) attrs.push(`style="${escapeAttribute(style)}"`)
      continue
    }

    if (tagName === 'a' && name === 'href' && isSafeSignatureUrl(value, 'href')) {
      attrs.push(`href="${escapeAttribute(value)}"`)
      attrs.push('target="_blank"')
      attrs.push('rel="noreferrer"')
      continue
    }

    if (tagName === 'img' && name === 'src' && isSafeSignatureUrl(value, 'src')) {
      attrs.push(`src="${escapeAttribute(value)}"`)
      continue
    }

    if (tagName === 'img' && name === 'alt') {
      attrs.push(`alt="${escapeAttribute(value).slice(0, 160)}"`)
      continue
    }

    if (tagName === 'img' && ['width', 'height'].includes(name)) {
      const numericValue = Math.max(1, Math.min(Number(value) || 0, 800))
      if (numericValue) attrs.push(`${name}="${numericValue}"`)
      continue
    }

    if (name === 'title') {
      attrs.push(`title="${escapeAttribute(value).slice(0, 160)}"`)
    }
  }

  return attrs.length ? ` ${[...new Set(attrs)].join(' ')}` : ''
}

function sanitizeEmailSignatureHtml(html) {
  let value = limitString(html, SIGNATURE_HTML_LIMIT)
  if (!value) return ''

  value = value
    .replace(/\0/g, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|meta|link|base)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|form|input|button|textarea|select|meta|link|base)[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src)\s*=\s*("|\')?\s*javascript:[^'">\s]*(\2)?/gi, '')

  value = value.replace(/<\/?([a-z0-9-]+)(\s[^>]*)?>/gi, (match, tagName, rawAttributes = '') => {
    const normalizedTag = cleanString(tagName).toLowerCase()
    if (!ALLOWED_SIGNATURE_TAGS.has(normalizedTag)) return ''

    const isClosing = /^<\s*\//.test(match)
    if (isClosing) return VOID_SIGNATURE_TAGS.has(normalizedTag) ? '' : `</${normalizedTag}>`

    const attributes = sanitizeSignatureAttributes(normalizedTag, rawAttributes)
    return VOID_SIGNATURE_TAGS.has(normalizedTag)
      ? `<${normalizedTag}${attributes}>`
      : `<${normalizedTag}${attributes}>`
  })

  return value.trim()
}

function signatureHtmlToText(html) {
  return limitString(
    decodeHtmlEntities(
      cleanString(html)
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\s*hr\s*\/?>/gi, '\n---\n')
        .replace(/<\s*\/\s*(p|div|tr|li|blockquote)\s*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
    ),
    SIGNATURE_TEXT_LIMIT
  )
}

function normalizeEmailSignatureConfig(payload = {}, previous = null) {
  const html = sanitizeEmailSignatureHtml(payload.html ?? payload.signatureHtml ?? previous?.html ?? '')
  const text = limitString(
    cleanString(payload.text ?? payload.plainText) || signatureHtmlToText(html),
    SIGNATURE_TEXT_LIMIT
  )

  return {
    enabled: toBoolean(payload.enabled, previous?.enabled || false),
    html,
    text,
    includeBeforeQuotedText: toBoolean(
      payload.includeBeforeQuotedText,
      previous?.includeBeforeQuotedText ?? true
    ),
    updatedAt: payload.updatedAt || previous?.updatedAt || null
  }
}

function buildSignatureHtml(signature) {
  if (!signature?.enabled || !cleanString(signature.html)) return ''
  return `<div data-ristak-email-signature="true" style="margin-top: 18px;">${signature.html}</div>`
}

function insertSignatureBeforeQuotedHtml(html, signatureHtml) {
  const original = cleanString(html)
  if (!original || !signatureHtml) return original

  const quotedMatch = original.match(/<(blockquote|div)[^>]*(gmail_quote|moz-cite-prefix|yahoo_quoted|protonmail_quote|data-quoted|class=["'][^"']*quote[^"']*)[^>]*>/i)
  if (quotedMatch?.index && quotedMatch.index > 0) {
    return `${original.slice(0, quotedMatch.index)}${signatureHtml}${original.slice(quotedMatch.index)}`
  }

  const blockquoteIndex = original.search(/<blockquote\b/i)
  if (blockquoteIndex > 0) {
    return `${original.slice(0, blockquoteIndex)}${signatureHtml}${original.slice(blockquoteIndex)}`
  }

  return `${original}${signatureHtml}`
}

function applySignatureToMessage(message, signature) {
  const signatureHtml = buildSignatureHtml(signature)
  if (!signatureHtml) return message

  const baseHtml = cleanString(message.html)
  const baseText = cleanString(message.text)
  const signatureText = cleanString(signature.text) || signatureHtmlToText(signature.html)

  return {
    ...message,
    html: baseHtml
      ? (signature.includeBeforeQuotedText ? insertSignatureBeforeQuotedHtml(baseHtml, signatureHtml) : `${baseHtml}${signatureHtml}`)
      : undefined,
    text: baseText && signatureText ? `${baseText}\n\n-- \n${signatureText}` : (message.text || undefined)
  }
}

async function clearEmailCredentials() {
  await clearEmailIntegrationCredentials()
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
    return `El servidor "${host}" no existe. Ristak no pudo alcanzarlo; abre Avanzado si tu proveedor usa otro servidor.${suggestion}`
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
  const security = normalizeSecurity(config.security, port)
  return smtpTransportFactory({
    host: config.host,
    port,
    secure: security === 'ssl',
    requireTLS: security === 'starttls',
    ignoreTLS: security === 'none',
    auth: {
      user: config.username,
      pass: password
    }
  })
}

async function getTransporter(config, password) {
  const signature = JSON.stringify([config.host, config.port, config.security, config.username, password])
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

function formatFromAddress(config) {
  const fromEmail = config.fromEmail || config.username
  const fromName = cleanString(config.fromName).replace(/"/g, '\\"')
  return fromName ? `"${fromName}" <${fromEmail}>` : fromEmail
}

function buildConnectionTestMessage(config, to) {
  return {
    from: formatFromAddress(config),
    to,
    subject: 'Correo de prueba de Ristak',
    text: 'Tu cuenta de correo quedó conectada a Ristak. Este envío confirma que la conexión funciona.',
    html: `
      <div style="font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 12px;">Tu correo está conectado</h2>
        <p style="margin: 0 0 8px; line-height: 1.5;">
          Este es un envío de prueba desde <strong>Ristak</strong> usando
          <strong>${config.fromEmail || config.username}</strong>.
        </p>
        <p style="margin: 0; font-size: 13px;">Si recibiste este correo, la configuración funciona correctamente.</p>
      </div>
    `
  }
}

async function sendMailWithTransporter(transporter, config, message) {
  const result = await transporter.sendMail({
    from: message.from || formatFromAddress(config),
    to: message.to,
    subject: cleanString(message.subject),
    text: cleanString(message.text) || undefined,
    html: cleanString(message.html) || undefined,
    replyTo: cleanString(message.replyTo) || config.replyTo || undefined
  })

  return {
    messageId: result.messageId || null,
    accepted: result.accepted || [],
    rejected: result.rejected || []
  }
}

async function sendConnectionTestEmail(transporter, config, testTo) {
  const recipient = cleanString(testTo).toLowerCase() || config.fromEmail || config.username
  if (!EMAIL_PATTERN.test(recipient)) throw httpError(400, 'El correo de prueba no es válido')

  const result = await sendMailWithTransporter(
    transporter,
    config,
    buildConnectionTestMessage(config, recipient)
  )

  if (result.rejected.length && !result.accepted.length) {
    throw httpError(400, `El servidor conectó, pero rechazó el correo de prueba para ${recipient}`)
  }

  return result
}

export function setEmailTransportFactoryForTest(factory) {
  smtpTransportFactory = typeof factory === 'function'
    ? factory
    : (options) => nodemailer.createTransport(options)
  invalidateTransporter()
}

export function setEmailMxResolverForTest(resolver) {
  emailMxResolver = typeof resolver === 'function'
    ? resolver
    : (domain) => dns.resolveMx(domain)
}

export async function detectEmailProvider(payload = {}) {
  const email = cleanString(payload.email || payload.fromEmail).toLowerCase()
  if (!EMAIL_PATTERN.test(email)) throw httpError(400, 'Escribe un correo de envío válido')

  const domain = getEmailDomain(email)
  if (!domain) throw httpError(400, 'No se pudo leer el dominio del correo')

  const { records, error } = await resolveMxRecords(domain)
  const match = findKnownProvider(domain, records)
  return buildDetectionResponse({
    email,
    domain,
    mxRecords: records,
    mxError: error,
    match
  })
}

export async function getEmailStatus() {
  let config = await readStoredConfig()
  let hasPassword = Boolean(await getAppConfig(EMAIL_PASSWORD_KEY))

  if (config?.connected === false) {
    await clearEmailCredentials()
    config = null
    hasPassword = false
    invalidateTransporter()
  }

  const configured = Boolean(config?.host && config?.username && hasPassword)
  const connected = Boolean(configured && config?.connected)

  return {
    provider: config?.providerId || 'smtp',
    providerLabel: config?.providerLabel || (connected ? 'SMTP' : ''),
    connected,
    configured,
    smtp: {
      host: config?.host || '',
      port: Number(config?.port) || 587,
      security: normalizeSecurity(config?.security, config?.port),
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

export async function getEmailSignature() {
  const signature = await readStoredSignatureConfig()
  return normalizeEmailSignatureConfig(signature || {})
}

export async function saveEmailSignature(payload = {}) {
  const previous = await readStoredSignatureConfig()
  const signature = {
    ...normalizeEmailSignatureConfig(payload, previous),
    updatedAt: new Date().toISOString()
  }
  await setAppConfig(EMAIL_SIGNATURE_CONFIG_KEY, signature)
  return signature
}

/**
 * Guarda y verifica la conexión SMTP. Hace transporter.verify() contra el
 * servidor antes de marcarla como conectada, para que "conectado" siempre
 * signifique que se puede enviar de verdad.
 */
export async function connectEmail(payload = {}) {
  let previous = await readStoredConfig()
  if (previous?.connected === false) {
    await clearEmailCredentials()
    previous = null
    invalidateTransporter()
  }

  const smtpPayload = payload.smtp && typeof payload.smtp === 'object' ? payload.smtp : {}
  const requestedFromEmail = cleanString(payload.fromEmail).toLowerCase()
  const requestedUsername = cleanString(smtpPayload.username || payload.username).toLowerCase()
  const previousFromEmail = cleanString(previous?.fromEmail).toLowerCase()
  const previousUsername = cleanString(previous?.username).toLowerCase()
  const canReuseStoredCredentials = previous?.connected === true &&
    (!requestedFromEmail || requestedFromEmail === previousFromEmail) &&
    (!requestedUsername || requestedUsername === previousUsername)

  const fromEmail = requestedFromEmail ||
    (canReuseStoredCredentials ? previousFromEmail : '') ||
    requestedUsername
  const fromName = cleanString(payload.fromName) || (canReuseStoredCredentials ? previous?.fromName : '') || ''
  const replyTo = cleanString(payload.replyTo).toLowerCase()

  if (!EMAIL_PATTERN.test(fromEmail)) throw httpError(400, 'El correo del remitente no es válido')
  if (replyTo && !EMAIL_PATTERN.test(replyTo)) throw httpError(400, 'El correo de respuestas no es válido')

  const newPassword = cleanString(payload.password)
  const password = newPassword || (canReuseStoredCredentials ? await readStoredPassword() : '')
  if (!password) throw httpError(400, 'Escribe el password o app password SMTP')
  if (!fromName) throw httpError(400, 'Escribe el nombre del remitente')

  const hasAdvancedSmtp = Boolean(
    cleanString(smtpPayload.host || payload.host) ||
    cleanString(smtpPayload.username || payload.username) ||
    smtpPayload.port ||
    payload.port ||
    cleanString(smtpPayload.security || payload.security)
  )

  let detection = null
  let host = ''
  let port = 587
  let security = 'starttls'
  let username = ''
  let providerId = 'custom_smtp'
  let providerLabel = 'SMTP del dominio'

  if (hasAdvancedSmtp) {
    host = normalizeHostname(smtpPayload.host || payload.host)
    port = Number(smtpPayload.port || payload.port) || 587
    security = normalizeSecurity(smtpPayload.security || payload.security, port)
    username = cleanString(smtpPayload.username || payload.username) || fromEmail
    providerId = cleanString(payload.providerId) || 'custom_smtp'
    providerLabel = cleanString(payload.providerLabel) || 'SMTP manual'
  } else if (canReuseStoredCredentials && previous?.host) {
    host = normalizeHostname(previous.host)
    port = Number(previous.port) || 587
    security = normalizeSecurity(previous.security, port)
    username = previous.username || fromEmail
    providerId = previous.providerId || 'custom_smtp'
    providerLabel = previous.providerLabel || 'SMTP'
  } else {
    detection = await detectEmailProvider({ email: fromEmail })
    host = detection.smtp.host
    port = Number(detection.smtp.port) || 587
    security = normalizeSecurity(detection.smtp.security, port)
    username = detection.smtp.username || fromEmail
    providerId = detection.provider.id
    providerLabel = detection.provider.label
  }

  if (!host) throw httpError(400, 'No se pudo detectar el servidor de correo. Abre Avanzado y escríbelo manualmente.')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'El puerto SMTP no es válido')
  if (!username) throw httpError(400, 'No se pudo definir el usuario SMTP')

  const candidate = {
    host,
    port,
    security,
    username,
    fromEmail,
    fromName,
    replyTo,
    providerId,
    providerLabel
  }
  const transporter = buildTransporter(candidate, password)

  try {
    await transporter.verify()
    await sendConnectionTestEmail(transporter, candidate, payload.testTo)
  } catch (error) {
    logger.warn(`Verificación SMTP fallida para ${host}: ${error.message}`)
    if (error.status) throw error
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
    lastTestAt: now,
    detectedDomain: detection?.domain || getEmailDomain(fromEmail),
    mxRecords: detection?.mx?.records || previous?.mxRecords || [],
    lastError: null
  })
  invalidateTransporter()

  logger.info(`Correo conectado por SMTP (${host}:${port}) como ${maskUsername(username)} con ${providerLabel}`)
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
  const signature = await readStoredSignatureConfig()
  const signedMessage = applySignatureToMessage({
    to: recipient,
    subject,
    text,
    html,
    replyTo
  }, signature)

  try {
    const result = await sendMailWithTransporter(transporter, config, signedMessage)
    return result
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

export async function disconnectEmail() {
  await clearEmailCredentials()
  invalidateTransporter()
  return getEmailStatus()
}

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}
