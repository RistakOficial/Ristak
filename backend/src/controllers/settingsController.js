import { logger } from '../utils/logger.js';
import { db } from '../config/database.js';
import {
  getAccountTimezone,
  isValidTimezone,
  invalidateTimezoneCache,
  ACCOUNT_TIMEZONE_CONFIG_KEY
} from '../utils/dateUtils.js';
import {
  archiveContactCustomFieldFolder,
  createContactCustomFieldFolder,
  deleteContactCustomFieldDefinition,
  listContactCustomFieldDefinitions,
  listContactCustomFieldFolders,
  updateContactCustomFieldDefinition,
  updateContactCustomFieldFolder,
  upsertContactCustomFieldDefinition
} from '../services/contactCustomFieldDefinitionsService.js';

/**
 * Obtiene la zona horaria efectiva de la cuenta.
 * Prioridad: override de Ristak > HighLevel > default.
 */
export const getTimezone = async (req, res) => {
  try {
    const timezone = await getAccountTimezone();

    // Indicar si la zona viene de un override explícito de Ristak (para la UI)
    const override = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      [ACCOUNT_TIMEZONE_CONFIG_KEY]
    ).catch(() => null);

    res.json({
      success: true,
      timezone,
      source: override?.config_value ? 'ristak' : 'highlevel'
    });

  } catch (error) {
    logger.error(`Error en getTimezone: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener la zona horaria'
    });
  }
};

/**
 * Guarda la zona horaria elegida por el usuario en Ristak.
 * Se persiste en app_config y pasa a ser la fuente de verdad (sobre HighLevel).
 * Enviar timezone vacío/null limpia el override y vuelve a usar HighLevel/default.
 */
export const setTimezone = async (req, res) => {
  try {
    const { timezone } = req.body || {};

    // Permitir limpiar el override (volver a HighLevel/default)
    if (timezone === null || timezone === '' || timezone === undefined) {
      await db.run('DELETE FROM app_config WHERE config_key = ?', [ACCOUNT_TIMEZONE_CONFIG_KEY]);
      invalidateTimezoneCache();
      const resolved = await getAccountTimezone();
      return res.json({ success: true, timezone: resolved, source: 'highlevel' });
    }

    if (!isValidTimezone(timezone)) {
      return res.status(400).json({
        success: false,
        error: `Zona horaria inválida: ${timezone}`
      });
    }

    await db.run(`
      INSERT INTO app_config (config_key, config_value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(config_key) DO UPDATE SET
        config_value = excluded.config_value,
        updated_at = CURRENT_TIMESTAMP
    `, [ACCOUNT_TIMEZONE_CONFIG_KEY, timezone]);

    invalidateTimezoneCache();

    logger.info(`Zona horaria de la cuenta actualizada a: ${timezone}`);

    res.json({
      success: true,
      timezone,
      source: 'ristak'
    });

  } catch (error) {
    logger.error(`Error en setTimezone: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al guardar la zona horaria'
    });
  }
};

const getRequestUserId = (req) => req.user?.userId || req.user?.id || null;

const sendSettingsError = (res, error, fallback = 'Error al guardar la configuracion') => {
  res.status(error.status || 500).json({
    success: false,
    error: error.message || fallback
  });
};

export const listCustomFields = async (req, res) => {
  try {
    const includeArchived = String(req.query?.includeArchived || '').toLowerCase() === 'true';
    const [folders, fields] = await Promise.all([
      listContactCustomFieldFolders({ includeArchived }),
      listContactCustomFieldDefinitions({
        includeArchived,
        userId: getRequestUserId(req)
      })
    ]);

    res.json({
      success: true,
      data: {
        folders,
        fields
      }
    });
  } catch (error) {
    logger.error(`Error en listCustomFields: ${error.message}`);
    sendSettingsError(res, error, 'Error al obtener campos personalizados');
  }
};

export const createCustomField = async (req, res) => {
  try {
    const field = await upsertContactCustomFieldDefinition({
      ...(req.body || {}),
      createOnly: true,
      sourceType: 'manual',
      syncTarget: req.body?.syncTarget || 'local',
      ownerUserId: getRequestUserId(req)
    });

    if (!field) {
      return res.status(400).json({
        success: false,
        error: 'Usa un ID de campo valido y que no sea reservado'
      });
    }

    res.status(201).json({ success: true, data: field });
  } catch (error) {
    logger.error(`Error en createCustomField: ${error.message}`);
    sendSettingsError(res, error, 'Error al crear campo personalizado');
  }
};

export const updateCustomField = async (req, res) => {
  try {
    const field = await updateContactCustomFieldDefinition(req.params.definitionId, req.body || {});
    if (!field) {
      return res.status(404).json({ success: false, error: 'Campo personalizado no encontrado' });
    }

    res.json({ success: true, data: field });
  } catch (error) {
    logger.error(`Error en updateCustomField: ${error.message}`);
    sendSettingsError(res, error, 'Error al actualizar campo personalizado');
  }
};

export const deleteCustomField = async (req, res) => {
  try {
    const field = await deleteContactCustomFieldDefinition(req.params.definitionId);
    if (!field) {
      return res.status(404).json({ success: false, error: 'Campo personalizado no encontrado' });
    }

    res.json({ success: true, data: field });
  } catch (error) {
    logger.error(`Error en deleteCustomField: ${error.message}`);
    sendSettingsError(res, error, 'Error al eliminar campo personalizado');
  }
};

export const createCustomFieldFolder = async (req, res) => {
  try {
    const folder = await createContactCustomFieldFolder(req.body || {});
    res.status(201).json({ success: true, data: folder });
  } catch (error) {
    logger.error(`Error en createCustomFieldFolder: ${error.message}`);
    sendSettingsError(res, error, 'Error al crear carpeta');
  }
};

export const updateCustomFieldFolder = async (req, res) => {
  try {
    const folder = await updateContactCustomFieldFolder(req.params.folderId, req.body || {});
    if (!folder) {
      return res.status(404).json({ success: false, error: 'Carpeta no encontrada' });
    }

    res.json({ success: true, data: folder });
  } catch (error) {
    logger.error(`Error en updateCustomFieldFolder: ${error.message}`);
    sendSettingsError(res, error, 'Error al actualizar carpeta');
  }
};

export const archiveCustomFieldFolder = async (req, res) => {
  try {
    const folder = await archiveContactCustomFieldFolder(req.params.folderId);
    if (!folder) {
      return res.status(404).json({ success: false, error: 'Carpeta no encontrada' });
    }

    res.json({ success: true, data: folder });
  } catch (error) {
    logger.error(`Error en archiveCustomFieldFolder: ${error.message}`);
    sendSettingsError(res, error, 'Error al archivar carpeta');
  }
};
