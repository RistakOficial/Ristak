import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'
import { createContact, updateContact, deleteContact } from '../../controllers/contactsController.js'
import { invokeController, toToolResult } from '../invokeController.js'
import { listContactPhoneNumbers, recordContactPhoneNumber } from '../../services/contactIdentityService.js'
import { normalizePhoneForStorage } from '../../utils/phoneUtils.js'

const CONTACT_SUMMARY_FIELDS = (row) => ({
  id: row.id,
  fullName: row.full_name,
  email: row.email,
  phone: row.phone,
  source: row.source,
  createdAt: row.created_at
})

function cleanText(value) {
  return String(value || '').trim()
}

function mapContactPhone(row) {
  return {
    id: row.id || null,
    phone: row.phone,
    label: row.label || '',
    isPrimary: Boolean(row.isPrimary || row.is_primary),
    source: row.source || ''
  }
}

export async function addContactPhoneNumber({ contactId, phone, label = null, isPrimary = false, confirmMove = false } = {}) {
  const cleanContactId = cleanText(contactId)
  const contact = await db.get('SELECT id, phone, full_name FROM contacts WHERE id = ?', [cleanContactId])
  if (!contact) return { ok: false, error: 'Contacto no encontrado' }

  const normalizedPhone = normalizePhoneForStorage(phone) || cleanText(phone)
  if (!normalizedPhone) return { ok: false, error: 'Teléfono inválido' }

  const existingPhone = await db.get(
    `SELECT cpn.contact_id, c.full_name
     FROM contact_phone_numbers cpn
     LEFT JOIN contacts c ON c.id = cpn.contact_id
     WHERE cpn.phone = ?
     LIMIT 1`,
    [normalizedPhone]
  ).catch(() => null)

  if (existingPhone?.contact_id && existingPhone.contact_id !== cleanContactId && !confirmMove) {
    return {
      ok: false,
      error: `Ese teléfono ya está ligado a ${existingPhone.full_name || existingPhone.contact_id}. Pide confirmación explícita antes de moverlo o fusionar referencias.`,
      existingContactId: existingPhone.contact_id,
      existingContactName: existingPhone.full_name || null
    }
  }

  const existingMain = await db.get(
    'SELECT id, full_name FROM contacts WHERE phone = ? AND id != ? LIMIT 1',
    [normalizedPhone, cleanContactId]
  ).catch(() => null)
  if (existingMain && !confirmMove) {
    return {
      ok: false,
      error: `Ese teléfono ya es principal de ${existingMain.full_name || existingMain.id}. Pide confirmación explícita antes de moverlo.`,
      existingContactId: existingMain.id,
      existingContactName: existingMain.full_name || null
    }
  }

  const shouldBePrimary = Boolean(isPrimary) || !cleanText(contact.phone)
  await recordContactPhoneNumber({
    contactId: cleanContactId,
    phone: normalizedPhone,
    label: label || (shouldBePrimary ? 'Principal' : 'Adicional'),
    isPrimary: shouldBePrimary,
    source: 'ai_agent',
    mergeConflicts: Boolean(confirmMove)
  })

  if (shouldBePrimary) {
    await db.run(
      'UPDATE contacts SET phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [normalizedPhone, cleanContactId]
    )
  }

  const phones = await listContactPhoneNumbers(cleanContactId)
  return {
    ok: true,
    contactId: cleanContactId,
    phone: normalizedPhone,
    isPrimary: shouldBePrimary,
    phones: phones.map(mapContactPhone)
  }
}

export const searchContactsTool = tool({
  name: 'search_contacts',
  description: 'Busca contactos por nombre, correo o teléfono. Úsala siempre antes de crear, editar o borrar para obtener el ID real del contacto. Devuelve hasta 20 coincidencias.',
  parameters: z.object({
    query: z.string().describe('Texto a buscar: nombre, parte del correo o dígitos del teléfono'),
    limit: z.number().int().min(1).max(50).nullable().describe('Máximo de resultados (default 20)')
  }),
  execute: async ({ query, limit }) => {
    const like = `%${String(query).trim().toLowerCase()}%`
    const digits = String(query).replace(/\D+/g, '')
    const phoneLike = digits ? `%${digits}%` : like
    const rows = await db.all(
      `SELECT id, full_name, email, phone, source, created_at
       FROM contacts
       WHERE LOWER(COALESCE(full_name, '')) LIKE ?
          OR LOWER(COALESCE(email, '')) LIKE ?
          OR COALESCE(phone, '') LIKE ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [like, like, phoneLike, limit || 20]
    )
    return { ok: true, total: rows.length, contacts: rows.map(CONTACT_SUMMARY_FIELDS) }
  }
})

export const getContactTool = tool({
  name: 'get_contact',
  description: 'Obtiene el detalle de un contacto por ID, incluyendo total pagado y su próxima/última cita.',
  parameters: z.object({
    contactId: z.string().describe('ID del contacto (obtenido con search_contacts)')
  }),
  execute: async ({ contactId }) => {
    const row = await db.get('SELECT * FROM contacts WHERE id = ?', [contactId])
    if (!row) return { ok: false, error: 'Contacto no encontrado' }

    const payments = await db.get(
      `SELECT COUNT(*) AS payment_count, COALESCE(SUM(CASE WHEN status IN ('paid','completed','succeeded') THEN amount ELSE 0 END), 0) AS total_paid
       FROM payments WHERE contact_id = ?`,
      [contactId]
    )
    const lastAppointment = await db.get(
      `SELECT id, title, start_time, appointment_status FROM appointments
       WHERE contact_id = ? AND deleted_at IS NULL
       ORDER BY start_time DESC LIMIT 1`,
      [contactId]
    ).catch(() => null)

    return {
      ok: true,
      contact: {
        ...CONTACT_SUMMARY_FIELDS(row),
        firstName: row.first_name,
        lastName: row.last_name,
        paymentCount: Number(payments?.payment_count || 0),
        totalPaid: Number(payments?.total_paid || 0),
        lastAppointment: lastAppointment
          ? { id: lastAppointment.id, title: lastAppointment.title, startTime: lastAppointment.start_time, status: lastAppointment.appointment_status }
          : null
      }
    }
  }
})

export const createContactTool = tool({
  name: 'create_contact',
  description: 'Crea un contacto nuevo. Requiere al menos nombre, correo o teléfono. Si ya existe uno con el mismo correo/teléfono devuelve error: en ese caso búscalo y edítalo.',
  parameters: z.object({
    fullName: z.string().nullable().describe('Nombre completo'),
    email: z.string().nullable().describe('Correo electrónico'),
    phone: z.string().nullable().describe('Teléfono con lada, ej. +52 555 123 4567'),
    source: z.string().nullable().describe('Origen del contacto (default: agente IA)')
  }),
  execute: async ({ fullName, email, phone, source }) => {
    const result = await invokeController(createContact, {
      body: {
        full_name: fullName || undefined,
        email: email || undefined,
        phone: phone || undefined,
        source: source || 'ai_agent'
      }
    })
    return toToolResult(result, (data) => ({
      id: data?.id,
      fullName: data?.full_name || data?.fullName || data?.name,
      email: data?.email,
      phone: data?.phone
    }))
  }
})

export const updateContactTool = tool({
  name: 'update_contact',
  description: 'Actualiza nombre, correo, teléfono u origen de un contacto existente. Solo envía los campos que cambian.',
  parameters: z.object({
    contactId: z.string().describe('ID del contacto'),
    fullName: z.string().nullable().describe('Nuevo nombre completo'),
    email: z.string().nullable().describe('Nuevo correo'),
    phone: z.string().nullable().describe('Nuevo teléfono'),
    source: z.string().nullable().describe('Nuevo origen')
  }),
  execute: async ({ contactId, fullName, email, phone, source }) => {
    const body = {}
    if (fullName !== null && fullName !== undefined) body.full_name = fullName
    if (email !== null && email !== undefined) body.email = email
    if (phone !== null && phone !== undefined) body.phone = phone
    if (source !== null && source !== undefined) body.source = source

    if (!Object.keys(body).length) {
      return { ok: false, error: 'No enviaste ningún campo a actualizar' }
    }

    const result = await invokeController(updateContact, { params: { id: contactId }, body })
    return toToolResult(result, (data) => ({
      id: data?.id,
      fullName: data?.full_name,
      email: data?.email,
      phone: data?.phone
    }))
  }
})

export const deleteContactTool = tool({
  name: 'delete_contact',
  description: 'Elimina un contacto de forma permanente. ACCIÓN DESTRUCTIVA: antes de llamarla debes pedir confirmación explícita al usuario y pasar confirm=true solo cuando ya confirmó.',
  parameters: z.object({
    contactId: z.string().describe('ID del contacto a eliminar'),
    confirm: z.boolean().describe('true solo si el usuario ya confirmó explícitamente la eliminación')
  }),
  execute: async ({ contactId, confirm }) => {
    if (!confirm) {
      return { ok: false, error: 'Falta confirmación del usuario. Pregunta antes de borrar.' }
    }
    const result = await invokeController(deleteContact, { params: { id: contactId } })
    return toToolResult(result)
  }
})

export const addContactPhoneTool = tool({
  name: 'add_contact_phone',
  description: 'Agrega un teléfono adicional a un contacto sin reemplazar el teléfono principal, salvo que isPrimary=true. Si el número pertenece a otro contacto, pide confirmación explícita y pasa confirmMove=true.',
  parameters: z.object({
    contactId: z.string().describe('ID real del contacto (usa search_contacts antes)'),
    phone: z.string().describe('Teléfono con lada, ej. +52 555 123 4567'),
    label: z.string().nullable().describe('Etiqueta del número, ej. WhatsApp, Trabajo, Casa'),
    isPrimary: z.boolean().nullable().describe('true si debe ser el teléfono principal del contacto'),
    confirmMove: z.boolean().nullable().describe('true solo si el usuario confirmó mover/fusionar un número que ya estaba en otro contacto')
  }),
  execute: async ({ contactId, phone, label, isPrimary, confirmMove }) => addContactPhoneNumber({
    contactId,
    phone,
    label,
    isPrimary: Boolean(isPrimary),
    confirmMove: Boolean(confirmMove)
  })
})

export const contactReadTools = [searchContactsTool, getContactTool]
export const contactWriteTools = [createContactTool, updateContactTool, addContactPhoneTool, deleteContactTool]
export const contactTools = [...contactReadTools, ...contactWriteTools]
