import express from 'express'
import {
  backfillUserEmailsFromLegacyUsernames,
  db,
  getAppConfig,
  setAppConfig
} from '../config/database.js'
import {
  internalStorageDiagnosticsHandler,
  internalStorageUsageHandler
} from '../controllers/mediaController.js'
import {
  deleteUser,
  listUsers,
  updateUser
} from '../controllers/userAccessController.js'
import { createInternalNotification } from '../services/notificationsService.js'

const router = express.Router()

function readBearerToken(header = '') {
  const match = String(header || '').match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function requireInternalInstallerToken(req, res, next) {
  const expected = String(process.env.INTERNAL_INSTALLER_TOKEN || '').trim()
  if (!expected) {
    return res.status(503).json({
      success: false,
      error: 'INTERNAL_INSTALLER_TOKEN no está configurado en esta app.'
    })
  }

  const received = String(req.headers['x-internal-installer-token'] || '').trim() ||
    readBearerToken(req.headers.authorization)

  if (!received || received !== expected) {
    return res.status(401).json({
      success: false,
      error: 'Token interno inválido.'
    })
  }

  next()
}

router.use(requireInternalInstallerToken)

router.get('/storage/usage', internalStorageUsageHandler)
router.get('/storage/diagnostics', internalStorageDiagnosticsHandler)
router.post('/database-storage/alert', async (req, res, next) => {
  try {
    const current = Math.max(1, Number(req.body?.current_disk_size_gb) || 1)
    const target = Math.max(current, Number(req.body?.target_disk_size_gb) || current)
    const usagePercent = Math.max(0, Number(req.body?.usage_percent) || 0)
    const storageFull = req.body?.storage_full === true || String(req.body?.postgres_status || '') === 'suspended'
    const managementUrl = String(req.body?.management_url || '').trim()
    const dedupeKey = `database_storage_alert:${current}:${target}`

    if (await getAppConfig(dedupeKey)) {
      return res.json({ success: true, deduped: true })
    }

    let safeManagementUrl = ''
    try {
      const parsed = new URL(managementUrl)
      if (['http:', 'https:'].includes(parsed.protocol)) safeManagementUrl = parsed.toString()
    } catch {
      // Sin URL segura el aviso sigue apareciendo en la campana, pero no manda
      // al usuario a un destino incompleto.
    }

    const adminRows = await db.all("SELECT id FROM users WHERE is_active = 1 AND role = 'admin' ORDER BY id ASC")
    if (!adminRows.length) {
      return res.status(409).json({ success: false, error: 'No hay administradores activos para recibir el aviso.' })
    }
    const result = await createInternalNotification({
      recipientUserIds: adminRows.map(row => row.id),
      broadcast: false,
      source: 'Sistema',
      severity: storageFull ? 'critical' : 'warning',
      title: storageFull ? 'Tu base de datos se quedó sin espacio' : 'Tu base de datos está por llenarse',
      message: storageFull
        ? `Render suspendió la base de ${current} GB. Confirma el aumento a ${target} GB para que Ristak vuelva a funcionar.`
        : `Ya usaste ${usagePercent.toFixed(1)}% de ${current} GB. Confirma el aumento a ${target} GB antes de que Render suspenda Ristak.`,
      actionUrl: safeManagementUrl,
      actionLabel: 'Aumentar espacio',
      category: 'system_storage',
      metadata: {
        current_disk_size_gb: current,
        target_disk_size_gb: target,
        usage_percent: usagePercent,
        storage_full: storageFull,
        render_pricing: req.body?.render_pricing || null
      },
      pushTitle: storageFull ? 'Ristak se quedó sin espacio' : 'Tu espacio está por llenarse',
      pushBody: storageFull
        ? `Confirma el aumento a ${target} GB para reactivar tu sistema.`
        : `Tu base está al ${usagePercent.toFixed(1)}%. Aumenta a ${target} GB antes de que se suspenda.`
    })

    await setAppConfig(dedupeKey, new Date().toISOString())
    res.json({ success: true, deduped: false, notification: result })
  } catch (error) {
    next(error)
  }
})
router.get('/users', listUsers)
router.post('/users/email-backfill', async (req, res, next) => {
  try {
    const stats = await backfillUserEmailsFromLegacyUsernames({ source: 'internal-installer' })
    res.json({ success: true, stats })
  } catch (error) {
    next(error)
  }
})
router.patch('/users/:userId', updateUser)
router.delete('/users/:userId', deleteUser)

export default router
