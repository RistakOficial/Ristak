import { lookup } from 'dns/promises'
import { Agent as HttpsAgent } from 'https'
import { isIP } from 'net'
import fetch from 'node-fetch'

import { db } from '../config/database.js'

function cleanString(value = '') {
  return String(value || '').trim()
}

function normalizeBusinessId(value = '') {
  const clean = cleanString(value || process.env.RISTAK_BUSINESS_ID || 'default')
  return clean.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'default'
}

function mediaReferenceError(message, status = 400, code = 'unsafe_media_url') {
  const error = new Error(message)
  error.status = status
  error.statusCode = status
  error.code = code
  return error
}

function isBlockedIpv4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b, c] = parts
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
}

function isBlockedIpv6(address) {
  const clean = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  const mapped = clean.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isBlockedIpv4(mapped[1])

  const halves = clean.split('::')
  if (halves.length > 2) return true
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : []
  const right = halves[1] ? halves[1].split(':').filter(Boolean) : []
  const missing = 8 - left.length - right.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return true
  const groups = [
    ...left,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'),
    ...right
  ].map(group => Number.parseInt(group || '0', 16))
  if (groups.length !== 8 || groups.some(group => !Number.isInteger(group) || group < 0 || group > 0xffff)) return true

  const [first, second] = groups
  const allZeroPrefix = groups.slice(0, 6).every(group => group === 0)
  if (allZeroPrefix && (groups[6] !== 0 || groups[7] > 1)) {
    const embedded = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
    return isBlockedIpv4(embedded)
  }
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    const embedded = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
    return isBlockedIpv4(embedded)
  }

  return groups.every(group => group === 0) ||
    (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && second === 0x0db8) ||
    (first === 0x2001 && second === 0x0000) ||
    first === 0x2002
}

export function isBlockedOutboundMediaAddress(address = '') {
  const clean = cleanString(address).replace(/^\[|\]$/g, '')
  const version = isIP(clean)
  if (version === 4) return isBlockedIpv4(clean)
  if (version === 6) return isBlockedIpv6(clean)
  return true
}

function assertSafeHostname(hostname = '') {
  const host = cleanString(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') ||
      host.endsWith('.home') || host.endsWith('.lan')) {
    throw mediaReferenceError('El enlace multimedia apunta a una red privada y no se puede enviar.')
  }
  if (!isIP(host) && !host.includes('.')) {
    throw mediaReferenceError('El enlace multimedia debe usar un dominio público completo.')
  }
  return host
}

async function assertPublicDns(hostname) {
  if (isIP(hostname)) {
    if (isBlockedOutboundMediaAddress(hostname)) {
      throw mediaReferenceError('El enlace multimedia apunta a una dirección privada o reservada.')
    }
    return
  }

  let addresses
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw mediaReferenceError('No se pudo resolver el dominio público del archivo multimedia.')
  }
  if (!addresses.length || addresses.some(entry => isBlockedOutboundMediaAddress(entry.address))) {
    throw mediaReferenceError('El enlace multimedia resuelve a una red privada o reservada.')
  }

}

function createSafeHttpsAgent() {
  return new HttpsAgent({
    lookup(hostname, options, callback) {
      let safeHostname
      try {
        safeHostname = assertSafeHostname(hostname)
      } catch (error) {
        callback(error)
        return
      }

      lookup(safeHostname, { all: true, verbatim: true })
        .then(addresses => {
          const safeAddresses = addresses.filter(entry => !isBlockedOutboundMediaAddress(entry.address))
          if (!addresses.length || safeAddresses.length !== addresses.length) {
            callback(mediaReferenceError('El enlace multimedia resuelve a una red privada o reservada.'))
            return
          }
          if (options?.all) callback(null, safeAddresses)
          else callback(null, safeAddresses[0].address, safeAddresses[0].family)
        })
        .catch(() => callback(mediaReferenceError('No se pudo resolver el dominio público del archivo multimedia.')))
    }
  })
}

/** Valida la URL justo antes de entregarla a Baileys/HighLevel/Meta. */
export async function assertSafeOutboundMediaUrl(value = '') {
  const raw = cleanString(value)
  if (!raw || raw.length > 2_048) {
    throw mediaReferenceError('El enlace multimedia no es válido.')
  }

  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw mediaReferenceError('El enlace multimedia no es válido.')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw mediaReferenceError('El archivo multimedia debe usar un enlace HTTPS público.')
  }
  const hostname = assertSafeHostname(parsed.hostname)
  await assertPublicDns(hostname)
  return parsed.toString()
}

/**
 * Descarga para QR sin entregar la URL a Baileys: valida y fija DNS en cada
 * salto, bloquea redirects privados y corta el cuerpo al superar el límite.
 */
export async function downloadSafeOutboundMediaUrl(value = '', {
  maxBytes = 25 * 1024 * 1024,
  timeoutMs = 45_000,
  maxRedirects = 3
} = {}) {
  const byteLimit = Math.min(25 * 1024 * 1024, Math.max(1, Number(maxBytes) || 0))
  const deadline = Date.now() + Math.max(5_000, Number(timeoutMs) || 45_000)
  let currentUrl = cleanString(value)

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const safeUrl = await assertSafeOutboundMediaUrl(currentUrl)
    const remaining = deadline - Date.now()
    if (remaining < 1_000) {
      throw mediaReferenceError('La descarga segura del archivo tardó demasiado.', 408, 'media_download_timeout')
    }

    const agent = createSafeHttpsAgent()
    let response
    try {
      response = await fetch(safeUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(remaining),
        agent
      })
    } catch (error) {
      agent.destroy()
      if (error?.code === 'unsafe_media_url') throw error
      throw mediaReferenceError('No se pudo descargar el archivo multimedia de forma segura.', 502, 'media_download_failed')
    }

    const isRedirect = [301, 302, 303, 307, 308].includes(response.status)
    if (isRedirect) {
      const location = cleanString(response.headers.get('location'))
      response.body?.destroy?.()
      agent.destroy()
      if (!location || redirectCount >= maxRedirects) {
        throw mediaReferenceError('El enlace multimedia tiene demasiadas redirecciones.', 400, 'media_redirect_limit')
      }
      currentUrl = new URL(location, safeUrl).toString()
      continue
    }

    if (!response.ok) {
      response.body?.destroy?.()
      agent.destroy()
      throw mediaReferenceError(`El servidor del archivo respondió ${response.status}.`, 502, 'media_download_failed')
    }

    const declaredLength = Number(response.headers.get('content-length') || 0)
    if (Number.isFinite(declaredLength) && declaredLength > byteLimit) {
      response.body?.destroy?.()
      agent.destroy()
      throw mediaReferenceError('El archivo remoto supera el límite permitido para Chat.', 413, 'media_download_too_large')
    }

    const chunks = []
    let total = 0
    try {
      for await (const chunk of response.body) {
        total += chunk.length
        if (total > byteLimit) {
          response.body?.destroy?.()
          throw mediaReferenceError('El archivo remoto supera el límite permitido para Chat.', 413, 'media_download_too_large')
        }
        chunks.push(chunk)
      }
    } finally {
      agent.destroy()
    }

    if (!total) {
      throw mediaReferenceError('El archivo remoto está vacío.', 400, 'empty_media_download')
    }
    return {
      buffer: Buffer.concat(chunks, total),
      mimeType: cleanString(response.headers.get('content-type')).split(';')[0].toLowerCase(),
      url: safeUrl
    }
  }

  throw mediaReferenceError('No se pudo resolver el archivo multimedia.', 400, 'media_download_failed')
}

function normalizeExpectedTypes(expectedMediaTypes = []) {
  return new Set(
    (Array.isArray(expectedMediaTypes) ? expectedMediaTypes : [expectedMediaTypes])
      .map(value => cleanString(value).toLowerCase())
      .filter(Boolean)
  )
}

function assertUsableAsset(row, expectedTypes) {
  if (!row || row.deleted_at || cleanString(row.status).toLowerCase() !== 'ready' ||
      cleanString(row.module).toLowerCase() !== 'chat' || Number(row.is_public) !== 1) {
    throw mediaReferenceError(
      'El archivo ya no está disponible para enviarse desde este chat.',
      404,
      'chat_media_asset_unavailable'
    )
  }
  if (expectedTypes.size && !expectedTypes.has(cleanString(row.media_type).toLowerCase())) {
    throw mediaReferenceError(
      'El archivo no coincide con el tipo de mensaje que intentas enviar.',
      409,
      'chat_media_asset_type_mismatch'
    )
  }
  if (!cleanString(row.public_url)) {
    throw mediaReferenceError(
      'El archivo no tiene una URL pública lista para enviarse.',
      409,
      'chat_media_asset_not_public'
    )
  }
}

async function findAssetById({ businessId, mediaAssetId }) {
  return db.get(
    `SELECT id, business_id, original_filename, public_url, mime_type, media_type,
            module, status, is_public, deleted_at
     FROM media_assets
     WHERE business_id = ? AND id = ?
     LIMIT 1`,
    [businessId, mediaAssetId]
  )
}

async function findAssetByUrl({ businessId, url }) {
  return db.get(
    `SELECT id, business_id, original_filename, public_url, mime_type, media_type,
            module, status, is_public, deleted_at
     FROM media_assets
     WHERE business_id = ? AND (public_url = ? OR private_url = ?)
     ORDER BY created_at DESC
     LIMIT 1`,
    [businessId, url, url]
  )
}

/**
 * `mediaAssetId` manda sobre cualquier URL del cliente. La URL legacy sólo se
 * conserva para clientes viejos y siempre pasa validación HTTPS/DNS.
 */
export async function resolveOutboundChatMediaReference({
  mediaAssetId = '',
  legacyUrl = '',
  businessId = '',
  expectedMediaTypes = []
} = {}) {
  const cleanBusinessId = normalizeBusinessId(businessId)
  const cleanAssetId = cleanString(mediaAssetId)
  const cleanLegacyUrl = cleanString(legacyUrl)
  const expectedTypes = normalizeExpectedTypes(expectedMediaTypes)

  let asset = null
  if (cleanAssetId) {
    asset = await findAssetById({ businessId: cleanBusinessId, mediaAssetId: cleanAssetId })
    assertUsableAsset(asset, expectedTypes)
  } else if (cleanLegacyUrl) {
    asset = await findAssetByUrl({ businessId: cleanBusinessId, url: cleanLegacyUrl })
    if (asset) assertUsableAsset(asset, expectedTypes)
  } else {
    return null
  }

  const url = await assertSafeOutboundMediaUrl(asset?.public_url || cleanLegacyUrl)
  return {
    url,
    mediaAssetId: asset?.id || null,
    mimeType: cleanString(asset?.mime_type),
    mediaType: cleanString(asset?.media_type),
    filename: cleanString(asset?.original_filename),
    source: asset ? 'media_asset' : 'legacy_url'
  }
}
