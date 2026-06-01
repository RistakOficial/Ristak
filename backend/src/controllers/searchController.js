import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import {
  buildContactSearchClause,
  buildContactSearchRank,
  containsPattern,
  textFoldExpression
} from '../utils/searchText.js'

const CATEGORY_LIMIT = 6

const safeText = (value) => (value === null || value === undefined ? '' : String(value))

const formatDate = (value) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return safeText(value).slice(0, 10)
  }
  return date.toISOString().slice(0, 10)
}

const formatMoney = (amount, currency = 'MXN') => {
  const numericAmount = Number(amount || 0)
  try {
    return numericAmount.toLocaleString('es-MX', {
      style: 'currency',
      currency: currency || 'MXN',
      maximumFractionDigits: 0
    })
  } catch {
    return `$${numericAmount.toLocaleString('es-MX')}`
  }
}

const joinParts = (...parts) => parts
  .map(safeText)
  .map((part) => part.trim())
  .filter(Boolean)
  .join(' · ')

const joinName = (...parts) => parts
  .map(safeText)
  .map((part) => part.trim())
  .filter(Boolean)
  .join(' ')

const runCategoryQuery = async (label, queryFn) => {
  try {
    return await queryFn()
  } catch (error) {
    logger.warn(`[Global Search] No se pudo buscar en ${label}: ${error.message}`)
    return []
  }
}

export const globalSearch = async (req, res) => {
  try {
    const rawQuery = safeText(req.query.q).trim()

    if (!rawQuery) {
      return res.json({
        success: true,
        data: {
          categories: [],
          total: 0
        }
      })
    }

    const like = `%${rawQuery}%`
    const foldedLike = containsPattern(rawQuery) || '__no_text_match__'
    const contactSearchClause = buildContactSearchClause('c', rawQuery, {
      includeSource: true,
      includeAdName: true
    })
    const contactSearchRank = buildContactSearchRank('c', rawQuery, {
      includeSource: true,
      includeAdName: true
    })
    const basicContactSearchClause = buildContactSearchClause('c', rawQuery)

    const [
      contacts,
      appointments,
      payments,
      campaigns,
      adsets,
      ads
    ] = await Promise.all([
      runCategoryQuery('contactos', () => db.all(
        `SELECT
          c.id,
          c.full_name,
          c.first_name,
          c.last_name,
          c.email,
          c.phone,
          c.source,
          c.created_at,
          c.total_paid,
          c.purchases_count,
          (SELECT COUNT(*) > 0 FROM appointments WHERE contact_id = c.id) AS has_appointments
        FROM contacts c
        WHERE ${contactSearchClause.condition}
        ORDER BY ${contactSearchRank.expression} DESC, c.created_at DESC
        LIMIT ?`,
        [...contactSearchClause.params, ...contactSearchRank.params, CATEGORY_LIMIT]
      )),
      runCategoryQuery('citas', () => db.all(
        `SELECT
          a.id,
          a.calendar_id,
          a.contact_id,
          a.title,
          a.status,
          a.appointment_status,
          a.start_time,
          a.end_time,
          c.full_name AS contact_name,
          c.first_name AS contact_first_name,
          c.last_name AS contact_last_name,
          c.email AS contact_email,
          c.phone AS contact_phone
        FROM appointments a
        LEFT JOIN contacts c ON c.id = a.contact_id
        WHERE
          ${textFoldExpression('a.title')} LIKE ? OR
          ${textFoldExpression('a.status')} LIKE ? OR
          ${textFoldExpression('a.appointment_status')} LIKE ? OR
          ${basicContactSearchClause.condition} OR
          CAST(a.start_time AS TEXT) LIKE ?
        ORDER BY a.start_time DESC
        LIMIT ?`,
        [foldedLike, foldedLike, foldedLike, ...basicContactSearchClause.params, like, CATEGORY_LIMIT]
      )),
      runCategoryQuery('pagos', () => db.all(
        `SELECT
          p.id,
          p.contact_id,
          p.amount,
          p.currency,
          p.status,
          p.payment_method,
          p.reference,
          p.description,
          p.date,
          c.full_name AS contact_name,
          c.first_name AS contact_first_name,
          c.last_name AS contact_last_name,
          c.email AS contact_email,
          c.phone AS contact_phone
        FROM payments p
        LEFT JOIN contacts c ON c.id = p.contact_id
        WHERE
          ${basicContactSearchClause.condition} OR
          ${textFoldExpression('p.status')} LIKE ? OR
          ${textFoldExpression('p.payment_method')} LIKE ? OR
          ${textFoldExpression('p.reference')} LIKE ? OR
          ${textFoldExpression('p.description')} LIKE ? OR
          CAST(p.amount AS TEXT) LIKE ? OR
          CAST(p.date AS TEXT) LIKE ?
        ORDER BY p.date DESC
        LIMIT ?`,
        [...basicContactSearchClause.params, foldedLike, foldedLike, foldedLike, foldedLike, like, like, CATEGORY_LIMIT]
      )),
      runCategoryQuery('campañas', () => db.all(
        `SELECT
          campaign_id AS id,
          MAX(campaign_name) AS name,
          MAX(date) AS last_date,
          COALESCE(SUM(spend), 0) AS spend,
          COALESCE(SUM(clicks), 0) AS clicks
        FROM meta_ads
        WHERE
          ${textFoldExpression('campaign_name')} LIKE ? OR
          ${textFoldExpression('campaign_id')} LIKE ?
        GROUP BY campaign_id
        ORDER BY MAX(date) DESC
        LIMIT ?`,
        [foldedLike, foldedLike, CATEGORY_LIMIT]
      )),
      runCategoryQuery('conjuntos', () => db.all(
        `SELECT
          adset_id AS id,
          MAX(adset_name) AS name,
          campaign_id,
          MAX(campaign_name) AS campaign_name,
          MAX(date) AS last_date,
          COALESCE(SUM(spend), 0) AS spend,
          COALESCE(SUM(clicks), 0) AS clicks
        FROM meta_ads
        WHERE
          ${textFoldExpression('adset_name')} LIKE ? OR
          ${textFoldExpression('adset_id')} LIKE ?
        GROUP BY campaign_id, adset_id
        ORDER BY MAX(date) DESC
        LIMIT ?`,
        [foldedLike, foldedLike, CATEGORY_LIMIT]
      )),
      runCategoryQuery('anuncios', () => db.all(
        `SELECT
          ad_id AS id,
          MAX(ad_name) AS name,
          campaign_id,
          MAX(campaign_name) AS campaign_name,
          adset_id,
          MAX(adset_name) AS adset_name,
          MAX(date) AS last_date,
          COALESCE(SUM(spend), 0) AS spend,
          COALESCE(SUM(clicks), 0) AS clicks
        FROM meta_ads
        WHERE
          ${textFoldExpression('ad_name')} LIKE ? OR
          ${textFoldExpression('ad_id')} LIKE ?
        GROUP BY campaign_id, adset_id, ad_id
        ORDER BY MAX(date) DESC
        LIMIT ?`,
        [foldedLike, foldedLike, CATEGORY_LIMIT]
      ))
    ])

    const categories = [
      {
        id: 'contacts',
        label: 'Contactos',
        items: contacts.map((contact) => {
          const name = contact.full_name || joinName(contact.first_name, contact.last_name)
          const status = Number(contact.purchases_count || 0) > 0
            ? 'Cliente'
            : contact.has_appointments
              ? 'Citado'
              : 'Lead'

          return {
            type: 'contact',
            id: contact.id,
            title: name || contact.email || contact.phone || 'Contacto sin nombre',
            subtitle: joinParts(contact.email, contact.phone),
            meta: joinParts(status, formatMoney(contact.total_paid || 0), formatDate(contact.created_at))
          }
        })
      },
      {
        id: 'appointments',
        label: 'Citas',
        items: appointments.map((appointment) => {
          const contactName = appointment.contact_name || joinName(appointment.contact_first_name, appointment.contact_last_name)

          return {
            type: 'appointment',
            id: appointment.id,
            title: appointment.title || contactName || 'Cita sin título',
            subtitle: joinParts(contactName, appointment.contact_email, appointment.contact_phone),
            meta: joinParts(formatDate(appointment.start_time), appointment.appointment_status || appointment.status),
            metadata: {
              calendarId: appointment.calendar_id,
              contactId: appointment.contact_id,
              startTime: appointment.start_time
            }
          }
        })
      },
      {
        id: 'payments',
        label: 'Pagos',
        items: payments.map((payment) => {
          const contactName = payment.contact_name || joinName(payment.contact_first_name, payment.contact_last_name)

          return {
            type: 'payment',
            id: payment.id,
            title: joinParts(formatMoney(payment.amount, payment.currency), contactName || 'Pago sin contacto'),
            subtitle: joinParts(payment.description, payment.reference),
            meta: joinParts(formatDate(payment.date), payment.status, payment.payment_method),
            metadata: {
              contactId: payment.contact_id
            }
          }
        })
      },
      {
        id: 'campaigns',
        label: 'Campañas',
        items: campaigns.map((campaign) => ({
          type: 'campaign',
          id: campaign.id,
          title: campaign.name || campaign.id,
          subtitle: 'Campaña de Meta',
          meta: joinParts(formatMoney(campaign.spend), `${Number(campaign.clicks || 0).toLocaleString('es-MX')} clicks`, formatDate(campaign.last_date)),
          metadata: {
            campaignId: campaign.id,
            lastDate: campaign.last_date
          }
        }))
      },
      {
        id: 'adsets',
        label: 'Conjuntos',
        items: adsets.map((adset) => ({
          type: 'adset',
          id: adset.id,
          title: adset.name || adset.id,
          subtitle: joinParts('Conjunto de anuncios', adset.campaign_name),
          meta: joinParts(formatMoney(adset.spend), `${Number(adset.clicks || 0).toLocaleString('es-MX')} clicks`, formatDate(adset.last_date)),
          metadata: {
            campaignId: adset.campaign_id,
            adsetId: adset.id,
            lastDate: adset.last_date
          }
        }))
      },
      {
        id: 'ads',
        label: 'Anuncios',
        items: ads.map((ad) => ({
          type: 'ad',
          id: ad.id,
          title: ad.name || ad.id,
          subtitle: joinParts('Anuncio', ad.campaign_name, ad.adset_name),
          meta: joinParts(formatMoney(ad.spend), `${Number(ad.clicks || 0).toLocaleString('es-MX')} clicks`, formatDate(ad.last_date)),
          metadata: {
            campaignId: ad.campaign_id,
            adsetId: ad.adset_id,
            adId: ad.id,
            lastDate: ad.last_date
          }
        }))
      }
    ].filter((category) => category.items.length > 0)

    res.json({
      success: true,
      data: {
        categories,
        total: categories.reduce((sum, category) => sum + category.items.length, 0)
      }
    })
  } catch (error) {
    logger.error(`[Global Search] Error buscando: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error buscando en la app'
    })
  }
}
