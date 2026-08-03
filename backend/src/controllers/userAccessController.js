import crypto from 'crypto'
import { db } from '../config/database.js'
import { hashPassword, validatePasswordPolicy } from '../utils/auth.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import {
  getEffectiveAccessConfig,
  normalizeAccessConfig,
  normalizeUserRole,
  serializeAccessConfig
} from '../utils/userAccess.js'
import { logger } from '../utils/logger.js'
import { requestPortalUserRefresh } from '../services/licenseService.js'
import { sendEmail } from '../services/emailService.js'
import { getRequestBaseUrl, normalizeBaseUrl } from '../utils/publicUrl.js'

const USER_INVITATION_TTL_MS = 48 * 60 * 60 * 1000

function cleanText(value, maxLength = 160) {
  if (value === undefined || value === null) return ''
  return String(value).trim().slice(0, maxLength)
}

function cleanEmail(value) {
  return cleanText(value, 180).toLowerCase()
}

function buildFullName(firstName, lastName, fallback = '') {
  return [firstName, lastName].filter(Boolean).join(' ').trim() || cleanText(fallback)
}

function assertEmailOrPhone(email, phone) {
  if (!email && !phone) {
    const error = new Error('Agrega un correo o un teléfono para crear el acceso.')
    error.status = 400
    throw error
  }
}

function normalizeMemberInput(input = {}, { requirePassword = false, requireContact = true } = {}) {
  const firstName = cleanText(input.firstName, 80)
  const lastName = cleanText(input.lastName, 80)
  const email = cleanEmail(input.email)
  const rawPhone = cleanText(input.phone, 40)
  const phone = rawPhone ? normalizePhoneForStorage(rawPhone) : ''
  const role = normalizeUserRole(input.role)
  const password = cleanText(input.password, 120)

  if (requireContact) {
    assertEmailOrPhone(email, phone)
  }

  if (rawPhone && !phone) {
    const error = new Error('Ese teléfono no se ve válido. Usa lada y número.')
    error.status = 400
    throw error
  }

  if (requirePassword && !password) {
    const error = new Error('Agrega una contraseña segura.')
    error.status = 400
    throw error
  }

  const passwordPolicyError = password ? validatePasswordPolicy(password) : null
  if (passwordPolicyError) {
    const error = new Error(passwordPolicyError)
    error.status = 400
    throw error
  }

  return {
    firstName,
    lastName,
    email,
    phone,
    role,
    password,
    fullName: buildFullName(firstName, lastName, email || phone),
    accessConfig: normalizeAccessConfig(input.accessConfig, role)
  }
}

async function assertUniqueMember({ email, phone, username }, ignoredUserId = null) {
  const clauses = []
  const params = []

  if (email) {
    clauses.push('LOWER(email) = LOWER(?)')
    params.push(email)
  }

  if (phone) {
    clauses.push('phone = ?')
    params.push(phone)
  }

  if (username) {
    clauses.push('username = ?')
    params.push(username)
  }

  if (!clauses.length) return

  let sql = `SELECT id, email, phone, username FROM users WHERE (${clauses.join(' OR ')})`
  if (ignoredUserId) {
    sql += ' AND id != ?'
    params.push(ignoredUserId)
  }

  const existing = await db.get(sql, params)
  if (!existing) return

  const error = new Error('Ya existe una persona con ese correo o teléfono.')
  error.status = 400
  throw error
}

function serializeMember(row) {
  const role = normalizeUserRole(row.role)
  const firstName = cleanText(row.first_name, 80)
  const lastName = cleanText(row.last_name, 80)

  return {
    id: String(row.id),
    username: row.username,
    email: row.email || '',
    phone: row.phone || '',
    firstName,
    lastName,
    fullName: buildFullName(firstName, lastName, row.full_name || row.username),
    role,
    isActive: Boolean(row.is_active),
    lastLogin: row.last_login || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    accessConfig: getEffectiveAccessConfig({
      role,
      access_config: row.access_config
    })
  }
}

async function fetchMemberById(userId) {
  return db.get(
    `SELECT id, username, email, first_name, last_name, full_name, phone, role, is_active, access_config, last_login, created_at, updated_at
     FROM users
     WHERE id = ?`,
    [userId]
  )
}

async function countActiveAdminsExcept(userId = null) {
  const params = []
  let sql = "SELECT COUNT(*) AS count FROM users WHERE is_active = 1 AND role = 'admin'"

  if (userId) {
    sql += ' AND id != ?'
    params.push(userId)
  }

  const row = await db.get(sql, params)
  return Number(row?.count || 0)
}

function sendError(res, error) {
  const status = error.status || 500
  return res.status(status).json({
    success: false,
    error: status >= 500 ? 'Error en el servidor' : error.message,
    ...(error.code ? { code: error.code } : {})
  })
}

function invitationError(message, status = 400, code = 'user_invitation_failed') {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function invitationTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex')
}

function parseStoredAccessConfig(value, role) {
  try {
    return normalizeAccessConfig(JSON.parse(value || '{}'), role)
  } catch {
    return normalizeAccessConfig({}, role)
  }
}

function serializeInvitation(row = {}) {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone || '',
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    fullName: row.full_name || row.email,
    role: normalizeUserRole(row.role),
    accessConfig: parseStoredAccessConfig(row.access_config, row.role),
    status: row.status,
    expiresAt: row.expires_at,
    deliveredAt: row.delivered_at || null,
    acceptedAt: row.accepted_at || null,
    revokedAt: row.revoked_at || null,
    createdAt: row.created_at || null
  }
}

async function expirePendingInvitations() {
  await db.run(
    `UPDATE user_invitations
     SET status = 'expired', updated_at = CURRENT_TIMESTAMP
     WHERE status = 'pending' AND expires_at <= ?`,
    [new Date().toISOString()]
  )
}

function invitationBaseUrl(req) {
  return normalizeBaseUrl(
    process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || getRequestBaseUrl(req)
  )
}

async function deliverUserInvitation(req, invitation, rawToken) {
  const baseUrl = invitationBaseUrl(req)
  if (!baseUrl) {
    throw invitationError(
      'No se pudo resolver la URL pública de Ristak para enviar la invitación.',
      503,
      'user_invitation_public_url_unavailable'
    )
  }
  const invitationUrl = `${baseUrl}/accept-invitation?token=${encodeURIComponent(rawToken)}`
  const text = `Te invitaron a Ristak.\n\nAbre este enlace para crear tu contraseña y activar tu acceso (vence en 48 horas):\n${invitationUrl}\n\nSi no esperabas esta invitación, ignora este correo.`
  const html = `<p>Te invitaron a Ristak.</p>
<p><a href="${invitationUrl}">Crear contraseña y activar acceso</a> (el enlace vence en 48 horas).</p>
<p>Si no esperabas esta invitación, ignora este correo.</p>`

  await sendEmail({
    to: invitation.email,
    subject: 'Activa tu acceso a Ristak',
    text,
    html,
    includeSignature: false
  })
}

export async function listUsers(req, res) {
  try {
    const rows = await db.all(
      `SELECT id, username, email, first_name, last_name, full_name, phone, role, is_active, access_config, last_login, created_at, updated_at
       FROM users
       ORDER BY is_active DESC, role ASC, full_name ASC, username ASC`
    )

    res.json({
      success: true,
      users: rows.map(serializeMember)
    })
  } catch (error) {
    logger.error('Error listando usuarios:', error)
    sendError(res, error)
  }
}

export async function listUserInvitations(req, res) {
  try {
    await expirePendingInvitations()
    const rows = await db.all(
      `SELECT *
       FROM user_invitations
       ORDER BY created_at DESC
       LIMIT 100`
    )
    res.json({ success: true, invitations: rows.map(serializeInvitation) })
  } catch (error) {
    logger.error('Error listando invitaciones de usuarios:', error)
    sendError(res, error)
  }
}

export async function createUserInvitation(req, res) {
  let invitationId = null
  try {
    const member = normalizeMemberInput(req.body, { requirePassword: false })
    if (!member.email) {
      throw invitationError(
        'La invitación necesita un correo para entregar el enlace de activación.',
        400,
        'user_invitation_email_required'
      )
    }

    await expirePendingInvitations()
    await assertUniqueMember({ email: member.email, phone: member.phone, username: member.email })

    const existingInvitation = await db.get(
      `SELECT id
       FROM user_invitations
       WHERE LOWER(email) = LOWER(?) AND status IN ('pending', 'accepting')
       LIMIT 1`,
      [member.email]
    )
    if (existingInvitation) {
      throw invitationError(
        'Ya hay una invitación vigente para ese correo.',
        409,
        'user_invitation_already_pending'
      )
    }

    invitationId = crypto.randomUUID()
    const rawToken = crypto.randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + USER_INVITATION_TTL_MS).toISOString()
    const invitedByUserId = req.user?.userId || req.user?.id
    if (!invitedByUserId) {
      throw invitationError('No se pudo identificar al administrador.', 401, 'user_invitation_actor_missing')
    }

    await db.run(
      `INSERT INTO user_invitations (
         id, email, phone, first_name, last_name, full_name, role, access_config,
         token_hash, invited_by_user_id, status, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        invitationId,
        member.email,
        member.phone || null,
        member.firstName || null,
        member.lastName || null,
        member.fullName || member.email,
        member.role,
        serializeAccessConfig(member.accessConfig, member.role),
        invitationTokenHash(rawToken),
        invitedByUserId,
        expiresAt
      ]
    )

    const invitation = await db.get('SELECT * FROM user_invitations WHERE id = ?', [invitationId])
    await deliverUserInvitation(req, invitation, rawToken)
    await db.run(
      `UPDATE user_invitations
       SET delivered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending'`,
      [invitationId]
    )

    const delivered = await db.get('SELECT * FROM user_invitations WHERE id = ?', [invitationId])
    logger.success(`Invitación de usuario enviada a ${member.email}`)
    res.status(201).json({
      success: true,
      invitation: serializeInvitation(delivered),
      delivery: 'email',
      message: 'La invitación se envió por correo. Ristak no expuso el enlace ni la contraseña al cliente MCP.'
    })
  } catch (error) {
    if (invitationId) {
      await db.run('DELETE FROM user_invitations WHERE id = ? AND status = ?', [invitationId, 'pending']).catch(() => undefined)
    }
    logger.error('Error creando invitación de usuario:', error)
    sendError(res, error)
  }
}

export async function revokeUserInvitation(req, res) {
  try {
    const invitationId = cleanText(req.params?.invitationId, 120)
    const result = await db.run(
      `UPDATE user_invitations
       SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending'`,
      [invitationId]
    )
    if (Number(result?.changes ?? result?.rowCount) !== 1) {
      throw invitationError(
        'La invitación no existe o ya no está pendiente.',
        404,
        'user_invitation_not_pending'
      )
    }
    const row = await db.get('SELECT * FROM user_invitations WHERE id = ?', [invitationId])
    res.json({ success: true, invitation: serializeInvitation(row) })
  } catch (error) {
    logger.error('Error revocando invitación de usuario:', error)
    sendError(res, error)
  }
}

export async function getUserInvitationInfo(req, res) {
  try {
    const rawToken = cleanText(req.body?.token, 500)
    if (!rawToken) throw invitationError('El enlace está incompleto.', 400, 'user_invitation_token_missing')
    const row = await db.get(
      'SELECT * FROM user_invitations WHERE token_hash = ?',
      [invitationTokenHash(rawToken)]
    )
    if (!row || row.status !== 'pending' || new Date(row.expires_at).getTime() <= Date.now()) {
      if (row?.status === 'pending') await expirePendingInvitations()
      throw invitationError(
        'La invitación no es válida o ya expiró.',
        410,
        'user_invitation_invalid'
      )
    }
    res.json({
      success: true,
      invitation: {
        email: row.email,
        fullName: row.full_name || row.email,
        role: normalizeUserRole(row.role),
        expiresAt: row.expires_at
      }
    })
  } catch (error) {
    sendError(res, error)
  }
}

export async function acceptUserInvitation(req, res) {
  try {
    const rawToken = cleanText(req.body?.token, 500)
    const password = String(req.body?.password || '')
    if (!rawToken) throw invitationError('El enlace está incompleto.', 400, 'user_invitation_token_missing')
    const passwordPolicyError = validatePasswordPolicy(password)
    if (passwordPolicyError) {
      throw invitationError(passwordPolicyError, 400, 'user_invitation_password_invalid')
    }
    const passwordHash = hashPassword(password)
    const nowIso = new Date().toISOString()
    const tokenHash = invitationTokenHash(rawToken)

    const accepted = await db.transaction(async transaction => {
      const invitation = await transaction.get(
        'SELECT * FROM user_invitations WHERE token_hash = ?',
        [tokenHash]
      )
      if (!invitation || invitation.status !== 'pending' || new Date(invitation.expires_at).getTime() <= Date.now()) {
        throw invitationError(
          'La invitación no es válida o ya expiró.',
          410,
          'user_invitation_invalid'
        )
      }

      const claimed = await transaction.run(
        `UPDATE user_invitations
         SET status = 'accepting', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending' AND expires_at > ?`,
        [invitation.id, nowIso]
      )
      if (Number(claimed?.changes ?? claimed?.rowCount) !== 1) {
        throw invitationError(
          'La invitación cambió mientras se procesaba.',
          409,
          'user_invitation_conflict'
        )
      }

      const existing = await transaction.get(
        'SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR username = ?',
        [invitation.email, invitation.email]
      )
      if (existing) {
        throw invitationError(
          'Ese correo ya tiene un acceso activo.',
          409,
          'user_invitation_user_exists'
        )
      }

      const created = await transaction.run(
        `INSERT INTO users (
           username, email, phone, password_hash, full_name, first_name, last_name,
           role, is_active, access_config
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          invitation.email,
          invitation.email,
          invitation.phone || null,
          passwordHash,
          invitation.full_name || invitation.email,
          invitation.first_name || null,
          invitation.last_name || null,
          normalizeUserRole(invitation.role),
          invitation.access_config
        ]
      )
      const createdUser = created?.lastID
        ? await transaction.get('SELECT id FROM users WHERE id = ?', [created.lastID])
        : await transaction.get('SELECT id FROM users WHERE username = ?', [invitation.email])
      if (!createdUser?.id) throw new Error('No se pudo resolver el usuario invitado.')

      await transaction.run(
        `UPDATE user_invitations
         SET status = 'accepted', accepted_user_id = ?, accepted_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'accepting'`,
        [createdUser.id, invitation.id]
      )
      return { userId: createdUser.id, email: invitation.email }
    })

    requestPortalUserRefresh({ autoRegister: false })
    logger.success(`Invitación aceptada por ${accepted.email}`)
    res.status(201).json({
      success: true,
      message: 'Tu acceso quedó activado. Ya puedes iniciar sesión.'
    })
  } catch (error) {
    logger.error('Error aceptando invitación de usuario:', error)
    sendError(res, error)
  }
}

export async function createUser(req, res) {
  try {
    const member = normalizeMemberInput(req.body, { requirePassword: true })
    const username = member.email || member.phone

    await assertUniqueMember({ email: member.email, phone: member.phone, username })

    const passwordHash = hashPassword(member.password)
    const result = await db.run(
      `INSERT INTO users (
        username, email, phone, password_hash, full_name, first_name, last_name, role, is_active, access_config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        username,
        member.email || null,
        member.phone || null,
        passwordHash,
        member.fullName || username,
        member.firstName || null,
        member.lastName || null,
        member.role,
        1,
        serializeAccessConfig(member.accessConfig, member.role)
      ]
    )

    let userId = result.lastID
    if (!userId) {
      const created = await db.get('SELECT id FROM users WHERE username = ?', [username])
      userId = created?.id
    }

    const createdMember = await fetchMemberById(userId)

    // Refresca el directorio del portal para que el login móvil enrute a este
    // usuario (best-effort, no bloquea la respuesta).
    requestPortalUserRefresh()

    logger.success(`Usuario interno creado: ${username}`)

    res.status(201).json({
      success: true,
      user: serializeMember(createdMember)
    })
  } catch (error) {
    logger.error('Error creando usuario interno:', error)
    sendError(res, error)
  }
}

export async function updateUser(req, res) {
  try {
    const targetId = String(req.params.userId || '')
    const currentUserId = String(req.user?.userId || '')
    const existing = await fetchMemberById(targetId)

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' })
    }

    const canKeepLegacyUsername = Boolean(existing.username && !existing.email && !existing.phone)
    const member = normalizeMemberInput(req.body, { requireContact: !canKeepLegacyUsername })

    if (targetId === currentUserId && existing.role === 'admin' && member.role !== 'admin') {
      return res.status(400).json({
        success: false,
        error: 'No puedes quitarte el rol de administrador a ti mismo.'
      })
    }

    if (existing.role === 'admin' && member.role !== 'admin' && await countActiveAdminsExcept(targetId) === 0) {
      return res.status(400).json({
        success: false,
        error: 'Debe quedar al menos un administrador activo.'
      })
    }

    const username = existing.username || member.email || member.phone
    await assertUniqueMember({ email: member.email, phone: member.phone, username: null }, targetId)

    const updates = [
      'email = ?',
      'phone = ?',
      'first_name = ?',
      'last_name = ?',
      'full_name = ?',
      'role = ?',
      'access_config = ?',
      'updated_at = CURRENT_TIMESTAMP'
    ]
    const params = [
      member.email || null,
      member.phone || null,
      member.firstName || null,
      member.lastName || null,
      member.fullName || username,
      member.role,
      serializeAccessConfig(member.accessConfig, member.role)
    ]

    if (member.password) {
      updates.unshift('password_hash = ?')
      params.unshift(hashPassword(member.password))
    }

    params.push(targetId)

    await db.run(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      params
    )

    const updatedMember = await fetchMemberById(targetId)

    // El correo o el estado pudieron cambiar: refresca el directorio del portal.
    requestPortalUserRefresh()

    res.json({
      success: true,
      user: serializeMember(updatedMember)
    })
  } catch (error) {
    logger.error('Error actualizando usuario interno:', error)
    sendError(res, error)
  }
}

export async function deleteUser(req, res) {
  try {
    const targetId = String(req.params.userId || '')
    const currentUserId = String(req.user?.userId || '')
    const existing = await fetchMemberById(targetId)

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' })
    }

    if (targetId === currentUserId) {
      return res.status(400).json({
        success: false,
        error: 'No puedes borrar tu propio acceso desde aquí.'
      })
    }

    if (existing.role === 'admin' && await countActiveAdminsExcept(targetId) === 0) {
      return res.status(400).json({
        success: false,
        error: 'Debe quedar al menos un administrador activo.'
      })
    }

    await db.run(
      'UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [targetId]
    )

    // Quitar el acceso debe sacarlo también del directorio del portal.
    requestPortalUserRefresh()

    res.json({
      success: true,
      deleted: true,
      userId: targetId
    })
  } catch (error) {
    logger.error('Error eliminando usuario interno:', error)
    sendError(res, error)
  }
}
