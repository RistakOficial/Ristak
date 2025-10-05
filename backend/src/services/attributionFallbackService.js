import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';

/**
 * Sistema de Fallback Attribution
 * Recupera atribución de contactos con URL válida pero ad_id inválido/vacío
 */

/**
 * Construye el mapeo URL → ad_id dominante
 * Solo incluye URLs donde un ad_id tiene >80% de consenso
 */
async function buildUrlToAdIdMapping() {
  const query = `
    WITH url_ad_stats AS (
      SELECT
        attribution_url as url,
        attribution_ad_id as ad_id,
        COUNT(*) as contacts_count
      FROM contacts
      WHERE attribution_url IS NOT NULL
        AND attribution_url != ''
        AND attribution_ad_id IS NOT NULL
        AND attribution_ad_id != ''
      GROUP BY attribution_url, attribution_ad_id
    ),
    url_totals AS (
      SELECT
        url,
        SUM(contacts_count) as total_contacts
      FROM url_ad_stats
      GROUP BY url
    )
    SELECT
      s.url,
      s.ad_id as dominant_ad_id,
      s.contacts_count,
      t.total_contacts,
      ROUND(s.contacts_count * 100.0 / t.total_contacts, 1) as percentage
    FROM url_ad_stats s
    JOIN url_totals t ON s.url = t.url
    WHERE (s.contacts_count * 100.0 / t.total_contacts) >= 80
    ORDER BY t.total_contacts DESC
  `;

  const rows = await db.all(query);

  // Convertir a Map para búsqueda rápida
  const mapping = new Map();
  rows.forEach(row => {
    mapping.set(row.url, {
      ad_id: row.dominant_ad_id,
      percentage: row.percentage,
      contacts_count: row.contacts_count
    });
  });

  logger.info(`URL Mapping construido: ${mapping.size} URLs con ad_id dominante (≥80%)`);
  return mapping;
}

/**
 * Obtiene el rango de fechas cuando un ad estuvo activo
 */
async function getAdDateRange(adId) {
  const query = `
    SELECT
      MIN(date) as first_date,
      MAX(date) as last_date
    FROM meta_ads
    WHERE ad_id = ?
  `;

  const row = await db.get(query, [adId]);
  return row;
}

/**
 * Verifica si una fecha está dentro del rango de actividad del ad
 */
function isDateInRange(contactDate, adDateRange) {
  if (!adDateRange || !adDateRange.first_date || !adDateRange.last_date) {
    return false;
  }

  return contactDate >= adDateRange.first_date && contactDate <= adDateRange.last_date;
}

/**
 * Encuentra contactos candidatos para fallback
 * (tienen URL pero no tienen ad_id válido)
 */
async function findFallbackCandidates() {
  const query = `
    SELECT
      c.id,
      c.full_name,
      c.attribution_url as url,
      c.attribution_ad_id as current_ad_id,
      DATE(c.created_at) as contact_date,
      c.total_paid
    FROM contacts c
    WHERE c.attribution_url IS NOT NULL
      AND c.attribution_url != ''
      AND (
        c.attribution_ad_id IS NULL
        OR c.attribution_ad_id = ''
        OR c.attribution_ad_id NOT IN (SELECT DISTINCT ad_id FROM meta_ads)
      )
    ORDER BY c.total_paid DESC
  `;

  const rows = await db.all(query);
  logger.info(`Encontrados ${rows.length} contactos candidatos para fallback`);
  return rows;
}

/**
 * Ejecuta el fallback attribution
 * Devuelve estadísticas de lo que se atribuyó
 */
export async function executeFallbackAttribution() {
  try {
    logger.info('Iniciando Fallback Attribution...');

    // 1. Construir mapeo URL → ad_id dominante
    const urlMapping = await buildUrlToAdIdMapping();

    // 2. Obtener candidatos
    const candidates = await findFallbackCandidates();

    const stats = {
      total_candidates: candidates.length,
      matched_urls: 0,
      date_mismatches: 0,
      successful_updates: 0,
      revenue_recovered: 0,
      updated_contacts: []
    };

    // 3. Procesar cada candidato
    for (const contact of candidates) {
      const mappedAd = urlMapping.get(contact.url);

      if (!mappedAd) {
        // No hay ad_id dominante para esta URL
        continue;
      }

      stats.matched_urls++;

      // Verificar que la fecha del contacto coincida con actividad del ad
      const adDateRange = await getAdDateRange(mappedAd.ad_id);

      if (!isDateInRange(contact.contact_date, adDateRange)) {
        stats.date_mismatches++;
        logger.warn(`Fecha no coincide para ${contact.full_name}: contacto ${contact.contact_date}, ad activo ${adDateRange?.first_date} - ${adDateRange?.last_date}`);
        continue;
      }

      // ✅ Todo coincide - actualizar attribution_ad_id
      await db.run(
        'UPDATE contacts SET attribution_ad_id = ? WHERE id = ?',
        [mappedAd.ad_id, contact.id]
      );

      stats.successful_updates++;
      stats.revenue_recovered += contact.total_paid || 0;
      stats.updated_contacts.push({
        id: contact.id,
        name: contact.full_name,
        url: contact.url,
        old_ad_id: contact.current_ad_id,
        new_ad_id: mappedAd.ad_id,
        revenue: contact.total_paid,
        confidence: `${mappedAd.percentage}%`
      });

      logger.success(`✅ ${contact.full_name}: atribuido a ad ${mappedAd.ad_id} (${mappedAd.percentage}% consenso) - $${contact.total_paid}`);
    }

    logger.info(`
      === FALLBACK ATTRIBUTION COMPLETADO ===
      Candidatos totales: ${stats.total_candidates}
      URLs con mapeo: ${stats.matched_urls}
      Fechas no coincidentes: ${stats.date_mismatches}
      Actualizados exitosamente: ${stats.successful_updates}
      Revenue recuperado: $${stats.revenue_recovered.toFixed(2)}
    `);

    return stats;

  } catch (error) {
    logger.error(`Error en executeFallbackAttribution: ${error.message}`);
    throw error;
  }
}

/**
 * Obtiene vista previa de qué se actualizaría (sin modificar BD)
 */
export async function previewFallbackAttribution() {
  try {
    logger.info('Generando preview de Fallback Attribution...');

    const urlMapping = await buildUrlToAdIdMapping();
    const candidates = await findFallbackCandidates();

    const preview = {
      total_candidates: candidates.length,
      would_update: [],
      would_skip: []
    };

    for (const contact of candidates) {
      const mappedAd = urlMapping.get(contact.url);

      if (!mappedAd) {
        preview.would_skip.push({
          name: contact.full_name,
          reason: 'No dominant ad_id for URL',
          url: contact.url
        });
        continue;
      }

      const adDateRange = await getAdDateRange(mappedAd.ad_id);

      if (!isDateInRange(contact.contact_date, adDateRange)) {
        preview.would_skip.push({
          name: contact.full_name,
          reason: 'Date mismatch',
          contact_date: contact.contact_date,
          ad_active: `${adDateRange?.first_date} - ${adDateRange?.last_date}`
        });
        continue;
      }

      preview.would_update.push({
        name: contact.full_name,
        url: contact.url,
        current_ad_id: contact.current_ad_id || 'NONE',
        new_ad_id: mappedAd.ad_id,
        confidence: `${mappedAd.percentage}%`,
        revenue: contact.total_paid
      });
    }

    return preview;

  } catch (error) {
    logger.error(`Error en previewFallbackAttribution: ${error.message}`);
    throw error;
  }
}
