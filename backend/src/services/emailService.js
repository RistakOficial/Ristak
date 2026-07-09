import { createHash } from 'node:crypto'
import { promises as dns } from 'node:dns'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import PostalMime from 'postal-mime'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { clearEmailIntegrationCredentials } from './integrationCredentialsCleanupService.js'
import { publishChatMessageEvent } from './chatLiveEventsService.js'
import { recordInboundChatUnread } from './chatReadStateService.js'
import { sendChatMessageNotification } from './pushNotificationsService.js'
import { createRistakId } from '../utils/idGenerator.js'
import {
  formatContactName,
  splitContactName as splitFormattedContactName
} from '../utils/contactNameFormatter.js'

// Configuración del remitente de correo de la cuenta.
// El password SMTP se guarda cifrado en una llave separada de app_config.
const EMAIL_CONFIG_KEY = 'email_smtp_config'
const EMAIL_PASSWORD_KEY = 'email_smtp_password'
const EMAIL_SIGNATURE_CONFIG_KEY = 'email_signature_config'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SMTP_SECURITY_TYPES = new Set(['starttls', 'ssl', 'none'])
const IMAP_SECURITY_TYPES = new Set(['starttls', 'ssl', 'none'])
const SIGNATURE_HTML_LIMIT = 70000
const SIGNATURE_TEXT_LIMIT = 8000
const SIGNATURE_IMAGE_LIMIT = 2 * 1024 * 1024
const EMAIL_SUBJECT_LIMIT = 998
const EMAIL_TEXT_LIMIT = 120000
const EMAIL_HTML_LIMIT = 240000
const EMAIL_INBOUND_DEFAULT_MAILBOX = 'INBOX'
const EMAIL_INBOUND_CREATE_CONTACTS_DEFAULT = false
const EMAIL_INBOUND_FIRST_SYNC_LOOKBACK = 50
const EMAIL_INBOUND_FETCH_LIMIT = 50
const EMAIL_INBOUND_SOURCE_LIMIT = 1024 * 1024
const ALLOWED_SIGNATURE_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'div',
  'em',
  'font',
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
    smtp: { host: 'smtp.gmail.com', port: 587, security: 'starttls' },
    imap: { host: 'imap.gmail.com', port: 993, security: 'ssl' }
  },
  {
    id: 'microsoft',
    label: 'Microsoft 365 / Outlook',
    domainPatterns: [/^(outlook|hotmail|live|msn)\.com$/i],
    mxPatterns: [/protection\.outlook\.com$/i, /outlook\.com$/i],
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
    imap: { host: 'outlook.office365.com', port: 993, security: 'ssl' }
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    domainPatterns: [/^(yahoo|ymail|rocketmail)\.com$/i],
    mxPatterns: [/yahoodns\.net$/i, /yahoo\.com$/i],
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'ssl' },
    imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'ssl' }
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    domainPatterns: [/^(icloud|me|mac)\.com$/i],
    mxPatterns: [/mail\.icloud\.com$/i],
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    imap: { host: 'imap.mail.me.com', port: 993, security: 'ssl' }
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    domainPatterns: [/^zoho\.[a-z.]+$/i],
    mxPatterns: [/zoho\.[a-z.]+$/i, /zohomail\.[a-z.]+$/i],
    smtp: { host: 'smtp.zoho.com', port: 465, security: 'ssl' },
    imap: { host: 'imap.zoho.com', port: 993, security: 'ssl' }
  },
  {
    id: 'godaddy',
    label: 'GoDaddy / Microsoft email',
    mxPatterns: [/secureserver\.net$/i],
    smtp: { host: 'smtpout.secureserver.net', port: 465, security: 'ssl' },
    imap: { host: 'imap.secureserver.net', port: 993, security: 'ssl' }
  },
  {
    id: 'titan',
    label: 'Titan Email',
    mxPatterns: [/titan\.email$/i],
    smtp: { host: 'smtp.titan.email', port: 465, security: 'ssl' },
    imap: { host: 'imap.titan.email', port: 993, security: 'ssl' }
  },
  {
    id: 'privateemail',
    label: 'Namecheap Private Email',
    mxPatterns: [/privateemail\.com$/i],
    smtp: { host: 'mail.privateemail.com', port: 465, security: 'ssl' },
    imap: { host: 'mail.privateemail.com', port: 993, security: 'ssl' }
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    domainPatterns: [/^fastmail\.[a-z.]+$/i],
    mxPatterns: [/messagingengine\.com$/i],
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'ssl' },
    imap: { host: 'imap.fastmail.com', port: 993, security: 'ssl' }
  },
  {
    id: 'aol',
    label: 'AOL Mail',
    domainPatterns: [/^aol\.com$/i],
    mxPatterns: [/aol\.com$/i],
    smtp: { host: 'smtp.aol.com', port: 465, security: 'ssl' },
    imap: { host: 'imap.aol.com', port: 993, security: 'ssl' }
  },
  {
    id: 'yandex',
    label: 'Yandex Mail',
    domainPatterns: [/^yandex\.[a-z.]+$/i],
    mxPatterns: [/yandex\.[a-z.]+$/i],
    smtp: { host: 'smtp.yandex.com', port: 465, security: 'ssl' },
    imap: { host: 'imap.yandex.com', port: 993, security: 'ssl' }
  }
]

// Transporter cacheado: se invalida cuando cambia la configuración guardada.
let cachedTransporter = null
let cachedTransporterSignature = ''
let smtpTransportFactory = (options) => nodemailer.createTransport(options)
let emailMxResolver = (domain) => dns.resolveMx(domain)
let imapClientFactory = (options) => new ImapFlow(options)
let emailMimeParser = (source) => PostalMime.parse(source, {
  attachmentEncoding: 'arraybuffer',
  maxNestingDepth: 3,
  maxHeadersSize: 256 * 1024
})

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

function textToEmailHtml(value) {
  return cleanString(value)
    .split(/\n{2,}/)
    .map(paragraph => paragraph.split(/\n/).map(escapeHtml).join('<br>'))
    .filter(Boolean)
    .map(paragraph => `<p>${paragraph}</p>`)
    .join('')
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

function normalizeImapSecurity(value, port) {
  const security = cleanString(value).toLowerCase()
  if (IMAP_SECURITY_TYPES.has(security)) return security
  return Number(port) === 993 ? 'ssl' : 'starttls'
}

function getEmailDomain(email) {
  const value = cleanString(email).toLowerCase()
  const atIndex = value.lastIndexOf('@')
  return atIndex >= 0 ? normalizeHostname(value.slice(atIndex + 1)) : ''
}

function buildEmailMessageId(externalId) {
  const normalized = cleanString(externalId)
  if (/^[A-Za-z0-9:_-]{1,140}$/.test(normalized)) return normalized
  return createRistakId('email')
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
  const imapHost = host.startsWith('smtp.') ? `imap.${domain}` : host

  return {
    id: 'custom_smtp',
    label: 'SMTP del dominio',
    detectedBy: mxRecords.length ? 'mx' : 'domain',
    smtp: { host, port: 587, security: 'starttls' },
    imap: { host: imapHost, port: 993, security: 'ssl' }
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
  const fallbackProvider = buildFallbackProvider(domain, mxRecords)
  const smtp = match?.provider.smtp || fallbackProvider.smtp
  const imap = match?.provider.imap || fallbackProvider.imap

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
    imap: {
      host: imap.host,
      port: Number(imap.port) || 993,
      security: normalizeImapSecurity(imap.security, imap.port),
      username: email,
      usernameMasked: maskUsername(email),
      mailbox: EMAIL_INBOUND_DEFAULT_MAILBOX
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

function legacyFontSizeToCss(value) {
  const sizes = {
    '1': '10px',
    '2': '12px',
    '3': '14px',
    '4': '16px',
    '5': '18px',
    '6': '24px',
    '7': '32px'
  }
  return sizes[cleanString(value)] || ''
}

function sanitizeSignatureAttributes(tagName, rawAttributes = '') {
  const attrs = []
  let styleValue = ''
  const attrPattern = /([a-z0-9:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi
  let match = null

  while ((match = attrPattern.exec(rawAttributes)) !== null) {
    const name = cleanString(match[1]).toLowerCase()
    const value = cleanString(match[3] ?? match[4] ?? match[5] ?? '')
    if (!name || name.startsWith('on')) continue

    if (name === 'style') {
      styleValue = [styleValue, value].filter(Boolean).join('; ')
      continue
    }

    if (tagName === 'font' && name === 'face' && value) {
      styleValue = [styleValue, `font-family: ${value}`].filter(Boolean).join('; ')
      continue
    }

    if (tagName === 'font' && name === 'size') {
      const fontSize = legacyFontSizeToCss(value)
      if (fontSize) styleValue = [styleValue, `font-size: ${fontSize}`].filter(Boolean).join('; ')
      continue
    }

    if (tagName === 'font' && name === 'color' && value) {
      styleValue = [styleValue, `color: ${value}`].filter(Boolean).join('; ')
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

  const style = sanitizeSignatureStyle(styleValue)
  if (style) attrs.unshift(`style="${escapeAttribute(style)}"`)

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

async function getContactEmailRecipient(contactId, fallbackTo) {
  const cleanContactId = cleanString(contactId)
  const fallbackRecipient = cleanString(fallbackTo).toLowerCase()
  if (!cleanContactId) return { contact: null, recipient: fallbackRecipient }

  const contact = await db.get('SELECT id, email, full_name, first_name, last_name FROM contacts WHERE id = ?', [cleanContactId])
  if (!contact) throw httpError(404, 'Contacto no encontrado')

  return {
    contact,
    recipient: cleanString(contact.email).toLowerCase() || fallbackRecipient
  }
}

async function saveEmailMessageRow(row) {
  await db.run(`
    INSERT INTO email_messages (
      id, contact_id, direction, status, to_email, from_email, reply_to,
      subject, message_text, html_body, smtp_message_id, error_message,
      message_timestamp, raw_payload_json, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      contact_id = excluded.contact_id,
      direction = excluded.direction,
      status = excluded.status,
      to_email = excluded.to_email,
      from_email = excluded.from_email,
      reply_to = excluded.reply_to,
      subject = excluded.subject,
      message_text = excluded.message_text,
      html_body = excluded.html_body,
      smtp_message_id = excluded.smtp_message_id,
      error_message = excluded.error_message,
      message_timestamp = excluded.message_timestamp,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    row.id,
    row.contactId || null,
    row.direction || 'outbound',
    row.status || 'sending',
    row.toEmail || '',
    row.fromEmail || '',
    row.replyTo || '',
    row.subject || '',
    row.text || '',
    row.html || '',
    row.smtpMessageId || '',
    row.errorMessage || '',
    row.messageTimestamp || new Date().toISOString(),
    row.rawPayloadJson || null
  ])
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

function toPort(value, fallback) {
  const port = Number(value) || fallback
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 0
  return port
}

function getStoredInboundConfig(config) {
  return config?.inbound && typeof config.inbound === 'object' ? config.inbound : {}
}

function normalizeMailbox(value) {
  return cleanString(value) || EMAIL_INBOUND_DEFAULT_MAILBOX
}

function normalizeInboundCreateContacts(value) {
  return toBoolean(value, EMAIL_INBOUND_CREATE_CONTACTS_DEFAULT)
}

function normalizeInboundCandidate({
  inboundPayload = {},
  previous = null,
  detection = null,
  fromEmail,
  smtpUsername
} = {}) {
  const storedInbound = getStoredInboundConfig(previous)
  const normalizedFromEmail = cleanString(fromEmail).toLowerCase()
  const previousIdentities = [
    previous?.fromEmail,
    previous?.username,
    storedInbound?.username
  ].map(value => cleanString(value).toLowerCase()).filter(Boolean)
  const canReusePreviousInbound = previous?.connected === true &&
    normalizedFromEmail &&
    previousIdentities.includes(normalizedFromEmail)
  const previousInbound = canReusePreviousInbound ? storedInbound : {}
  const hasInboundPayload = inboundPayload && typeof inboundPayload === 'object' && Object.keys(inboundPayload).length > 0
  const hasExplicitInboundEnabled = Object.prototype.hasOwnProperty.call(inboundPayload || {}, 'enabled')
  const hasPreviousInboundPreference = Object.prototype.hasOwnProperty.call(previousInbound || {}, 'enabled')
  const createContactsFromUnknownSenders = Object.prototype.hasOwnProperty.call(inboundPayload || {}, 'createContactsFromUnknownSenders')
    ? normalizeInboundCreateContacts(inboundPayload.createContactsFromUnknownSenders)
    : Object.prototype.hasOwnProperty.call(previousInbound || {}, 'createContactsFromUnknownSenders')
      ? normalizeInboundCreateContacts(previousInbound.createContactsFromUnknownSenders)
      : EMAIL_INBOUND_CREATE_CONTACTS_DEFAULT
  const enabled = hasExplicitInboundEnabled
    ? toBoolean(inboundPayload.enabled, true)
    : hasPreviousInboundPreference
      ? toBoolean(previousInbound.enabled, true)
      : true

  if (!enabled) {
    return {
      ...previousInbound,
      enabled: false,
      createContactsFromUnknownSenders
    }
  }

  const fallbackDomain = getEmailDomain(fromEmail)
  const fallbackHost = fallbackDomain ? `imap.${fallbackDomain}` : ''
  const host = normalizeHostname(inboundPayload.host || previousInbound.host || detection?.imap?.host || fallbackHost)
  const port = toPort(inboundPayload.port || previousInbound.port || detection?.imap?.port, 993)
  const security = normalizeImapSecurity(inboundPayload.security || previousInbound.security || detection?.imap?.security, port)
  const username = cleanString(inboundPayload.username || previousInbound.username || detection?.imap?.username || smtpUsername || fromEmail).toLowerCase()
  const mailbox = normalizeMailbox(inboundPayload.mailbox || previousInbound.mailbox)

  if (!host) throw httpError(400, 'No se pudo definir el servidor IMAP para recibir correos')
  if (!port) throw httpError(400, 'El puerto IMAP no es válido')
  if (!username) throw httpError(400, 'No se pudo definir el usuario IMAP')
  if (!mailbox) throw httpError(400, 'No se pudo definir la bandeja IMAP')

  return {
    enabled: true,
    host,
    port,
    security,
    username,
    usernameMasked: maskUsername(username),
    mailbox,
    createContactsFromUnknownSenders,
    lastSeenUid: Number(previousInbound.lastSeenUid) > 0 ? Number(previousInbound.lastSeenUid) : null,
    lastSyncAt: previousInbound.lastSyncAt || null,
    lastVerifiedAt: previousInbound.lastVerifiedAt || null,
    lastMessageAt: previousInbound.lastMessageAt || null,
    lastError: null
  }
}

function buildImapClientOptions(inboundConfig, password) {
  const security = normalizeImapSecurity(inboundConfig.security, inboundConfig.port)
  return {
    host: inboundConfig.host,
    port: Number(inboundConfig.port) || 993,
    secure: security === 'ssl',
    doSTARTTLS: security === 'starttls' ? true : (security === 'none' ? false : undefined),
    auth: {
      user: inboundConfig.username,
      pass: password
    },
    logger: false
  }
}

async function closeImapClient(client) {
  if (!client || typeof client.logout !== 'function') return
  await client.logout().catch(() => undefined)
}

function friendlyImapError(error, host) {
  const code = String(error?.code || '').toUpperCase()
  const response = cleanString(error?.response || error?.message)

  if (code === 'EAUTH' || /AUTHENTICATIONFAILED|AUTHENTICATE|LOGIN|Invalid credentials|authentication/i.test(response)) {
    return 'IMAP rechazó el usuario o app password. Revisa que IMAP esté habilitado en tu proveedor y que el app password tenga acceso al correo.'
  }

  if (code === 'ENOTFOUND' || /ENOTFOUND/i.test(response)) {
    return `El servidor IMAP "${host}" no existe. Revisa la configuración de recepción en Avanzado.`
  }

  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || /timeout|timed out|ECONNREFUSED/i.test(response)) {
    return `No se pudo abrir IMAP en "${host}". Revisa host, puerto y seguridad.`
  }

  if (error?.tlsFailed || /certificate|TLS|SSL/i.test(response)) {
    return `IMAP respondió con error de TLS/SSL en "${host}". Revisa si debe ser SSL/TLS o STARTTLS.`
  }

  return `No se pudo conectar IMAP en "${host}": ${response || 'error desconocido'}`
}

async function verifyInboundConnection(inboundConfig, password) {
  if (!inboundConfig?.enabled) return null
  if (!password) throw httpError(400, 'Escribe el password o app password para probar IMAP')

  const client = imapClientFactory(buildImapClientOptions(inboundConfig, password))
  try {
    await client.connect()
    const mailbox = await client.mailboxOpen(normalizeMailbox(inboundConfig.mailbox), { readOnly: true })
    await closeImapClient(client)
    return {
      mailbox: mailbox?.path || inboundConfig.mailbox || EMAIL_INBOUND_DEFAULT_MAILBOX,
      exists: Number(mailbox?.exists) || 0,
      uidNext: Number(mailbox?.uidNext) || null,
      verifiedAt: new Date().toISOString()
    }
  } catch (error) {
    await closeImapClient(client)
    throw httpError(400, friendlyImapError(error, inboundConfig.host))
  }
}

function getInitialInboundCursor(verification, previousInbound = {}) {
  const stored = Number(previousInbound.lastSeenUid) || 0
  if (stored > 0) return stored

  const uidNext = Number(verification?.uidNext) || 0
  if (uidNext > 1) return Math.max(0, uidNext - EMAIL_INBOUND_FIRST_SYNC_LOOKBACK - 1)

  return null
}

function hashInboundMessageId(input = {}) {
  const basis = [
    input.mailbox,
    input.uid,
    input.messageId,
    input.emailId,
    input.fromEmail,
    input.subject,
    input.messageTimestamp
  ].map(cleanString).join('|')
  return `email_in_${createHash('sha256').update(basis || String(Date.now())).digest('hex').slice(0, 32)}`
}

function flattenEmailAddresses(value) {
  const input = Array.isArray(value) ? value : (value ? [value] : [])
  const result = []

  for (const item of input) {
    if (!item) continue
    if (Array.isArray(item.group)) {
      result.push(...flattenEmailAddresses(item.group))
      continue
    }

    const address = cleanString(item.address).toLowerCase()
    if (EMAIL_PATTERN.test(address)) {
      result.push({
        name: cleanString(item.name),
        address
      })
    }
  }

  return result
}

function parseEmailDate(parsed, internalDate) {
  const parsedDate = Date.parse(cleanString(parsed?.date))
  if (Number.isFinite(parsedDate)) return new Date(parsedDate).toISOString()

  const internalTime = internalDate ? new Date(internalDate).getTime() : NaN
  if (Number.isFinite(internalTime)) return new Date(internalTime).toISOString()

  return new Date().toISOString()
}

function splitContactName(name) {
  return splitFormattedContactName(limitString(name, 180))
}

async function findContactByEmail(email) {
  const cleanEmail = cleanString(email).toLowerCase()
  if (!EMAIL_PATTERN.test(cleanEmail)) return null

  return db.get(
    `SELECT id, full_name, first_name, last_name, email, phone, source
     FROM contacts
     WHERE LOWER(TRIM(email)) = ?
       AND deleted_at IS NULL
     LIMIT 1`,
    [cleanEmail]
  )
}

async function findOrCreateContactForInboundEmail({ email, name, createIfMissing = EMAIL_INBOUND_CREATE_CONTACTS_DEFAULT }) {
  const cleanEmail = cleanString(email).toLowerCase()
  if (!EMAIL_PATTERN.test(cleanEmail)) return null

  const existing = await findContactByEmail(cleanEmail)
  if (existing?.id) return { contact: existing, created: false }

  if (!createIfMissing) {
    return { contact: null, created: false, skipped: true, reason: 'unknown_contact_auto_create_disabled' }
  }

  const id = createRistakId('contact')
  const fullName = formatContactName(limitString(name, 180)) || cleanEmail
  const { firstName, lastName } = splitContactName(fullName === cleanEmail ? '' : fullName)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, email, full_name, first_name, last_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      id,
      cleanEmail,
      fullName,
      firstName || null,
      lastName || null,
      'email_inbound'
    ])
  } catch (error) {
    const duplicate = await findContactByEmail(cleanEmail).catch(() => null)
    if (duplicate?.id) return { contact: duplicate, created: false }
    throw error
  }

  const contact = await db.get(
    `SELECT id, full_name, first_name, last_name, email, phone, source
     FROM contacts
     WHERE id = ?`,
    [id]
  )
  return { contact, created: true }
}

function pickInboundBody(parsed) {
  const text = limitString(parsed?.text || '', EMAIL_TEXT_LIMIT)
  const html = limitString(parsed?.html || '', EMAIL_HTML_LIMIT)

  if (text || html) return { text, html }

  return {
    text: '',
    html: ''
  }
}

async function saveInboundEmailFromImap({ imapMessage, parsed, config }) {
  const mailbox = normalizeMailbox(config?.inbound?.mailbox)
  const fromAddresses = flattenEmailAddresses(parsed?.from)
  const toAddresses = flattenEmailAddresses(parsed?.to)
  const replyToAddresses = flattenEmailAddresses(parsed?.replyTo)
  const from = fromAddresses[0]
  if (!from?.address) return { saved: 0, skipped: true, reason: 'missing_from' }

  const contactResult = await findOrCreateContactForInboundEmail({
    email: from.address,
    name: from.name,
    createIfMissing: normalizeInboundCreateContacts(config?.inbound?.createContactsFromUnknownSenders)
  })
  const contact = contactResult?.contact
  if (!contact?.id) {
    return {
      saved: 0,
      skipped: true,
      reason: contactResult?.reason || 'missing_contact',
      uid: Number(imapMessage.uid) || null
    }
  }

  const messageTimestamp = parseEmailDate(parsed, imapMessage.internalDate)
  const subject = limitString(parsed?.subject || '', EMAIL_SUBJECT_LIMIT)
  const { text, html } = pickInboundBody(parsed)
  const messageId = cleanString(parsed?.messageId)
  const localMessageId = hashInboundMessageId({
    mailbox,
    uid: imapMessage.uid,
    messageId,
    emailId: imapMessage.emailId,
    fromEmail: from.address,
    subject,
    messageTimestamp
  })
  const existing = await db.get('SELECT id FROM email_messages WHERE id = ?', [localMessageId])
  const isNew = !existing
  const rawPayload = safeJsonStringify({
    provider: 'imap',
    source: 'email_inbound_sync',
    mailbox,
    uid: imapMessage.uid || null,
    emailId: imapMessage.emailId || null,
    threadId: imapMessage.threadId || null,
    flags: imapMessage.flags ? [...imapMessage.flags] : [],
    messageId,
    attachments: Array.isArray(parsed?.attachments) ? parsed.attachments.length : 0,
    sourceTruncated: Buffer.isBuffer(imapMessage.source) && imapMessage.source.length >= EMAIL_INBOUND_SOURCE_LIMIT
  })

  await saveEmailMessageRow({
    id: localMessageId,
    contactId: contact.id,
    direction: 'inbound',
    status: 'delivered',
    toEmail: toAddresses.map(item => item.address).join(', '),
    fromEmail: from.address,
    replyTo: replyToAddresses.map(item => item.address).join(', '),
    subject,
    text,
    html,
    smtpMessageId: messageId,
    messageTimestamp,
    rawPayloadJson: rawPayload
  })

  if (isNew) {
    recordInboundChatUnread({
      contactId: contact.id,
      messageTimestamp
    }).catch(error => {
      logger.warn(`[Correo IMAP] No se pudo incrementar unread ${localMessageId}: ${error.message}`)
    })

    sendChatMessageNotification({
      contactId: contact.id,
      contactName: contact.full_name || from.name || from.address,
      text: text || subject || 'Nuevo correo',
      messageType: 'email',
      messageId: localMessageId,
      timestamp: messageTimestamp
    }).catch(error => {
      logger.warn(`[Correo IMAP] No se pudo notificar ${localMessageId}: ${error.message}`)
    })

    import('../agents/conversational/runner.js')
      .then(runner => runner.handleInboundConversationalEmailMessage({
        contactId: contact.id,
        messageId: localMessageId
      }))
      .catch(error => {
        logger.warn(`[Agente conversacional] Correo IMAP no atendido: ${error.message}`)
      })
  }

  publishChatMessageEvent({
    contactId: contact.id,
    messageId: localMessageId,
    channel: 'email',
    provider: 'imap',
    transport: 'imap',
    direction: 'inbound',
    messageType: 'email',
    messageTimestamp,
    isNew
  })

  return {
    saved: 1,
    isNew,
    contactId: contact.id,
    messageId: localMessageId,
    uid: Number(imapMessage.uid) || null,
    messageTimestamp
  }
}

async function setInboundConfigPatch(patch = {}) {
  const config = await readStoredConfig()
  if (!config) return null

  const inbound = {
    ...getStoredInboundConfig(config),
    ...patch
  }
  await setAppConfig(EMAIL_CONFIG_KEY, { ...config, inbound })
  return inbound
}

let inboundSyncRunning = false

export async function syncInboundEmailOnce({ reason = 'manual' } = {}) {
  if (inboundSyncRunning) {
    return { skipped: true, reason: 'already_running', imported: 0 }
  }

  inboundSyncRunning = true
  const startedAt = new Date().toISOString()

  try {
    const config = await readStoredConfig()
    const inbound = getStoredInboundConfig(config)
    const password = await readStoredPassword()

    if (!config?.connected || !inbound?.enabled || !inbound.host || !inbound.username || !password) {
      return { skipped: true, reason: 'not_configured', imported: 0 }
    }

    const client = imapClientFactory(buildImapClientOptions(inbound, password))
    let imported = 0
    let seen = 0
    let maxUid = Number(inbound.lastSeenUid) || 0
    let lastMessageAt = inbound.lastMessageAt || null

    try {
      await client.connect()
      const mailbox = await client.mailboxOpen(normalizeMailbox(inbound.mailbox), { readOnly: true })
      const uidNext = Number(mailbox?.uidNext) || 0
      const currentLastSeen = Number(inbound.lastSeenUid) || 0
      const startUid = currentLastSeen > 0
        ? currentLastSeen + 1
        : Math.max(1, uidNext - EMAIL_INBOUND_FIRST_SYNC_LOOKBACK)
      const endUid = uidNext > 1 ? uidNext - 1 : '*'

      if (uidNext > 1 && startUid > endUid) {
        await setInboundConfigPatch({
          ...inbound,
          mailbox: mailbox?.path || inbound.mailbox,
          lastSyncAt: new Date().toISOString(),
          lastVerifiedAt: inbound.lastVerifiedAt || startedAt,
          lastError: null
        })
        await closeImapClient(client)
        return { skipped: false, reason, imported: 0, seen: 0, lastSeenUid: currentLastSeen }
      }

      const range = `${startUid}:*`
      const messages = []
      for await (const message of client.fetch(range, {
        uid: true,
        emailId: true,
        threadId: true,
        flags: true,
        internalDate: true,
        source: { start: 0, maxLength: EMAIL_INBOUND_SOURCE_LIMIT }
      }, { uid: true })) {
        messages.push(message)
        if (messages.length >= EMAIL_INBOUND_FETCH_LIMIT) break
      }

      await closeImapClient(client)

      for (const message of messages) {
        const uid = Number(message.uid) || 0
        if (uid > maxUid) maxUid = uid
        if (!message.source) continue

        const parsed = await emailMimeParser(message.source)
        const result = await saveInboundEmailFromImap({
          imapMessage: message,
          parsed,
          config: { ...config, inbound: { ...inbound, mailbox: mailbox?.path || inbound.mailbox } }
        })
        seen += 1
        imported += result?.isNew ? 1 : 0
        if (result?.messageTimestamp) lastMessageAt = result.messageTimestamp
      }

      await setInboundConfigPatch({
        ...inbound,
        mailbox: mailbox?.path || inbound.mailbox,
        lastSeenUid: maxUid || currentLastSeen || null,
        lastSyncAt: new Date().toISOString(),
        lastVerifiedAt: inbound.lastVerifiedAt || startedAt,
        lastMessageAt,
        lastError: null
      })

      return {
        skipped: false,
        reason,
        imported,
        seen,
        lastSeenUid: maxUid || currentLastSeen || null,
        lastSyncAt: new Date().toISOString()
      }
    } catch (error) {
      await closeImapClient(client)
      const friendly = friendlyImapError(error, inbound.host)
      await setInboundConfigPatch({
        ...inbound,
        lastSyncAt: new Date().toISOString(),
        lastError: friendly
      })
      logger.warn(`[Correo IMAP] Sincronización fallida (${reason}): ${friendly}`)
      throw httpError(error.status || 502, friendly)
    }
  } finally {
    inboundSyncRunning = false
  }
}

export async function saveInboundEmailSettings(payload = {}) {
  const config = await readStoredConfig()
  if (!config?.connected) throw httpError(400, 'Conecta el correo antes de guardar estos ajustes')

  await setInboundConfigPatch({
    createContactsFromUnknownSenders: normalizeInboundCreateContacts(payload.createContactsFromUnknownSenders)
  })

  return getEmailStatus()
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

export function setEmailImapClientFactoryForTest(factory) {
  imapClientFactory = typeof factory === 'function'
    ? factory
    : (options) => new ImapFlow(options)
}

export function setEmailMimeParserForTest(parser) {
  emailMimeParser = typeof parser === 'function'
    ? parser
    : (source) => PostalMime.parse(source, {
        attachmentEncoding: 'arraybuffer',
        maxNestingDepth: 3,
        maxHeadersSize: 256 * 1024
      })
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
  const inbound = getStoredInboundConfig(config)
  const inboundConfigured = Boolean(inbound?.enabled && inbound.host && inbound.username && hasPassword)

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
    inbound: {
      enabled: Boolean(inbound?.enabled),
      connected: Boolean(connected && inboundConfigured && !inbound.lastError),
      configured: inboundConfigured,
      host: inbound?.host || '',
      port: Number(inbound?.port) || 993,
      security: normalizeImapSecurity(inbound?.security, inbound?.port),
      usernameMasked: maskUsername(inbound?.username),
      mailbox: inbound?.mailbox || EMAIL_INBOUND_DEFAULT_MAILBOX,
      createContactsFromUnknownSenders: normalizeInboundCreateContacts(inbound?.createContactsFromUnknownSenders),
      lastSeenUid: Number(inbound?.lastSeenUid) || null,
      lastSyncAt: inbound?.lastSyncAt || null,
      lastVerifiedAt: inbound?.lastVerifiedAt || null,
      lastMessageAt: inbound?.lastMessageAt || null,
      lastError: inbound?.lastError || null
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
  const inboundCandidate = normalizeInboundCandidate({
    inboundPayload: payload.inbound && typeof payload.inbound === 'object' ? payload.inbound : {},
    previous,
    detection,
    fromEmail,
    smtpUsername: username
  })
  const transporter = buildTransporter(candidate, password)
  let inboundVerification = null

  try {
    await transporter.verify()
  } catch (error) {
    logger.warn(`Verificación SMTP fallida para ${host}: ${error.message}`)
    if (error.status) throw error
    throw httpError(400, friendlySmtpError(error, host))
  }

  if (inboundCandidate.enabled) {
    try {
      inboundVerification = await verifyInboundConnection(inboundCandidate, password)
    } catch (error) {
      logger.warn(`Verificación IMAP fallida para ${inboundCandidate.host}: ${error.message}`)
      if (error.status) throw error
      throw httpError(400, friendlyImapError(error, inboundCandidate.host))
    }
  }

  try {
    await sendConnectionTestEmail(transporter, candidate, payload.testTo)
  } catch (error) {
    logger.warn(`Correo de prueba SMTP fallido para ${host}: ${error.message}`)
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
    inbound: inboundCandidate.enabled
      ? {
          ...inboundCandidate,
          mailbox: inboundVerification?.mailbox || inboundCandidate.mailbox,
          lastSeenUid: getInitialInboundCursor(inboundVerification, getStoredInboundConfig(previous)),
          lastVerifiedAt: inboundVerification?.verifiedAt || now,
          lastSyncAt: getStoredInboundConfig(previous).lastSyncAt || null,
          lastMessageAt: getStoredInboundConfig(previous).lastMessageAt || null,
          lastError: null
        }
      : {
          ...inboundCandidate,
          lastError: null
        },
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
export async function sendEmail({ to, subject, text, html, replyTo, includeSignature = true } = {}) {
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
  const signature = includeSignature === false ? null : await readStoredSignatureConfig()
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

export async function sendEmailToContact({
  contactId,
  to,
  subject,
  text,
  html,
  replyTo,
  externalId,
  includeSignature = true
} = {}) {
  const config = await readStoredConfig()
  const password = await readStoredPassword()
  if (!config?.connected || !config?.host || !config?.username || !password) {
    throw httpError(409, 'El correo no está conectado. Configúralo en Configuración > Correos')
  }

  const { recipient } = await getContactEmailRecipient(contactId, to)
  if (!EMAIL_PATTERN.test(recipient)) throw httpError(400, 'El contacto no tiene un correo válido')

  const cleanSubject = limitString(subject, EMAIL_SUBJECT_LIMIT)
  const cleanText = limitString(text, EMAIL_TEXT_LIMIT)
  const cleanHtml = limitString(html || textToEmailHtml(cleanText), EMAIL_HTML_LIMIT)
  const cleanReplyTo = cleanString(replyTo).toLowerCase()
  if (!cleanSubject) throw httpError(400, 'El correo necesita un asunto')
  if (!cleanText && !cleanHtml) throw httpError(400, 'El correo necesita contenido')
  if (cleanReplyTo && !EMAIL_PATTERN.test(cleanReplyTo)) throw httpError(400, 'El correo de respuestas no es válido')

  const localMessageId = buildEmailMessageId(externalId)
  const timestamp = new Date().toISOString()
  const fromEmail = config.fromEmail || config.username || ''
  const rawBase = {
    provider: 'smtp',
    connectedProvider: config.providerId || config.provider || 'smtp',
    senderName: config.fromName || '',
    includeSignature: includeSignature !== false
  }

  await saveEmailMessageRow({
    id: localMessageId,
    contactId,
    status: 'sending',
    toEmail: recipient,
    fromEmail,
    replyTo: cleanReplyTo || config.replyTo || '',
    subject: cleanSubject,
    text: cleanText,
    html: cleanHtml,
    messageTimestamp: timestamp,
    rawPayloadJson: JSON.stringify(rawBase)
  })

  try {
    const result = await sendEmail({
      to: recipient,
      subject: cleanSubject,
      text: cleanText,
      html: cleanHtml,
      replyTo: cleanReplyTo || undefined,
      includeSignature
    })
    await saveEmailMessageRow({
      id: localMessageId,
      contactId,
      status: 'sent',
      toEmail: recipient,
      fromEmail,
      replyTo: cleanReplyTo || config.replyTo || '',
      subject: cleanSubject,
      text: cleanText,
      html: cleanHtml,
      smtpMessageId: result.messageId || '',
      messageTimestamp: timestamp,
      rawPayloadJson: JSON.stringify({ ...rawBase, result })
    })
    publishChatMessageEvent({
      contactId,
      messageId: localMessageId,
      channel: 'email',
      provider: 'smtp',
      transport: 'smtp',
      direction: 'outbound',
      messageType: 'email',
      messageTimestamp: timestamp,
      isNew: true
    })
    return {
      ...result,
      localMessageId,
      status: 'sent',
      to: recipient,
      subject: cleanSubject,
      sentAt: timestamp
    }
  } catch (error) {
    await saveEmailMessageRow({
      id: localMessageId,
      contactId,
      status: 'error',
      toEmail: recipient,
      fromEmail,
      replyTo: cleanReplyTo || config.replyTo || '',
      subject: cleanSubject,
      text: cleanText,
      html: cleanHtml,
      errorMessage: error.message,
      messageTimestamp: timestamp,
      rawPayloadJson: JSON.stringify({ ...rawBase, error: error.message })
    })
    error.localMessageId = localMessageId
    throw error
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

export async function testInboundEmailConnection() {
  const config = await readStoredConfig()
  const inbound = getStoredInboundConfig(config)
  const password = await readStoredPassword()

  if (!config?.connected || !inbound?.enabled || !inbound.host || !inbound.username || !password) {
    throw httpError(409, 'La recepción de correo no está conectada. Actívala en Configuración > Correos.')
  }

  const verification = await verifyInboundConnection(inbound, password)
  await setInboundConfigPatch({
    ...inbound,
    mailbox: verification?.mailbox || inbound.mailbox,
    lastVerifiedAt: verification?.verifiedAt || new Date().toISOString(),
    lastError: null
  })

  return {
    connected: true,
    host: inbound.host,
    port: Number(inbound.port) || 993,
    security: normalizeImapSecurity(inbound.security, inbound.port),
    mailbox: verification?.mailbox || inbound.mailbox,
    exists: verification?.exists || 0,
    uidNext: verification?.uidNext || null,
    testedAt: verification?.verifiedAt || new Date().toISOString()
  }
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
