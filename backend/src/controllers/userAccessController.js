import { db } from '../config/database.js'
import { hashPassword } from '../utils/auth.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import {
  getEffectiveAccessConfig,
  normalizeAccessConfig,
  normalizeUserRole,
  serializeAccessConfig
} from '../utils/userAccess.js'
import { logger } from '../utils/logger.js'

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

function normalizeMemberInput(input = {}, { requirePassword = false } = {}) {
  const firstName = cleanText(input.firstName, 80)
  const lastName = cleanText(input.lastName, 80)
  const email = cleanEmail(input.email)
  const rawPhone = cleanText(input.phone, 40)
  const phone = rawPhone ? normalizePhoneForStorage(rawPhone) : ''
  const role = normalizeUserRole(input.role)
  const password = cleanText(input.password, 120)

  assertEmailOrPhone(email, phone)

  if (rawPhone && !phone) {
    const error = new Error('Ese teléfono no se ve válido. Usa lada y número.')
    error.status = 400
    throw error
  }

  if (requirePassword && password.length < 6) {
    const error = new Error('Agrega una contraseña temporal de al menos 6 caracteres.')
    error.status = 400
    throw error
  }

  if (password && password.length < 6) {
    const error = new Error('La contraseña debe tener al menos 6 caracteres.')
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
    error: status >= 500 ? 'Error en el servidor' : error.message
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
    const currentUserId = String(req.user.userId)
    const existing = await fetchMemberById(targetId)

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' })
    }

    const member = normalizeMemberInput(req.body)

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
    const currentUserId = String(req.user.userId)
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
