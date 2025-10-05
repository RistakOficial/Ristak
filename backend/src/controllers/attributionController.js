import { executeFallbackAttribution, previewFallbackAttribution } from '../services/attributionFallbackService.js';
import { logger } from '../utils/logger.js';

/**
 * Vista previa de qué contactos se actualizarían con fallback attribution
 * GET /api/attribution/fallback/preview
 */
export const previewFallback = async (req, res) => {
  try {
    logger.info('Generando preview de fallback attribution...');

    const preview = await previewFallbackAttribution();

    const summary = {
      total_candidates: preview.total_candidates,
      would_update_count: preview.would_update.length,
      would_skip_count: preview.would_skip.length,
      estimated_revenue_recovery: preview.would_update.reduce((sum, c) => sum + (c.revenue || 0), 0)
    };

    res.json({
      success: true,
      summary,
      contacts_to_update: preview.would_update,
      contacts_to_skip: preview.would_skip
    });

  } catch (error) {
    logger.error(`Error en previewFallback: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al generar preview de fallback attribution'
    });
  }
};

/**
 * Ejecuta el fallback attribution (actualiza la BD)
 * POST /api/attribution/fallback/execute
 */
export const executeFallback = async (req, res) => {
  try {
    logger.info('Ejecutando fallback attribution...');

    const stats = await executeFallbackAttribution();

    res.json({
      success: true,
      message: 'Fallback attribution ejecutado exitosamente',
      stats: {
        total_candidates: stats.total_candidates,
        matched_urls: stats.matched_urls,
        date_mismatches: stats.date_mismatches,
        successful_updates: stats.successful_updates,
        revenue_recovered: stats.revenue_recovered
      },
      updated_contacts: stats.updated_contacts
    });

  } catch (error) {
    logger.error(`Error en executeFallback: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al ejecutar fallback attribution'
    });
  }
};
