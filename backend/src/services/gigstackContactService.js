import crypto from 'node:crypto'
import { db } from '../config/database.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { getPaymentSettings } from './paymentSettingsService.js'
import { assertGigstackTokenMode, createGigstackError, getGigstackTokenForMode, gigstackRequest, normalizeGigstackPaymentMode } from './gigstackApiService.js'

const clean = (value, length = 180) => String(value || '').trim().slice(0, length)
const normalizeText = value => clean(value, 500).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const email = value => clean(value, 320).toLowerCase()
const phone = value => normalizePhoneForStorage(value, { defaultCountryCode: '' })
const conflict = message => createGigstackError(message, { status: 409, code: 'gigstack_client_link_conflict' })

export async function getGigstackClientContext(mode, settings) {
  mode = normalizeGigstackPaymentMode(mode)
  if (!mode) throw createGigstackError('Elige explícitamente el ambiente Test o Live.', { status: 400, code: 'invalid_gigstack_mode' })
  settings ||= await getPaymentSettings({ includeSecrets: true, resolveBusinessProfile: false })
  if (!settings.taxes?.gigstackEnabled) throw conflict('Gigstack está desconectado.')
  const token = getGigstackTokenForMode(settings.taxes, mode)
  const identity = assertGigstackTokenMode(token, mode)
  if (!identity.teamId) throw conflict('La llave de Gigstack no identifica un equipo.')
  return { mode, teamId: identity.teamId, token }
}

function safeFiscalValidation(raw, context) {
  return {
    status: clean(raw?.status, 80),
    message: clean(raw?.message, 1000).split(context.token).join('[REDACTED]')
  }
}

function safeClient(raw, context) {
  const client = raw?.data && !Array.isArray(raw.data) ? raw.data : raw
  if (!client?.id) throw conflict('Gigstack no devolvió la identidad del cliente.')
  const teamId = clean(typeof client.team === 'object' ? client.team?.id : client.team)
  if ((teamId && teamId !== context.teamId)
    || (typeof client.livemode === 'boolean' && client.livemode !== (context.mode === 'live'))) {
    throw conflict('El cliente de Gigstack pertenece a otro equipo o ambiente.')
  }
  return {
    id: clean(client.id), name: clean(client.name), email: email(client.email),
    phone: clean(client.phone, 80), taxId: clean(client.tax_id),
    legalName: clean(client.legal_name), taxSystem: clean(client.tax_system),
    postalCode: clean(client.address?.zip, 20), isValid: client.is_valid === true,
    fiscalValidation: safeFiscalValidation(client.fiscal_validation, context),
    teamId: context.teamId, mode: context.mode
  }
}

export async function getGigstackClient(clientId, context) {
  const profile = safeClient(await gigstackRequest(`/clients/${encodeURIComponent(clean(clientId))}`, { token: context.token }), context)
  if (profile.id !== clean(clientId)) throw conflict('Gigstack devolvió un cliente distinto al solicitado.')
  return profile
}

async function getContact(contactId, queryable = db) {
  const contact = await queryable.get('SELECT id, full_name, email, phone, deleted_at FROM contacts WHERE id = ?', [contactId])
  if (!contact || contact.deleted_at) throw createGigstackError('Contacto no disponible.', { status: 404, code: 'contact_not_found' })
  return contact
}

export async function getGigstackContactLink(contactId, context, queryable = db) {
  return queryable.get('SELECT * FROM gigstack_contact_links WHERE contact_id = ? AND payment_mode = ? AND team_id = ?', [contactId, context.mode, context.teamId])
}

async function listClientPage(context, { next, limit = 100 } = {}) {
  const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(Number(limit) || 100, 100))) })
  if (next) params.set('next', clean(next, 300))
  const response = await gigstackRequest(`/clients?${params}`, { token: context.token })
  if (!Array.isArray(response.data)) throw conflict('Gigstack devolvió una lista de clientes inválida.')
  const clients = response.data.map(client => safeClient(client, context))
  const hasMore = response.has_more === true
  const cursor = hasMore ? clean(response.next || clients.at(-1)?.id, 300) : null
  if (hasMore && (!cursor || cursor === next)) throw conflict('Gigstack no avanzó la paginación de clientes.')
  return { clients, next: cursor, hasMore }
}

// Administrative discovery never creates or changes a remote client. Names
// are search hints only; they never establish an automatic fiscal identity.
export async function searchGigstackClients({ contactId, mode, query, next, limit } = {}) {
  const context = await getGigstackClientContext(mode)
  const contact = await getContact(clean(contactId))
  const page = await listClientPage(context, { next, limit })
  const words = normalizeText(query || '').split(/\s+/).filter(Boolean)
  const clients = page.clients.filter(client => {
    const text = normalizeText([client.id, client.name, client.legalName, client.email, client.phone, client.taxId].join(' '))
    return words.every(word => text.includes(word))
  }).map(client => ({
    ...client,
    matches: {
      email: Boolean(email(contact.email) && email(contact.email) === client.email),
      phone: Boolean(phone(contact.phone) && phone(contact.phone) === phone(client.phone)),
      name: Boolean(normalizeText(contact.full_name) && normalizeText(contact.full_name) === normalizeText(client.name))
    }
  }))
  const link = await getGigstackContactLink(contact.id, context)
  return { contactId: contact.id, contactName: contact.full_name, mode: context.mode, teamId: context.teamId, linkedClientId: link?.client_id || null, clients, next: page.next, hasMore: page.hasMore, scanned: page.clients.length }
}

function linkPreview(contact, context, profile, existing) {
  return {
    contactId: contact.id, contactName: contact.full_name, mode: context.mode,
    teamId: context.teamId, client: profile, previousClientId: existing?.client_id || null,
    previewRevision: crypto.createHash('sha256').update(JSON.stringify({ contact, profile, existing })).digest('hex')
  }
}

export async function linkGigstackContact({ contactId, clientId, mode, dryRun = true, expectedPreviewRevision, actorId } = {}) {
  contactId = clean(contactId)
  const context = await getGigstackClientContext(mode)
  const contact = await getContact(contactId)
  const profile = await getGigstackClient(clientId, context)
  const existing = await getGigstackContactLink(contactId, context)
  const preview = linkPreview(contact, context, profile, existing)
  if (dryRun !== false) return { dryRun: true, ...preview }
  if (expectedPreviewRevision !== preview.previewRevision) throw conflict('El vínculo cambió. Revisa la vista previa antes de guardarlo.')
  return db.transaction(async tx => {
    // Lock the canonical contact, including on Postgres; do not modify its
    // profile, email or timestamps merely to establish a fiscal association.
    await tx.run('UPDATE contacts SET id = id WHERE id = ?', [contactId])
    const current = linkPreview(await getContact(contactId, tx), context, profile, await getGigstackContactLink(contactId, context, tx))
    if (current.previewRevision !== expectedPreviewRevision) throw conflict('El contacto o su vínculo cambió durante la operación.')
    const active = await tx.get(`SELECT j.payment_id FROM gigstack_invoice_jobs j
      JOIN payments p ON p.id = j.payment_id WHERE p.contact_id = ? AND j.payment_mode = ?
      AND j.status = 'processing' AND COALESCE(j.lease_until_at_ms, 0) > ? LIMIT 1`, [contactId, context.mode, Date.now()])
    if (active) throw conflict('Hay una factura en proceso para este contacto. Espera a que termine antes de cambiar el vínculo.')
    await tx.run(`INSERT INTO gigstack_contact_links (contact_id, payment_mode, team_id, client_id, client_profile_json, source, actor_id)
      VALUES (?, ?, ?, ?, ?, 'manual', ?)
      ON CONFLICT(contact_id, payment_mode, team_id) DO UPDATE SET client_id = excluded.client_id,
      client_profile_json = excluded.client_profile_json, source = excluded.source,
      actor_id = excluded.actor_id, updated_at = CURRENT_TIMESTAMP`,
    [contactId, context.mode, context.teamId, profile.id, JSON.stringify(profile), clean(actorId)])
    return { dryRun: false, changed: existing?.client_id !== profile.id, ...preview }
  })
}

export async function rememberGigstackClient(contactId, profile, context, source = 'payment_registration') {
  if (!contactId || !profile?.id) return
  await db.run(`INSERT INTO gigstack_contact_links (contact_id, payment_mode, team_id, client_id, client_profile_json, source)
    SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM contacts WHERE id = ? AND deleted_at IS NULL)
    ON CONFLICT(contact_id, payment_mode, team_id) DO NOTHING`,
  [contactId, context.mode, context.teamId, profile.id, JSON.stringify(profile), source, contactId])
}

// This endpoint validates only the linked receiver. Unlike updating a client,
// it never asks Gigstack to stamp all of that client's pending receipts.
export async function validateGigstackContact({ contactId, mode, dryRun = true, expectedPreviewRevision } = {}) {
  contactId = clean(contactId)
  const context = await getGigstackClientContext(mode)
  const contact = await getContact(contactId)
  const existing = await getGigstackContactLink(contactId, context)
  if (!existing) throw conflict('Primero vincula el contacto con su cliente de Gigstack.')
  const profile = await getGigstackClient(existing.client_id, context)
  const preview = linkPreview(contact, context, profile, existing)
  if (dryRun !== false) return { dryRun: true, ...preview }
  if (expectedPreviewRevision !== preview.previewRevision) throw conflict('La ficha fiscal o el vínculo cambió. Revisa la vista previa antes de validarlo.')
  const result = await gigstackRequest(`/clients/validate/${encodeURIComponent(profile.id)}`, { token: context.token, method: 'POST', timeoutMs: 30_000 })
  const validated = await getGigstackClient(profile.id, context)
  await db.transaction(async tx => {
    await tx.run('UPDATE contacts SET id = id WHERE id = ?', [contactId])
    const current = linkPreview(await getContact(contactId, tx), context, profile, await getGigstackContactLink(contactId, context, tx))
    if (current.previewRevision !== expectedPreviewRevision) throw conflict('El vínculo cambió durante la validación. El resultado no se guardó en otro receptor.')
    await tx.run(`UPDATE gigstack_contact_links SET client_profile_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE contact_id = ? AND payment_mode = ? AND team_id = ? AND client_id = ?`,
    [JSON.stringify(validated), contactId, context.mode, context.teamId, profile.id])
  })
  return { dryRun: false, ...preview, client: validated, validation: safeFiscalValidation(result.data?.fiscal_validation, context) }
}

export async function resolveGigstackClientForPayment(row, settings, mode) {
  const context = await getGigstackClientContext(mode, settings)
  const link = row.contact_id ? await getGigstackContactLink(row.contact_id, context) : null
  const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {}
  const legacyId = clean(metadata.gigstackClientId || metadata.clientId)
  if (link) {
    if (legacyId && legacyId !== link.client_id) throw conflict('El receptor fiscal guardado en el pago no coincide con el contacto vinculado.')
    return { id: link.client_id }
  }
  if (legacyId && settings.taxes?.gigstackClientMatchMode === 'client_id_or_email') return { id: legacyId }
  const contactEmail = email(row.contact_email || metadata.contactEmail)
  if (contactEmail) return {
    search: { on_key: 'email', on_value: contactEmail, update: false },
    name: clean(row.contact_name || metadata.contactName || contactEmail),
    email: contactEmail, phone: clean(row.contact_phone || metadata.contactPhone, 80)
  }
  const contactPhone = phone(row.contact_phone || metadata.contactPhone)
  if (contactPhone) {
    // Scan completely before trusting uniqueness. Never pick the first match
    // or infer a fiscal receiver from a similar name.
    const matches = new Map()
    let next
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await listClientPage(context, { next })
      for (const client of page.clients) if (phone(client.phone) === contactPhone) matches.set(client.id, client)
      if (!page.hasMore) {
        if (matches.size === 1) return { id: [...matches.keys()][0] }
        if (matches.size > 1) throw conflict('Más de un cliente de Gigstack comparte el teléfono. Vincula manualmente el receptor correcto.')
        break
      }
      next = page.next
      if (pageNumber === 9) throw conflict('La búsqueda excedió el límite seguro. Vincula manualmente el cliente de Gigstack por su ID.')
    }
  }
  throw createGigstackError('El contacto no tiene correo, vínculo fiscal ni un cliente único con el mismo teléfono en Gigstack.', { status: 409, code: 'missing_gigstack_client' })
}
