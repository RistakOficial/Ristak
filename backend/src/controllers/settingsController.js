import { logger } from '../utils/logger.js';
import { getTimezoneFromGHL } from '../utils/dateUtils.js';

/**
 * Obtiene la zona horaria configurada en HighLevel
 */
export const getTimezone = async (req, res) => {
  try {
    const timezone = await getTimezoneFromGHL();

    res.json({
      success: true,
      timezone
    });

  } catch (error) {
    logger.error(`Error en getTimezone: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener la zona horaria'
    });
  }
};
