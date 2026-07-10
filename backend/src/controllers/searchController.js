import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import {
  buildContactSearchClause,
  buildContactSearchRank,
  containsPattern,
  textFoldExpression
} from '../utils/searchText.js'
import { DEFAULT_TIMEZONE, getAccountTimezone, normalizeDateOnlyInTimezone } from '../utils/dateUtils.js'
import { timestampSortExpression } from '../utils/sqlTimestampSort.js'
import { hasFeature, hasModuleFeature, isLicenseEnforced } from '../services/licenseService.js'
import { hasUserAccess } from '../utils/userAccess.js'
// (ACL-002) Excluir contactos ocultos también en la búsqueda global.
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'

const CATEGORY_LIMIT = 6
const INACTIVE_APPOINTMENT_STATUSES = [
  'cancelled',
  'canceled',
  'no_show',
  'noshow',
  'invalid',
  'failed',
  'missed',
  'deleted',
  'void',
  'voided'
]
const ACTIVE_APPOINTMENT_CONDITION = `LOWER(COALESCE(appointment_status, status, '')) NOT IN (${INACTIVE_APPOINTMENT_STATUSES.map(status => `'${status}'`).join(', ')})`

const safeText = (value) => (value === null || value === undefined ? '' : String(value))

const formatDate = (value, timezone = DEFAULT_TIMEZONE) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return safeText(value).slice(0, 10)
  }
  return normalizeDateOnlyInTimezone(date.toISOString(), timezone)
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

const canSearchModule = async (req, moduleKey) => {
  if (!hasUserAccess(req.user, moduleKey, 'read')) return false
  if (!isLicenseEnforced()) return true
  return hasModuleFeature(moduleKey)
}

const canSearchFeature = async (featureKey) => {
  if (!isLicenseEnforced()) return true
  return hasFeature(featureKey)
}

export const globalSearch = async (req, res) => {
  try {
    const rawQuery = safeText(req.query.q).trim()
    const timezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)

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

    // (ACL-002) Condición para excluir contactos ocultos. Se aplica a la categoría
    // de contactos y a las filas de citas/pagos que exponen PII del contacto vía JOIN.
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenContactCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
    const hiddenAnd = hiddenContactCondition ? ` AND ${hiddenContactCondition}` : ''
    const hiddenOrExclude = hiddenContactCondition ? ` AND ${hiddenContactCondition}` : ''
    const contactCreatedSort = timestampSortExpression('c.created_at')
    const appointmentStartSort = timestampSortExpression('a.start_time')
    const paymentDateSort = timestampSortExpression('p.date')
    const paymentCreatedSort = timestampSortExpression('p.created_at')
    const paymentPlanNextRunSort = timestampSortExpression('pp.next_run_at')
    const paymentPlanUpdatedSort = timestampSortExpression('pp.updated_at')
    const automationUpdatedSort = timestampSortExpression('aut.updated_at')
    const calendarUpdatedSort = timestampSortExpression('cal.updated_at')
    const userUpdatedSort = timestampSortExpression('u.updated_at')

    const [
      canSearchContacts,
      canSearchAppointments,
      canSearchPayments,
      canSearchPaymentPlans,
      canSearchAutomations,
      canSearchUsers,
      canSearchCampaigns
    ] = await Promise.all([
      canSearchModule(req, 'contacts'),
      canSearchModule(req, 'appointments'),
      canSearchModule(req, 'payments'),
      Promise.all([
        canSearchModule(req, 'payments'),
        canSearchFeature('payment_plans')
      ]).then(([moduleAllowed, featureAllowed]) => moduleAllowed && featureAllowed),
      canSearchModule(req, 'automations'),
      canSearchModule(req, 'settings_users'),
      canSearchModule(req, 'campaigns')
    ])

    const [
      contacts,
      appointments,
      payments,
      paymentPlans,
      automations,
      calendars,
      users,
      campaigns,
      adsets,
      ads
    ] = await Promise.all([
      canSearchContacts ? runCategoryQuery('contactos', () => db.all(
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
          (
            SELECT COUNT(*) > 0
            FROM appointments
            WHERE contact_id = c.id
              AND ${ACTIVE_APPOINTMENT_CONDITION}
          ) AS has_appointments
        FROM contacts c
        WHERE ${contactSearchClause.condition} AND c.deleted_at IS NULL${hiddenAnd}
        ORDER BY ${contactSearchRank.expression} DESC, ${contactCreatedSort} DESC, c.id DESC
        LIMIT ?`,
        [...contactSearchClause.params, ...contactSearchRank.params, CATEGORY_LIMIT]
      )) : [],
      canSearchAppointments ? runCategoryQuery('citas', () => db.all(
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
          (${textFoldExpression('a.title')} LIKE ? OR
          ${textFoldExpression('a.status')} LIKE ? OR
          ${textFoldExpression('a.appointment_status')} LIKE ? OR
          ${basicContactSearchClause.condition} OR
          CAST(a.start_time AS TEXT) LIKE ?)${hiddenOrExclude}
        ORDER BY ${appointmentStartSort} DESC, a.id DESC
        LIMIT ?`,
        [foldedLike, foldedLike, foldedLike, ...basicContactSearchClause.params, like, CATEGORY_LIMIT]
      )) : [],
      canSearchPayments ? runCategoryQuery('pagos', () => db.all(
        `SELECT
          p.id,
          p.contact_id,
          p.amount,
          p.currency,
          p.status,
          p.payment_method,
          p.payment_mode,
          p.payment_provider,
          p.reference,
          p.title,
          p.description,
          p.public_payment_id,
          p.date,
          c.full_name AS contact_name,
          c.first_name AS contact_first_name,
          c.last_name AS contact_last_name,
          c.email AS contact_email,
          c.phone AS contact_phone
        FROM payments p
        LEFT JOIN contacts c ON c.id = p.contact_id
        WHERE
          (${basicContactSearchClause.condition} OR
          ${textFoldExpression('p.id')} LIKE ? OR
          ${textFoldExpression('p.public_payment_id')} LIKE ? OR
          ${textFoldExpression('p.title')} LIKE ? OR
          ${textFoldExpression('p.status')} LIKE ? OR
          ${textFoldExpression('p.payment_method')} LIKE ? OR
          ${textFoldExpression('p.payment_provider')} LIKE ? OR
          ${textFoldExpression('p.payment_mode')} LIKE ? OR
          ${textFoldExpression('p.reference')} LIKE ? OR
          ${textFoldExpression('p.description')} LIKE ? OR
          CAST(p.amount AS TEXT) LIKE ? OR
          CAST(p.date AS TEXT) LIKE ?)${hiddenOrExclude}
        ORDER BY ${paymentDateSort} DESC, ${paymentCreatedSort} DESC, p.id DESC
        LIMIT ?`,
        [
          ...basicContactSearchClause.params,
          foldedLike,
          foldedLike,
          foldedLike,
          foldedLike,
          foldedLike,
          foldedLike,
          foldedLike,
          foldedLike,
          foldedLike,
          like,
          like,
          CATEGORY_LIMIT
        ]
      )) : [],
      canSearchPaymentPlans ? runCategoryQuery('planes de pago', () => db.all(
        `SELECT
          pp.id,
          pp.contact_id,
          pp.name,
          pp.title,
          pp.status,
          pp.total,
          pp.currency,
          pp.description,
          pp.recurrence_label,
          pp.start_date,
          pp.next_run_at,
          pp.source,
          pp.contact_name AS plan_contact_name,
          c.full_name AS contact_name,
          c.first_name AS contact_first_name,
          c.last_name AS contact_last_name,
          c.email AS contact_email,
          c.phone AS contact_phone
        FROM payment_plans pp
        LEFT JOIN contacts c ON c.id = pp.contact_id
        WHERE
          (${basicContactSearchClause.condition} OR
          ${textFoldExpression('pp.contact_name')} LIKE ? OR
          ${textFoldExpression('pp.id')} LIKE ? OR
          ${textFoldExpression('pp.name')} LIKE ? OR
          ${textFoldExpression('pp.title')} LIKE ? OR
          ${textFoldExpression('pp.status')} LIKE ? OR
          ${textFoldExpression('pp.description')} LIKE ? OR
          ${textFoldExpression('pp.recurrence_label')} LIKE ? OR
          ${textFoldExpression('pp.source')} LIKE ? OR
          CAST(pp.total AS TEXT) LIKE ? OR
          CAST(pp.start_date AS TEXT) LIKE ? OR
          CAST(pp.next_run_at AS TEXT) LIKE ?)${hiddenOrExclude}
        ORDER BY ${paymentPlanNextRunSort} DESC, ${paymentPlanUpdatedSort} DESC, pp.id DESC
        LIMIT ?`,
        [
          ...basicContactSearchClause.params,
          foldedLike,
          foldedLike,
          foldedLike,
          foldedLike,
          foldedLike,
          foldedLike,
          foldedLike,
          foldedLike,
          like,
          like,
          like,
          CATEGORY_LIMIT
        ]
      )) : [],
      canSearchAutomations ? runCategoryQuery('automatizaciones', () => db.all(
        `SELECT
          aut.id,
          aut.name,
          aut.status,
          aut.description,
          aut.updated_at,
          aut.published_at
        FROM automations aut
        WHERE
          ${textFoldExpression('aut.id')} LIKE ? OR
          ${textFoldExpression('aut.name')} LIKE ? OR
          ${textFoldExpression('aut.status')} LIKE ? OR
          ${textFoldExpression('aut.description')} LIKE ?
        ORDER BY ${automationUpdatedSort} DESC, aut.id DESC
        LIMIT ?`,
        [foldedLike, foldedLike, foldedLike, foldedLike, CATEGORY_LIMIT]
      )) : [],
      canSearchAppointments ? runCategoryQuery('calendarios', () => db.all(
        `SELECT
          cal.id,
          cal.ghl_calendar_id,
          cal.name,
          cal.slug,
          cal.calendar_type,
          cal.event_title,
          cal.source,
          cal.is_active,
          cal.updated_at
        FROM calendars cal
        WHERE
          ${textFoldExpression('cal.id')} LIKE ? OR
          ${textFoldExpression('cal.ghl_calendar_id')} LIKE ? OR
          ${textFoldExpression('cal.name')} LIKE ? OR
          ${textFoldExpression('cal.slug')} LIKE ? OR
          ${textFoldExpression('cal.event_title')} LIKE ? OR
          ${textFoldExpression('cal.source')} LIKE ?
        ORDER BY cal.is_active DESC, ${calendarUpdatedSort} DESC, cal.name ASC
        LIMIT ?`,
        [foldedLike, foldedLike, foldedLike, foldedLike, foldedLike, foldedLike, CATEGORY_LIMIT]
      )) : [],
      canSearchUsers ? runCategoryQuery('usuarios', () => db.all(
        `SELECT
          u.id,
          u.username,
          u.email,
          u.full_name,
          u.role,
          u.is_active,
          u.updated_at
        FROM users u
        WHERE
          COALESCE(u.is_active, 1) != 0 AND (
            ${textFoldExpression('CAST(u.id AS TEXT)')} LIKE ? OR
            ${textFoldExpression('u.username')} LIKE ? OR
            ${textFoldExpression('u.email')} LIKE ? OR
            ${textFoldExpression('u.full_name')} LIKE ? OR
            ${textFoldExpression('u.role')} LIKE ?
          )
        ORDER BY ${userUpdatedSort} DESC, u.full_name ASC, u.username ASC
        LIMIT ?`,
        [foldedLike, foldedLike, foldedLike, foldedLike, foldedLike, CATEGORY_LIMIT]
      )) : [],
      canSearchCampaigns ? runCategoryQuery('campañas', () => db.all(
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
      )) : [],
      canSearchCampaigns ? runCategoryQuery('conjuntos', () => db.all(
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
      )) : [],
      canSearchCampaigns ? runCategoryQuery('anuncios', () => db.all(
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
      )) : []
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
            meta: joinParts(status, formatMoney(contact.total_paid || 0), formatDate(contact.created_at, timezone))
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
            meta: joinParts(formatDate(appointment.start_time, timezone), appointment.appointment_status || appointment.status),
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
            title: joinParts(payment.title || payment.public_payment_id || payment.reference || formatMoney(payment.amount, payment.currency), contactName || 'Pago sin contacto'),
            subtitle: joinParts(formatMoney(payment.amount, payment.currency), payment.description, payment.reference),
            meta: joinParts(formatDate(payment.date, timezone), payment.status, payment.payment_method, payment.payment_provider, payment.payment_mode),
            metadata: {
              contactId: payment.contact_id
            }
          }
        })
      },
      {
        id: 'payment_plans',
        label: 'Planes de pago',
        items: paymentPlans.map((plan) => {
          const contactName = plan.contact_name || plan.plan_contact_name || joinName(plan.contact_first_name, plan.contact_last_name)
          const planName = plan.name || plan.title || 'Plan de pago'

          return {
            type: 'payment_plan',
            id: plan.id,
            title: joinParts(planName, contactName),
            subtitle: joinParts(formatMoney(plan.total, plan.currency), plan.recurrence_label, plan.description),
            meta: joinParts(formatDate(plan.next_run_at || plan.start_date, timezone), plan.status, plan.source),
            metadata: {
              contactId: plan.contact_id
            }
          }
        })
      },
      {
        id: 'automations',
        label: 'Automatizaciones',
        items: automations.map((automation) => ({
          type: 'automation',
          id: automation.id,
          title: automation.name || automation.id,
          subtitle: joinParts('Automatización', automation.description),
          meta: joinParts(automation.status, formatDate(automation.published_at || automation.updated_at, timezone)),
          metadata: {
            automationId: automation.id
          }
        }))
      },
      {
        id: 'calendars',
        label: 'Calendarios',
        items: calendars.map((calendar) => ({
          type: 'calendar',
          id: calendar.id,
          title: calendar.name || calendar.event_title || calendar.id,
          subtitle: joinParts(calendar.event_title, calendar.slug, calendar.ghl_calendar_id),
          meta: joinParts(calendar.is_active ? 'Activo' : 'Inactivo', calendar.calendar_type, calendar.source),
          metadata: {
            calendarId: calendar.id,
            ghlCalendarId: calendar.ghl_calendar_id
          }
        }))
      },
      {
        id: 'users',
        label: 'Usuarios',
        items: users.map((user) => ({
          type: 'user',
          id: String(user.id),
          title: user.full_name || user.username || user.email || `Usuario ${user.id}`,
          subtitle: joinParts(user.email, user.username),
          meta: joinParts(user.role, user.is_active ? 'Activo' : 'Inactivo'),
          metadata: {
            userId: user.id
          }
        }))
      },
      {
        id: 'campaigns',
        label: 'Campañas',
        items: campaigns.map((campaign) => ({
          type: 'campaign',
          id: campaign.id,
          title: campaign.name || campaign.id,
          subtitle: 'Campaña de Meta',
          meta: joinParts(formatMoney(campaign.spend), `${Number(campaign.clicks || 0).toLocaleString('es-MX')} clicks`, formatDate(campaign.last_date, timezone)),
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
          meta: joinParts(formatMoney(adset.spend), `${Number(adset.clicks || 0).toLocaleString('es-MX')} clicks`, formatDate(adset.last_date, timezone)),
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
          meta: joinParts(formatMoney(ad.spend), `${Number(ad.clicks || 0).toLocaleString('es-MX')} clicks`, formatDate(ad.last_date, timezone)),
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
