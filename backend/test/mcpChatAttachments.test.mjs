import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import sharp from 'sharp'
import { databaseReady, db } from '../src/config/database.js'
import mcpRoutes from '../src/routes/mcp.routes.js'
import { registerOAuthClient, createAuthorizationCode, consumeAuthorizationCode, createAccessToken } from '../src/utils/oauthTokens.js'
import { hashPassword } from '../src/utils/auth.js'
import { signPublicContextClaims, verifyPublicContextToken } from '../src/services/publicContextTokenService.js'
import { ATTACHMENT_TICKET_PURPOSE, ATTACHMENT_WIDGET_URI } from '../src/mcp/attachmentConstants.js'
import { buildChatAttachmentPreview } from '../src/services/chatAttachmentPreviewService.js'

let directory, server, origin, token, grantId, userId, pdfBytes
const contactId = 'attachment-contact'
const assets = new Map()

function pdfDocument(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids = []
  for (const text of pages) {
    const pageId = objects.length + 1
    kids.push(`${pageId} 0 R`)
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`)
    const stream = text ? `BT /F1 18 Tf 30 340 Td (${text}) Tj ET` : '0.5 g 30 30 200 300 re f'
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`
  let result = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(result)
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  result += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(result)
}

async function rpc(method, params = {}, auth = token) {
  const response = await fetch(`${origin}/api/mcp`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return { status: response.status, ...(await response.json()) }
}
async function open(messageId, extras = {}) {
  return (await rpc('tools/call', { name: 'chat_open_attachment', arguments: { contactId, source: 'whatsapp', messageId, ...extras } })).result
}
async function addAttachment(id, bytes, mimeType, filename, source = 'whatsapp') {
  const assetId = `rstk_media_${id}`
  const path = join(directory, filename)
  await writeFile(path, bytes)
  const url = `${origin}/media/assets/${assetId}/file`
  await db.run(`INSERT INTO media_assets (id, business_id, original_filename, public_url, mime_type, media_type,
    status, storage_provider, module, size_original, size_processed, metadata_json)
    VALUES (?, 'default', ?, ?, ?, ?, 'ready', 'local', 'chat', ?, ?, ?)`,
    [assetId, filename, url, mimeType, mimeType.split('/')[0], bytes.length, bytes.length, JSON.stringify({ localPath: path })])
  if (source === 'whatsapp') {
    await db.run(`INSERT INTO whatsapp_api_messages (id, contact_id, message_type, direction, media_url, media_mime_type, media_filename)
      VALUES (?, ?, 'document', 'inbound', ?, ?, ?)`, [id, contactId, url, mimeType, filename])
  } else {
    await db.run(`INSERT INTO meta_social_messages (id, contact_id, platform, message_type, direction, media_url, media_mime_type)
      VALUES (?, ?, 'instagram', 'message', 'inbound', ?, ?)`, [id, contactId, url, mimeType])
  }
  assets.set(id, { assetId, bytes, url })
}

before(async () => {
  await databaseReady
  await db.exec(await readFile(new URL('../migrations/versioned/129_mcp_oauth_control_plane.sqlite.sql', import.meta.url), 'utf8'))
  directory = await mkdtemp(join(tmpdir(), 'ristak-attachment-test-'))
  const app = express(); app.use(express.json()); app.use('/api/mcp', mcpRoutes)
  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  process.env.APP_URL = origin
  const email = `attachment-${crypto.randomUUID()}@example.test`
  const created = await db.run("INSERT INTO users (username, email, password_hash, role, is_active) VALUES (?, ?, ?, 'admin', 1)", [email, email, hashPassword(`Test9${crypto.randomBytes(24).toString('hex')}`)])
  userId = created.lastID
  const redirectUri = `${origin}/callback`
  const client = await registerOAuthClient({ clientName: 'Attachment test', redirectUris: [redirectUri] })
  const verifier = crypto.randomBytes(48).toString('base64url')
  const code = await createAuthorizationCode({ userId, clientId: client.client_id, redirectUri,
    codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'), scope: ['ristak.read'], resource: `${origin}/api/mcp` })
  const grant = await consumeAuthorizationCode({ code, clientId: client.client_id, redirectUri, codeVerifier: verifier })
  grantId = grant.grantId
  token = createAccessToken({ grantId, grantVersion: grant.grantVersion, userId, clientId: client.client_id,
    issuer: origin, audience: `${origin}/api/mcp`, scope: grant.scope }).accessToken
  await db.run('INSERT INTO contacts (id, full_name) VALUES (?, ?)', [contactId, 'Attachment tests'])
  await db.run('INSERT INTO contacts (id, full_name) VALUES (?, ?)', ['other-contact', 'Other'])
  pdfBytes = pdfDocument(['Page one', 'Page two', 'Page three', 'Page four'])
  await addAttachment('pdf', pdfBytes, 'application/pdf', 'comprobante.pdf')
  await addAttachment('image', await sharp({ create: { width: 80, height: 60, channels: 3, background: 'white' } }).png().toBuffer(), 'image/png', 'imagen.png')
  await addAttachment('video', Buffer.from('video-range-fixture'), 'video/mp4', 'video.mp4')
  await addAttachment('audio', Buffer.from('audio-range-fixture'), 'audio/ogg; codecs=opus', 'audio.ogg')
  await addAttachment('document', Buffer.from('arbitrary document bytes'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'archivo.docx')
  await addAttachment('text', Buffer.from('<script>alert(1)</script>'), 'text/plain', 'notas.txt')
  await addAttachment('meta', Buffer.from('meta document'), 'application/octet-stream', 'archivo.bin', 'meta')
})
after(async () => {
  delete process.env.APP_URL
  server?.closeAllConnections()
  if (server) await new Promise(resolve => server.close(resolve))
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('MCP anuncia un visor autorizado, sin dominios de terceros ni iframes externos', async () => {
  const listed = (await rpc('tools/list')).result.tools.find(tool => tool.name === 'chat_open_attachment')
  assert.equal(listed._meta.ui.resourceUri, ATTACHMENT_WIDGET_URI)
  assert.equal(listed.annotations.readOnlyHint, true)
  const resources = (await rpc('resources/list')).result.resources
  assert.equal(resources[0].uri, ATTACHMENT_WIDGET_URI)
  const resource = (await rpc('resources/read', { uri: ATTACHMENT_WIDGET_URI })).result.contents[0]
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app')
  assert.deepEqual(resource._meta.ui.csp.resourceDomains, [origin])
  assert.match(resource.text, /ui\/initialize/)
  assert.match(resource.text, /event.source !== window.parent/)
  assert.doesNotMatch(resource.text, /innerHTML|<iframe|eval\(/)
  assert.equal((await rpc('resources/read', { uri: 'file:///etc/passwd' })).error.code, -32002)
  assert.equal((await rpc('resources/read', { uri: ATTACHMENT_WIDGET_URI }, '')).status, 401)
})

test('PDF entrega texto, páginas visibles sin truncar y paginación explícita', async () => {
  const result = await open('pdf')
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
  assert.equal(result.structuredContent.data.previewStatus, 'ready', JSON.stringify(result.structuredContent))
  assert.equal(result.structuredContent.data.totalPages, 4)
  assert.equal(result.structuredContent.data.hasMorePages, true)
  assert.match(result.structuredContent.data.pages[0].text, /Page one/)
  const images = result.content.filter(item => item.type === 'image')
  assert.equal(images.length, 3)
  assert.ok(images[0].data.length > 2000)
  assert.equal((await sharp(Buffer.from(images[0].data, 'base64')).metadata()).format, 'jpeg')
  const last = await open('pdf', { page: 4 })
  assert.equal(last.structuredContent.data.hasMorePages, false)
  assert.equal(last.content.filter(item => item.type === 'image').length, 1)
  assert.match(last.structuredContent.data.pages[0].text, /Page four/)
  const original = await fetch(result.structuredContent.data.downloadUrl)
  assert.equal(original.status, 200)
  assert.match(original.headers.get('content-type'), /application\/pdf/)
  assert.equal(original.headers.get('cache-control'), 'no-store')
  assert.match(original.headers.get('content-disposition'), /^attachment;/)
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), pdfBytes)
})

test('PDF sin texto entrega la página para lectura visual, y corruptos conservan el original', async () => {
  const scanned = await buildChatAttachmentPreview(pdfDocument(['']), { kind: 'pdf' })
  assert.equal(scanned.images.length, 1)
  assert.equal(scanned.texts[0].text, '')
  const broken = await buildChatAttachmentPreview(Buffer.from('%PDF-broken'), { kind: 'pdf' })
  assert.ok(broken.error)
  const outOfRange = await open('pdf', { page: 9 })
  assert.equal(outOfRange.structuredContent.data.previewStatus, 'unavailable')
  assert.ok(outOfRange.structuredContent.data.downloadUrl)
})

test('imagen, audio, video y documentos conservan contrato de vista/original', async () => {
  const image = await open('image')
  assert.equal(image.content.filter(item => item.type === 'image').length, 1)
  for (const kind of ['video', 'audio']) {
    const result = await open(kind)
    assert.equal(result.structuredContent.data.previewStatus, 'player')
    const url = result.structuredContent.data.previewUrl
    const range = await fetch(url, { headers: { Range: 'bytes=2-6' } })
    assert.equal(range.status, 206)
    assert.equal(range.headers.get('content-range'), `bytes 2-6/${assets.get(kind).bytes.length}`)
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), assets.get(kind).bytes.subarray(2, 7))
    assert.equal((await fetch(url, { method: 'HEAD' })).status, 200)
    assert.equal((await fetch(url, { headers: { Range: 'bytes=90000-' } })).status, 416)
  }
  const document = await open('document')
  assert.equal(document.structuredContent.data.previewStatus, 'not_supported')
  assert.equal((await fetch(document.structuredContent.data.downloadUrl)).status, 200)
  const text = await open('text')
  assert.equal(text.structuredContent.data.text, '<script>alert(1)</script>')
  const meta = await open('meta', { source: 'meta' })
  assert.equal((await fetch(meta.structuredContent.data.downloadUrl)).status, 200)
})

test('rechaza URLs arbitrarias, mensajes ajenos, ocultos y archivos retirados', async () => {
  assert.equal((await open('pdf', { url: 'http://127.0.0.1' })).isError, true)
  assert.equal((await open('pdf', { contactId: 'other-contact' })).isError, true)
  const url = (await open('document')).structuredContent.data.downloadUrl
  await db.run("UPDATE whatsapp_api_messages SET hidden_from_chat = 1 WHERE id = 'document'")
  assert.equal((await open('document')).isError, true)
  assert.equal((await fetch(url)).status, 404)
  await db.run("UPDATE whatsapp_api_messages SET hidden_from_chat = 0 WHERE id = 'document'")
  await db.run("UPDATE media_assets SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'rstk_media_document'")
  assert.equal((await fetch(url)).status, 404)
  await db.run("UPDATE media_assets SET deleted_at = NULL WHERE id = 'rstk_media_document'")
  await db.run('UPDATE contacts SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [contactId])
  assert.equal((await fetch(url)).status, 404)
  await db.run('UPDATE contacts SET deleted_at = NULL WHERE id = ?', [contactId])
})

test('pase caducado, alterado, conexión revocada y usuario inactivo fallan cerrado', async () => {
  const result = await open('document')
  const url = new URL(result.structuredContent.data.downloadUrl)
  const ticket = decodeURIComponent(url.pathname.split('/').pop())
  const { claims } = await verifyPublicContextToken(ticket, { purpose: ATTACHMENT_TICKET_PURPOSE })
  const expired = await signPublicContextClaims({ purpose: ATTACHMENT_TICKET_PURPOSE, claims, ttlSeconds: 60, nowMs: Date.now() - 120000 })
  assert.notEqual((await fetch(`${origin}/api/mcp/attachments/${expired}`)).status, 200)
  assert.notEqual((await fetch(`${origin}/api/mcp/attachments/${ticket.slice(0, -3)}abc`)).status, 200)
  await db.run('UPDATE oauth_grants SET version = version + 1 WHERE grant_id = ?', [grantId])
  assert.equal((await fetch(url)).status, 401)
  await db.run('UPDATE oauth_grants SET version = version - 1 WHERE grant_id = ?', [grantId])
  await db.run('UPDATE users SET is_active = 0 WHERE id = ?', [userId])
  assert.equal((await fetch(url)).status, 401)
  await db.run('UPDATE users SET is_active = 1 WHERE id = ?', [userId])
  await db.run("UPDATE users SET role = 'employee', access_config = ? WHERE id = ?", [JSON.stringify({ contacts: 'read', chat: 'none', settings_api_access: 'read' }), userId])
  assert.equal((await fetch(url)).status, 403)
  assert.deepEqual((await rpc('resources/list')).result.resources, [])
  await db.run("UPDATE users SET role = 'admin', access_config = NULL WHERE id = ?", [userId])
  await db.run('UPDATE oauth_grants SET revoked_at = CURRENT_TIMESTAMP WHERE grant_id = ?', [grantId])
  assert.equal((await fetch(url)).status, 401)
})
