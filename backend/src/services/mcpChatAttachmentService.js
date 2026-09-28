import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { db } from '../config/database.js'
import { resolveContactChatAttachment } from '../controllers/contactsController.js'
import { getMediaAsset, getMediaAssetDownloadFile, extractMediaAssetIdFromUrl } from './mediaStorageService.js'
import { downloadSafeOutboundMediaUrl } from './outboundMediaReferenceService.js'
import { signPublicContextClaims, verifyPublicContextToken } from './publicContextTokenService.js'
import { getLicenseState, hasFeature, hasModuleFeature, isLicenseEnforced } from './licenseService.js'
import { hasUserAccess } from '../utils/userAccess.js'
import { hasGrantedScope } from '../utils/oauthTokens.js'
import { attachmentDisposition, safeHeaderFilename } from '../utils/contentDisposition.js'
import { buildChatAttachmentPreview } from './chatAttachmentPreviewService.js'
import { ATTACHMENT_TICKET_PURPOSE, ATTACHMENT_TTL_SECONDS, ATTACHMENT_PREVIEW_MAX_BYTES } from '../mcp/attachmentConstants.js'

const MODULES = ['settings_api_access', 'chat', 'contacts']
const INLINE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm'])
const digest = value => createHash('sha256').update(value).digest('hex')
const failure = (message, code = 'chat_attachment_unavailable', status = 404) => Object.assign(new Error(message), { code, status })

async function authorizeActor(userId, grantId, version) {
  const user = await db.get('SELECT id, username, email, role, access_config FROM users WHERE CAST(id AS TEXT) = ? AND is_active = 1', [String(userId)])
  const grant = await db.get(
    `SELECT g.version, g.scope FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id
     WHERE g.grant_id = ? AND CAST(g.user_id AS TEXT) = ? AND g.revoked_at IS NULL AND c.revoked_at IS NULL`,
    [grantId, String(userId)]
  )
  if (!user || !grant || (version != null && Number(grant.version) !== Number(version)) || !hasGrantedScope(grant.scope, 'ristak.read')) {
    throw failure('La conexión ya no está autorizada. Vuelve a abrir el adjunto desde Ristak.', 'attachment_access_revoked', 401)
  }
  if (MODULES.some(module => !hasUserAccess(user, module, 'read'))) throw failure('Ya no tienes acceso a este chat.', 'attachment_access_denied', 403)
  if (isLicenseEnforced()) {
    const state = await getLicenseState({ email: user.email || user.username })
    const options = { state, email: user.email || user.username }
    if (!state.allowed || !(await hasFeature('developers', options))) throw failure('El plan ya no permite esta conexión.', 'feature_not_available', 403)
    for (const module of MODULES) if (!(await hasModuleFeature(module, options))) throw failure('El plan ya no permite leer este chat.', 'feature_not_available', 403)
  }
  return { user, grant }
}

async function resolveAttachment(args, origin) {
  const media = await resolveContactChatAttachment(args)
  let assetRow = await db.get('SELECT id, deleted_at, status FROM media_assets WHERE public_url = ? OR private_url = ? LIMIT 1', [media.url, media.url])
  if (!assetRow) {
    const parsed = new URL(media.url, origin)
    if (parsed.origin === new URL(origin).origin) {
      const id = extractMediaAssetIdFromUrl(parsed.pathname)
      if (id) assetRow = await db.get('SELECT id, deleted_at, status FROM media_assets WHERE id = ?', [id])
    }
  }
  if (assetRow && (assetRow.deleted_at || assetRow.status !== 'ready')) throw failure('El archivo fue retirado o todavía no está listo.')
  const asset = assetRow ? await getMediaAsset(assetRow.id) : null
  const mimeType = String(asset?.mimeType || media.mimeType || 'application/octet-stream').split(';')[0].trim().toLowerCase()
  const filename = safeHeaderFilename(media.filename || asset?.originalFilename || new URL(media.url, origin).pathname.split('/').pop(), 'archivo')
  const kind = mimeType === 'application/pdf' || /\.pdf$/i.test(filename) ? 'pdf'
    : mimeType.startsWith('image/') ? 'image'
      : mimeType.startsWith('video/') ? 'video'
        : mimeType.startsWith('audio/') ? 'audio' : 'document'
  return { ...media, asset, filename, mimeType, kind }
}

async function readPreviewBytes(media) {
  if (!media.asset) return (await downloadSafeOutboundMediaUrl(media.url, { maxBytes: ATTACHMENT_PREVIEW_MAX_BYTES, timeoutMs: 15000 })).buffer
  if (Number(media.asset.sizeProcessed || media.asset.sizeOriginal) > ATTACHMENT_PREVIEW_MAX_BYTES) throw failure('El archivo supera los 15 MB de vista previa. Abre el original.', 'attachment_preview_too_large', 413)
  const source = await getMediaAssetDownloadFile(media.asset.id, { signal: AbortSignal.timeout(15000) })
  const chunks = []
  let length = 0
  try {
    for await (const chunk of source.stream) {
      length += chunk.length
      if (length > ATTACHMENT_PREVIEW_MAX_BYTES) {
        throw failure('El archivo supera los 15 MB de vista previa. Abre el original.', 'attachment_preview_too_large', 413)
      }
      chunks.push(Buffer.from(chunk))
    }
  } finally {
    source.stream?.destroy?.()
    source.cleanup?.()
  }
  return Buffer.concat(chunks, length)
}

export async function openMcpChatAttachment(context, args) {
  const userId = String(context.user?.id || context.user?.userId || '')
  const grantId = context.mcpUser?.grantId || context.grant?.grant_id
  const { grant } = await authorizeActor(userId, grantId)
  const origin = new URL(context.baseUrl).origin
  const media = await resolveAttachment(args, origin)
  const selection = { contactId: args.contactId, source: args.source, messageId: args.messageId }
  const ticket = await signPublicContextClaims({ purpose: ATTACHMENT_TICKET_PURPOSE, ttlSeconds: ATTACHMENT_TTL_SECONDS,
    claims: { ...selection, userId, grantId, grantVersion: Number(grant.version), origin, fileDigest: digest(media.url) } })
  const url = `${origin}/api/mcp/attachments/${encodeURIComponent(ticket)}`
  const data = { ...selection, filename: media.filename, mimeType: media.mimeType, kind: media.kind,
    downloadUrl: `${url}?download=1`, previewUrl: INLINE_MIMES.has(media.mimeType) ? url : null,
    expiresInSeconds: ATTACHMENT_TTL_SECONDS, previewStatus: 'not_supported',
    note: 'El enlace es temporal. Vuelve a llamar chat_open_attachment si vence. El archivo original conserva su formato.' }
  let preview = {}
  if (['pdf', 'image'].includes(media.kind) || /^(text\/|application\/(json|xml)$)/.test(media.mimeType)) {
    try {
      const bytes = await readPreviewBytes(media)
      if (['pdf', 'image'].includes(media.kind)) {
        preview = await buildChatAttachmentPreview(bytes, { kind: media.kind, page: args.page || 1, pageCount: args.pageCount || 3 })
        data.previewStatus = preview.error ? 'unavailable' : 'ready'
        data.previewError = preview.error || null
        if (preview.texts) data.pages = preview.texts
        if (preview.pageCount) Object.assign(data, { totalPages: preview.pageCount, firstPage: preview.firstPage,
          lastPage: preview.lastPage, hasMorePages: preview.hasMore })
      } else {
        data.text = bytes.toString('utf8').slice(0, 40000)
        data.textTruncated = bytes.length > Buffer.byteLength(data.text)
        data.previewStatus = 'ready'
      }
    } catch {
      data.previewStatus = 'unavailable'
      data.previewError = 'No se pudo leer la vista previa. Prueba abrir o descargar el original; no asumas su contenido.'
    }
  } else if (['video', 'audio'].includes(media.kind)) {
    data.previewStatus = data.previewUrl ? 'player' : 'not_supported'
    data.note += ' Reproducir el archivo no equivale a analizar su contenido ni transcribirlo.'
  }
  return { success: true, data, previewImages: preview.images || [] }
}

export function attachmentToolResult(result) {
  const images = result.previewImages || []
  const payload = { success: result.success, data: result.data }
  return { structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }, ...images.flatMap(image => [
      { type: 'text', text: `Página ${image.page} de ${result.data.filename}` },
      { type: 'image', mimeType: image.mimeType, data: image.data }
    ])],
    _meta: { previewImages: images }
  }
}

export async function serveMcpChatAttachment(req, res) {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Security-Policy': "default-src 'none'; sandbox" })
  let source
  const abort = new AbortController()
  const disconnect = () => abort.abort()
  res.once('close', disconnect)
  try {
    const { claims } = await verifyPublicContextToken(req.params.ticket, { purpose: ATTACHMENT_TICKET_PURPOSE })
    await authorizeActor(claims.userId, claims.grantId, claims.grantVersion)
    const media = await resolveAttachment(claims, claims.origin)
    if (digest(media.url) !== claims.fileDigest) throw failure('El archivo cambió. Vuelve a abrir el adjunto desde ChatGPT.')
    const range = String(req.headers.range || '')
    if (range && !/^bytes=\d*-\d*$/.test(range)) throw failure('Rango de archivo no válido.', 'invalid_attachment_range', 416)
    if (media.asset) source = await getMediaAssetDownloadFile(media.asset.id, { range, method: req.method, signal: abort.signal })
    else {
      const { buffer } = await downloadSafeOutboundMediaUrl(media.url)
      source = { stream: Readable.from(buffer), contentLength: buffer.length }
    }
    const inline = req.query.download !== '1' && INLINE_MIMES.has(media.mimeType)
    const safeMime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(media.mimeType) && !['text/html', 'image/svg+xml', 'application/xhtml+xml'].includes(media.mimeType)
    res.type(safeMime ? media.mimeType : 'application/octet-stream')
    res.set('Content-Disposition', attachmentDisposition(media.filename).replace(/^attachment;/, inline ? 'inline;' : 'attachment;'))
    if (source.contentLength != null) res.set('Content-Length', String(source.contentLength))
    if (source.contentRange) { res.status(206); res.set('Content-Range', source.contentRange) }
    if (media.asset) res.set('Accept-Ranges', 'bytes')
    if (req.method === 'HEAD') return res.end()
    await pipeline(source.stream, res)
  } catch (error) {
    if (res.headersSent || res.destroyed) return res.destroy()
    res.status(error.status || 502).json({ error: 'No se pudo abrir el adjunto. Vuelve a solicitarlo desde ChatGPT.', code: error.code || 'attachment_download_failed' })
  } finally {
    res.off('close', disconnect)
    source?.stream?.destroy?.()
    source?.cleanup?.()
  }
}
