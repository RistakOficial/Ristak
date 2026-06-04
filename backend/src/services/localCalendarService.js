import crypto from 'crypto'
import { DateTime } from 'luxon'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { normalizeToUtcIso, getAccountTimezone, isValidTimezone } from '../utils/dateUtils.js'
import { finalizePreparedPhoneUpsert, prepareContactPhoneUpsert } from './contactIdentityService.js'
import GHLClient from './ghlClient.js'
import * as highlevelCalendarService from './highlevelCalendarService.js'
import { getSitesPublicDomain } from './sitesService.js'

const LOCAL_CALENDAR_PREFIX = 'rstk_cal'
const LOCAL_APPOINTMENT_PREFIX = 'rstk_appt'
const DEFAULT_EVENT_COLOR = '#3b82f6'

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

function cleanString(value) {
  return String(value ?? '').trim()
}

function toInt(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toBoolInt(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback ? 1 : 0
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return value ? 1 : 0
  return ['1', 'true', 'yes', 'on', 'active'].includes(String(value).trim().toLowerCase()) ? 1 : 0
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function jsonOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function slugify(value, fallback = '') {
  const raw = cleanString(value || fallback || 'calendario')
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `calendario-${Date.now()}`
}

function decodeSegment(value) {
  try {
    return cleanString(decodeURIComponent(String(value || '')))
  } catch {
    return cleanString(value)
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function jsonForInlineScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function publicCalendarSlug(calendar = {}) {
  return cleanString(calendar.slug || calendar.widgetSlug || calendar.id) || slugify(calendar.name || calendar.id)
}

function publicCalendarPath(calendar = {}) {
  return `/calendar/${encodeURIComponent(publicCalendarSlug(calendar))}`
}

export async function getCalendarPublicUrlStatus() {
  const domainConfig = await getSitesPublicDomain()

  if (!domainConfig.domain) {
    return {
      enabled: false,
      domain: '',
      reason: 'Conecta y verifica el dominio publico general para activar URLs publicas de calendarios.'
    }
  }

  if (!domainConfig.renderDomainVerified) {
    return {
      enabled: false,
      domain: domainConfig.domain,
      reason: 'El dominio publico general existe, pero todavia no responde a esta app.'
    }
  }

  return {
    enabled: true,
    domain: domainConfig.domain,
    reason: ''
  }
}

export function attachPublicCalendarUrl(calendar = {}, status = null) {
  const path = publicCalendarPath(calendar)
  const enabled = Boolean(status?.enabled && calendar.isActive !== false)
  return {
    ...calendar,
    publicBookingPath: path,
    publicBaseDomain: status?.domain || '',
    publicUrlEnabled: enabled,
    publicUrl: enabled ? `https://${status.domain}${path}` : '',
    publicUrlUnavailableReason: calendar.isActive === false
      ? 'Este calendario esta inactivo.'
      : status?.reason || ''
  }
}

export async function attachPublicCalendarUrls(calendars = []) {
  const status = await getCalendarPublicUrlStatus()
  return calendars.map(calendar => attachPublicCalendarUrl(calendar, status))
}

function normalizeTeamMembers(value) {
  const parsed = parseJson(value, value)
  if (!Array.isArray(parsed)) return []

  return parsed
    .map((member, index) => {
      const userId = cleanString(member?.userId || member?.user_id || member?.id || member?.user?.id)
      if (!userId) return null
      return {
        userId,
        priority: Number.isFinite(Number(member.priority)) ? Number(member.priority) : 0.5,
        isPrimary: member.isPrimary !== undefined ? Boolean(member.isPrimary) : index === 0,
        ...(Array.isArray(member.locationConfigurations) ? { locationConfigurations: member.locationConfigurations } : {})
      }
    })
    .filter(Boolean)
}

function normalizeLocationConfigurations(value) {
  const parsed = parseJson(value, value)
  return Array.isArray(parsed) ? parsed : []
}

function normalizeOpenHours(value) {
  const parsed = parseJson(value, value)
  return Array.isArray(parsed) ? parsed : []
}

function calendarRowToApi(row = {}) {
  const teamMembers = normalizeTeamMembers(row.team_members)
  const locationConfigurations = normalizeLocationConfigurations(row.location_configurations)
  const openHours = normalizeOpenHours(row.open_hours)

  return {
    id: row.id,
    ghlCalendarId: row.ghl_calendar_id || null,
    locationId: row.location_id || '',
    groupId: row.group_id || undefined,
    name: row.name || 'Calendario',
    description: row.description || '',
    slug: row.slug || '',
    widgetSlug: row.widget_slug || row.slug || '',
    calendarType: row.calendar_type || 'event',
    widgetType: row.widget_type || 'classic',
    eventTitle: row.event_title || row.name || 'Cita',
    eventColor: row.event_color || DEFAULT_EVENT_COLOR,
    isActive: row.is_active !== 0,
    teamMembers,
    locationConfigurations,
    slotDuration: toInt(row.slot_duration, 60),
    slotDurationUnit: row.slot_duration_unit || 'mins',
    slotInterval: toInt(row.slot_interval, toInt(row.slot_duration, 60)),
    slotIntervalUnit: row.slot_interval_unit || 'mins',
    slotBuffer: toInt(row.slot_buffer, 0),
    slotBufferUnit: row.slot_buffer_unit || 'mins',
    preBuffer: toInt(row.pre_buffer, 0),
    preBufferUnit: row.pre_buffer_unit || 'mins',
    appoinmentPerSlot: toInt(row.appoinment_per_slot, 1),
    appoinmentPerDay: toInt(row.appoinment_per_day, 0),
    allowBookingAfter: toInt(row.allow_booking_after, 0),
    allowBookingAfterUnit: row.allow_booking_after_unit || 'hours',
    allowBookingFor: toInt(row.allow_booking_for, 30),
    allowBookingForUnit: row.allow_booking_for_unit || 'days',
    openHours,
    autoConfirm: row.auto_confirm !== 0,
    allowReschedule: row.allow_reschedule !== 0,
    allowCancellation: row.allow_cancellation !== 0,
    notes: row.notes || '',
    availabilityType: toInt(row.availability_type, 0),
    source: row.source || 'ristak',
    syncStatus: row.sync_status || 'pending',
    syncError: row.sync_error || null,
    lastSyncedAt: row.last_synced_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function normalizeCalendarRecord(raw = {}, options = {}) {
  const calendar = raw.calendar && typeof raw.calendar === 'object' ? raw.calendar : raw
  const source = options.source || calendar.source || (calendar.id && !String(calendar.id).startsWith(LOCAL_CALENDAR_PREFIX) ? 'ghl' : 'ristak')
  const ghlCalendarId = cleanString(options.ghlCalendarId || calendar.ghlCalendarId || calendar.ghl_calendar_id || (source === 'ghl' ? calendar.id : '')) || null
  const id = cleanString(options.id || calendar.localId || calendar.local_id || calendar.ristakCalendarId || calendar.id) ||
    makeId(LOCAL_CALENDAR_PREFIX)
  const name = cleanString(calendar.name || calendar.title || calendar.calendarName || 'Calendario Ristak')
  const slotDuration = toInt(calendar.slotDuration ?? calendar.slot_duration, 60)

  return {
    id,
    ghlCalendarId,
    locationId: cleanString(options.locationId || calendar.locationId || calendar.location_id || ''),
    name,
    description: cleanString(calendar.description || ''),
    slug: cleanString(calendar.slug || '') || slugify(name, id),
    widgetSlug: cleanString(calendar.widgetSlug || calendar.widget_slug || calendar.slug || '') || slugify(name, id),
    calendarType: cleanString(calendar.calendarType || calendar.calendar_type || 'event') || 'event',
    widgetType: cleanString(calendar.widgetType || calendar.widget_type || 'classic') || 'classic',
    eventTitle: cleanString(calendar.eventTitle || calendar.event_title || name || 'Cita'),
    eventColor: cleanString(calendar.eventColor || calendar.event_color || DEFAULT_EVENT_COLOR) || DEFAULT_EVENT_COLOR,
    isActive: toBoolInt(calendar.isActive ?? calendar.is_active, true),
    teamMembers: normalizeTeamMembers(calendar.teamMembers || calendar.team_members),
    locationConfigurations: normalizeLocationConfigurations(calendar.locationConfigurations || calendar.location_configurations),
    slotDuration,
    slotDurationUnit: cleanString(calendar.slotDurationUnit || calendar.slot_duration_unit || 'mins') || 'mins',
    slotInterval: toInt(calendar.slotInterval ?? calendar.slot_interval, slotDuration),
    slotIntervalUnit: cleanString(calendar.slotIntervalUnit || calendar.slot_interval_unit || 'mins') || 'mins',
    slotBuffer: toInt(calendar.slotBuffer ?? calendar.slot_buffer, 0),
    slotBufferUnit: cleanString(calendar.slotBufferUnit || calendar.slot_buffer_unit || 'mins') || 'mins',
    preBuffer: toInt(calendar.preBuffer ?? calendar.pre_buffer, 0),
    preBufferUnit: cleanString(calendar.preBufferUnit || calendar.pre_buffer_unit || 'mins') || 'mins',
    appoinmentPerSlot: toInt(calendar.appoinmentPerSlot ?? calendar.appoinment_per_slot ?? calendar.appointmentPerSlot, 1),
    appoinmentPerDay: toInt(calendar.appoinmentPerDay ?? calendar.appoinment_per_day ?? calendar.appointmentPerDay, 0),
    allowBookingAfter: toInt(calendar.allowBookingAfter ?? calendar.allow_booking_after, 0),
    allowBookingAfterUnit: cleanString(calendar.allowBookingAfterUnit || calendar.allow_booking_after_unit || 'hours') || 'hours',
    allowBookingFor: toInt(calendar.allowBookingFor ?? calendar.allow_booking_for, 30),
    allowBookingForUnit: cleanString(calendar.allowBookingForUnit || calendar.allow_booking_for_unit || 'days') || 'days',
    openHours: normalizeOpenHours(calendar.openHours || calendar.open_hours),
    autoConfirm: toBoolInt(calendar.autoConfirm ?? calendar.auto_confirm, true),
    allowReschedule: toBoolInt(calendar.allowReschedule ?? calendar.allow_reschedule, true),
    allowCancellation: toBoolInt(calendar.allowCancellation ?? calendar.allow_cancellation, true),
    notes: cleanString(calendar.notes || ''),
    availabilityType: toInt(calendar.availabilityType ?? calendar.availability_type, 0),
    source,
    syncStatus: options.syncStatus || calendar.syncStatus || calendar.sync_status || (source === 'ghl' ? 'synced' : 'pending'),
    syncError: options.syncError || calendar.syncError || calendar.sync_error || null,
    rawJson: jsonOrNull(options.rawJson || calendar.raw_json || raw)
  }
}

async function getCalendarByGhlId(ghlCalendarId) {
  if (!ghlCalendarId) return null
  return db.get('SELECT * FROM calendars WHERE ghl_calendar_id = ?', [ghlCalendarId])
}

export async function upsertLocalCalendar(raw = {}, options = {}) {
  const normalized = normalizeCalendarRecord(raw, options)
  const existingByGhl = normalized.ghlCalendarId ? await getCalendarByGhlId(normalized.ghlCalendarId) : null
  if (existingByGhl?.id) {
    normalized.id = existingByGhl.id
  }

  await db.run(`
    INSERT INTO calendars (
      id, ghl_calendar_id, location_id, name, description, slug, widget_slug,
      calendar_type, widget_type, event_title, event_color, is_active,
      team_members, location_configurations, slot_duration, slot_duration_unit,
      slot_interval, slot_interval_unit, slot_buffer, slot_buffer_unit,
      pre_buffer, pre_buffer_unit, appoinment_per_slot, appoinment_per_day,
      allow_booking_after, allow_booking_after_unit, allow_booking_for,
      allow_booking_for_unit, open_hours, auto_confirm, allow_reschedule,
      allow_cancellation, notes, availability_type, source, sync_status,
      sync_error, last_synced_at, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET
      ghl_calendar_id = COALESCE(excluded.ghl_calendar_id, calendars.ghl_calendar_id),
      location_id = COALESCE(excluded.location_id, calendars.location_id),
      name = excluded.name,
      description = excluded.description,
      slug = excluded.slug,
      widget_slug = excluded.widget_slug,
      calendar_type = excluded.calendar_type,
      widget_type = excluded.widget_type,
      event_title = excluded.event_title,
      event_color = excluded.event_color,
      is_active = excluded.is_active,
      team_members = COALESCE(excluded.team_members, calendars.team_members),
      location_configurations = COALESCE(excluded.location_configurations, calendars.location_configurations),
      slot_duration = excluded.slot_duration,
      slot_duration_unit = excluded.slot_duration_unit,
      slot_interval = excluded.slot_interval,
      slot_interval_unit = excluded.slot_interval_unit,
      slot_buffer = excluded.slot_buffer,
      slot_buffer_unit = excluded.slot_buffer_unit,
      pre_buffer = excluded.pre_buffer,
      pre_buffer_unit = excluded.pre_buffer_unit,
      appoinment_per_slot = excluded.appoinment_per_slot,
      appoinment_per_day = excluded.appoinment_per_day,
      allow_booking_after = excluded.allow_booking_after,
      allow_booking_after_unit = excluded.allow_booking_after_unit,
      allow_booking_for = excluded.allow_booking_for,
      allow_booking_for_unit = excluded.allow_booking_for_unit,
      open_hours = COALESCE(excluded.open_hours, calendars.open_hours),
      auto_confirm = excluded.auto_confirm,
      allow_reschedule = excluded.allow_reschedule,
      allow_cancellation = excluded.allow_cancellation,
      notes = excluded.notes,
      availability_type = excluded.availability_type,
      source = excluded.source,
      sync_status = excluded.sync_status,
      sync_error = excluded.sync_error,
      last_synced_at = CASE WHEN excluded.sync_status = 'synced' THEN CURRENT_TIMESTAMP ELSE calendars.last_synced_at END,
      raw_json = COALESCE(excluded.raw_json, calendars.raw_json),
      updated_at = CURRENT_TIMESTAMP
  `, [
    normalized.id,
    normalized.ghlCalendarId,
    normalized.locationId || null,
    normalized.name,
    normalized.description || null,
    normalized.slug,
    normalized.widgetSlug,
    normalized.calendarType,
    normalized.widgetType,
    normalized.eventTitle,
    normalized.eventColor,
    normalized.isActive,
    jsonOrNull(normalized.teamMembers),
    jsonOrNull(normalized.locationConfigurations),
    normalized.slotDuration,
    normalized.slotDurationUnit,
    normalized.slotInterval,
    normalized.slotIntervalUnit,
    normalized.slotBuffer,
    normalized.slotBufferUnit,
    normalized.preBuffer,
    normalized.preBufferUnit,
    normalized.appoinmentPerSlot,
    normalized.appoinmentPerDay,
    normalized.allowBookingAfter,
    normalized.allowBookingAfterUnit,
    normalized.allowBookingFor,
    normalized.allowBookingForUnit,
    jsonOrNull(normalized.openHours),
    normalized.autoConfirm,
    normalized.allowReschedule,
    normalized.allowCancellation,
    normalized.notes || null,
    normalized.availabilityType,
    normalized.source,
    normalized.syncStatus,
    normalized.syncError,
    normalized.syncStatus === 'synced' ? new Date().toISOString() : null,
    normalized.rawJson
  ])

  const row = await getLocalCalendar(normalized.id)
  return row
}

export async function createLocalCalendar(calendarData = {}) {
  return upsertLocalCalendar({
    ...calendarData,
    id: calendarData.id || makeId(LOCAL_CALENDAR_PREFIX),
    source: 'ristak'
  }, {
    source: 'ristak',
    syncStatus: 'pending'
  })
}

export async function getLocalCalendar(calendarId) {
  if (!calendarId) return null
  const row = await db.get(
    'SELECT * FROM calendars WHERE id = ? OR ghl_calendar_id = ? LIMIT 1',
    [calendarId, calendarId]
  )
  return row ? calendarRowToApi(row) : null
}

export async function getPublicCalendarBySlug(slugOrId) {
  const value = decodeSegment(slugOrId)
  if (!value) return null

  const row = await db.get(`
    SELECT *
    FROM calendars
    WHERE COALESCE(is_active, 1) != 0
      AND (id = ? OR slug = ? OR widget_slug = ?)
    ORDER BY
      CASE WHEN id = ? THEN 0 ELSE 1 END,
      LOWER(name) ASC
    LIMIT 1
  `, [value, value, value, value])

  return row ? calendarRowToApi(row) : null
}

export function renderPublicCalendarHtml(calendar, { host = '' } = {}) {
  const slug = publicCalendarSlug(calendar)
  const duration = Math.max(1, toInt(calendar.slotDuration, 60))
  const title = calendar.eventTitle || calendar.name || 'Cita'
  const payload = {
    slug,
    name: calendar.name || 'Calendario',
    description: calendar.description || '',
    eventTitle: title,
    duration,
    color: calendar.eventColor || DEFAULT_EVENT_COLOR,
    host
  }

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(calendar.name || 'Calendario')}</title>
  <meta name="description" content="${escapeHtml(calendar.description || `Agenda ${title}`)}">
  <style>
    :root{--accent:${escapeHtml(calendar.eventColor || DEFAULT_EVENT_COLOR)};--ink:#111827;--muted:#667085;--line:#e5e7eb;--bg:#f6f7f9;--surface:#fff;--danger:#b42318;--ok:#047857}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;letter-spacing:0;line-height:1.5}
    .page{width:min(1040px,calc(100% - 28px));margin:0 auto;padding:clamp(28px,5vw,64px) 0}
    .shell{display:grid;grid-template-columns:minmax(0,.9fr) minmax(320px,1.1fr);gap:22px;align-items:start}
    .intro,.booking{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 30px 70px -52px rgba(15,23,42,.55)}
    .intro{padding:28px;position:sticky;top:22px}
    .booking{padding:22px;display:grid;gap:18px}
    .dot{width:12px;height:12px;border-radius:50%;background:var(--accent);display:inline-block;margin-right:8px}
    h1{margin:10px 0 10px;font-size:clamp(2rem,4vw,3.6rem);line-height:1;letter-spacing:0;font-weight:850}
    h2{font-size:1rem;margin:0 0 8px}
    h3{font-size:.94rem;margin:0 0 10px;color:var(--muted);font-weight:750}
    p{margin:0;color:var(--muted)}
    .meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}
    .pill{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;min-height:34px;padding:0 12px;font-size:.9rem;font-weight:700;color:var(--ink);background:#fff}
    .slotGroups{display:grid;gap:16px}
    .slotGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:10px}
    .slot{min-height:42px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);font:inherit;font-weight:750;cursor:pointer}
    .slot:hover,.slot.selected{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
    .slot.selected{background:var(--accent);color:#fff}
    form{display:grid;gap:12px;border-top:1px solid var(--line);padding-top:18px}
    label{display:grid;gap:6px;font-size:.9rem;font-weight:750}
    input,textarea{width:100%;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);font:inherit;padding:11px 12px;outline:none}
    input:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
    button.submit{min-height:46px;border:1px solid var(--accent);border-radius:10px;background:var(--accent);color:#fff;font:inherit;font-weight:850;cursor:pointer}
    button:disabled{opacity:.58;cursor:not-allowed}
    .message{min-height:22px;font-weight:750;color:var(--muted)}
    .message.error{color:var(--danger)}
    .message.ok{color:var(--ok)}
    .empty{padding:22px;border:1px dashed var(--line);border-radius:12px;color:var(--muted);text-align:center}
    @media (max-width:800px){.shell{grid-template-columns:1fr}.intro{position:static}.page{width:min(100% - 20px,1040px);padding:18px 0}.intro,.booking{border-radius:12px;padding:18px}}
  </style>
</head>
<body>
  <main class="page">
    <div class="shell">
      <section class="intro">
        <span class="pill"><span class="dot" aria-hidden="true"></span>${escapeHtml(title)}</span>
        <h1>${escapeHtml(calendar.name || 'Agenda tu cita')}</h1>
        <p>${escapeHtml(calendar.description || 'Selecciona un horario disponible y deja tus datos para confirmar la cita.')}</p>
        <div class="meta">
          <span class="pill">${duration} min</span>
          <span class="pill">Confirmacion ${calendar.autoConfirm ? 'automatica' : 'pendiente'}</span>
        </div>
      </section>

      <section class="booking">
        <div>
          <h2>Horarios disponibles</h2>
          <p>Elige un horario para continuar.</p>
        </div>
        <div class="slotGroups" data-slots>
          <div class="empty">Cargando horarios...</div>
        </div>
        <form data-form>
          <h2>Tus datos</h2>
          <label>Nombre completo<input name="name" autocomplete="name" required placeholder="Tu nombre"></label>
          <label>Telefono / WhatsApp<input name="phone" autocomplete="tel" inputmode="tel" required placeholder="10 digitos"></label>
          <label>Correo<input name="email" autocomplete="email" type="email" placeholder="tu@email.com"></label>
          <label>Notas<textarea name="notes" rows="3" placeholder="Algo que debamos saber"></textarea></label>
          <button class="submit" type="submit" disabled data-submit>Selecciona un horario</button>
          <p class="message" data-message role="status"></p>
        </form>
      </section>
    </div>
  </main>
  <script>
    (() => {
      const calendar = ${jsonForInlineScript(payload)};
      const slotsEl = document.querySelector('[data-slots]');
      const form = document.querySelector('[data-form]');
      const submit = document.querySelector('[data-submit]');
      const message = document.querySelector('[data-message]');
      let selectedSlot = '';
      let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

      const pad = (value) => String(value).padStart(2, '0');
      const dateKey = (date) => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
      const today = new Date();
      const end = new Date(today);
      end.setDate(today.getDate() + 21);

      const setMessage = (text, type = '') => {
        message.textContent = text || '';
        message.className = 'message' + (type ? ' ' + type : '');
      };

      const formatDay = (iso) => new Intl.DateTimeFormat('es-MX', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: timezone
      }).format(new Date(iso));

      const formatTime = (iso) => new Intl.DateTimeFormat('es-MX', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: timezone
      }).format(new Date(iso));

      const renderSlots = (days) => {
        const groups = (Array.isArray(days) ? days : []).filter(day => Array.isArray(day.slots) && day.slots.length);
        if (!groups.length) {
          slotsEl.innerHTML = '<div class="empty">No hay horarios disponibles en los proximos dias.</div>';
          return;
        }

        timezone = groups.find(day => day.timezone)?.timezone || timezone;
        slotsEl.innerHTML = groups.map(day => {
          const firstSlot = day.slots[0];
          return '<section><h3>' + formatDay(firstSlot) + '</h3><div class="slotGrid">' +
            day.slots.map(slot => '<button type="button" class="slot" data-slot="' + slot + '">' + formatTime(slot) + '</button>').join('') +
            '</div></section>';
        }).join('');
      };

      slotsEl.addEventListener('click', (event) => {
        const button = event.target.closest('[data-slot]');
        if (!button) return;
        selectedSlot = button.getAttribute('data-slot') || '';
        slotsEl.querySelectorAll('.slot').forEach(item => item.classList.remove('selected'));
        button.classList.add('selected');
        submit.disabled = false;
        submit.textContent = 'Agendar cita';
        setMessage('Horario seleccionado: ' + formatDay(selectedSlot) + ' a las ' + formatTime(selectedSlot));
      });

      const loadSlots = async () => {
        try {
          const params = new URLSearchParams({
            startDate: dateKey(today),
            endDate: dateKey(end),
            timezone
          });
          const response = await fetch('/api/calendars/public/' + encodeURIComponent(calendar.slug) + '/free-slots?' + params.toString());
          const payload = await response.json();
          if (!response.ok || payload.success === false) throw new Error(payload.error || 'No se pudieron cargar horarios');
          renderSlots(payload.data || []);
        } catch (error) {
          slotsEl.innerHTML = '<div class="empty">No se pudieron cargar horarios. Intenta mas tarde.</div>';
        }
      };

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!selectedSlot) {
          setMessage('Selecciona un horario primero.', 'error');
          return;
        }

        const formData = new FormData(form);
        submit.disabled = true;
        submit.textContent = 'Agendando...';
        setMessage('');

        try {
          const response = await fetch('/api/calendars/public/' + encodeURIComponent(calendar.slug) + '/appointments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              startTime: selectedSlot,
              timezone,
              sourceUrl: window.location.href,
              name: formData.get('name'),
              phone: formData.get('phone'),
              email: formData.get('email'),
              notes: formData.get('notes')
            })
          });
          const payload = await response.json();
          if (!response.ok || payload.success === false) throw new Error(payload.error || 'No se pudo agendar');
          form.reset();
          selectedSlot = '';
          slotsEl.querySelectorAll('.slot').forEach(item => item.classList.remove('selected'));
          setMessage(payload.data?.message || 'Listo. Tu cita quedo agendada.', 'ok');
          await loadSlots();
        } catch (error) {
          setMessage(error.message || 'No se pudo agendar la cita.', 'error');
        } finally {
          submit.disabled = !selectedSlot;
          submit.textContent = selectedSlot ? 'Agendar cita' : 'Selecciona un horario';
        }
      });

      loadSlots();
    })();
  </script>
</body>
</html>`
}

export async function listLocalCalendars({ sourcePreference = 'combined' } = {}) {
  const filters = []
  const params = []

  if (sourcePreference === 'ristak') {
    filters.push("source = 'ristak'")
  } else if (sourcePreference === 'ghl') {
    filters.push("source = 'ghl'")
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
  const rows = await db.all(`
    SELECT * FROM calendars
    ${where}
    ORDER BY is_active DESC, LOWER(name) ASC
  `, params)

  return rows.map(calendarRowToApi)
}

export async function updateLocalCalendar(calendarId, updateData = {}, { syncStatus = 'pending' } = {}) {
  const existing = await getLocalCalendar(calendarId)
  if (!existing) return null

  return upsertLocalCalendar({
    ...existing,
    ...updateData,
    id: existing.id,
    ghlCalendarId: existing.ghlCalendarId,
    source: existing.source
  }, {
    source: existing.source,
    syncStatus: existing.source === 'ghl' && syncStatus === 'pending' ? 'synced' : syncStatus
  })
}

export async function ensureDefaultLocalCalendar() {
  const existing = await db.get('SELECT * FROM calendars LIMIT 1')
  if (existing) return calendarRowToApi(existing)

  return createLocalCalendar({
    name: 'Calendario Ristak',
    description: 'Calendario principal creado en Ristak',
    eventTitle: 'Cita',
    calendarType: 'event',
    slotDuration: 60,
    slotInterval: 60,
    openHours: [
      {
        daysOfTheWeek: [1, 2, 3, 4, 5],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }]
      }
    ]
  })
}

function appointmentRowToApi(row = {}) {
  return {
    id: row.id,
    ghlAppointmentId: row.ghl_appointment_id || null,
    googleEventId: row.google_event_id || null,
    calendarId: row.calendar_id || '',
    locationId: row.location_id || '',
    contactId: row.contact_id || undefined,
    title: row.title || '(Sin título)',
    status: row.status || row.appointment_status || 'confirmed',
    appointmentStatus: row.appointment_status || row.status || 'confirmed',
    assignedUserId: row.assigned_user_id || undefined,
    notes: row.notes || '',
    address: row.address || '',
    startTime: row.start_time,
    endTime: row.end_time || row.start_time,
    dateAdded: row.date_added || row.created_at || row.start_time,
    dateUpdated: row.date_updated || undefined,
    source: row.source || 'ristak',
    syncStatus: row.sync_status || 'pending',
    syncError: row.sync_error || null,
    syncedAt: row.synced_at || null,
    googleSyncStatus: row.google_sync_status || null,
    googleSyncError: row.google_sync_error || null,
    googleSyncedAt: row.google_synced_at || null,
    contactName: row.contact_name || '',
    contactEmail: row.contact_email || '',
    contactPhone: row.contact_phone || ''
  }
}

function normalizeAppointmentRecord(raw = {}, options = {}) {
  const appointment = raw.appointment && typeof raw.appointment === 'object' ? raw.appointment : raw
  const source = options.source || appointment.source || (appointment.id && !String(appointment.id).startsWith(LOCAL_APPOINTMENT_PREFIX) ? 'ghl' : 'ristak')
  const ghlAppointmentId = cleanString(options.ghlAppointmentId || appointment.ghlAppointmentId || appointment.ghl_appointment_id || (source === 'ghl' ? appointment.id : '')) || null
  const googleEventId = cleanString(options.googleEventId || appointment.googleEventId || appointment.google_event_id || (source === 'google' ? appointment.id : '')) || null
  const appointmentStatus = cleanString(appointment.appointmentStatus || appointment.appointment_status || appointment.status || 'confirmed') || 'confirmed'
  const id = cleanString(options.id || appointment.localId || appointment.local_id || appointment.id) || makeId(LOCAL_APPOINTMENT_PREFIX)

  return {
    id,
    ghlAppointmentId,
    googleEventId,
    calendarId: cleanString(options.calendarId || appointment.calendarId || appointment.calendar_id || ''),
    contactId: cleanString(appointment.contactId || appointment.contact_id || '') || null,
    locationId: cleanString(options.locationId || appointment.locationId || appointment.location_id || '') || null,
    title: cleanString(appointment.title || appointment.name || appointment.summary || 'Cita') || 'Cita',
    status: cleanString(appointment.status || appointmentStatus) || appointmentStatus,
    appointmentStatus,
    assignedUserId: cleanString(appointment.assignedUserId || appointment.assigned_user_id || '') || null,
    notes: cleanString(appointment.notes || appointment.description || '') || null,
    address: cleanString(appointment.address || appointment.location || '') || null,
    startTime: appointment.startTime || appointment.start_time || appointment.start || null,
    endTime: appointment.endTime || appointment.end_time || appointment.end || appointment.startTime || appointment.start_time || null,
    dateAdded: appointment.dateAdded || appointment.date_added || appointment.createdAt || appointment.created_at || new Date().toISOString(),
    dateUpdated: appointment.dateUpdated || appointment.date_updated || appointment.updatedAt || appointment.updated_at || new Date().toISOString(),
    source,
    syncStatus: options.syncStatus || appointment.syncStatus || appointment.sync_status || (source === 'ghl' ? 'synced' : 'pending'),
    syncError: options.syncError || appointment.syncError || appointment.sync_error || null,
    googleSyncStatus: options.googleSyncStatus || appointment.googleSyncStatus || appointment.google_sync_status || (source === 'google' ? 'synced' : null),
    googleSyncError: options.googleSyncError || appointment.googleSyncError || appointment.google_sync_error || null
  }
}

export async function upsertLocalAppointment(raw = {}, options = {}) {
  const normalized = normalizeAppointmentRecord(raw, options)

  // Normalizar TODOS los instantes a UTC real antes de guardar.
  // GHL y el modal mandan ISO con offset (ej "...-06:00"); si la columna es
  // `timestamp` (sin zona) Postgres descartaría el offset y guardaría hora local.
  // Convirtiendo a UTC aquí el instante queda correcto en cualquier tipo de columna.
  const accountZone = await getAccountTimezone()
  normalized.startTime = normalizeToUtcIso(normalized.startTime, accountZone)
  normalized.endTime = normalizeToUtcIso(normalized.endTime, accountZone)
  normalized.dateAdded = normalizeToUtcIso(normalized.dateAdded, accountZone)
  normalized.dateUpdated = normalizeToUtcIso(normalized.dateUpdated, accountZone)

  const existingByGhl = normalized.ghlAppointmentId
    ? await db.get('SELECT id FROM appointments WHERE ghl_appointment_id = ?', [normalized.ghlAppointmentId])
    : null

  if (existingByGhl?.id) {
    normalized.id = existingByGhl.id
  }

  const existingByGoogle = !existingByGhl && normalized.googleEventId
    ? await db.get('SELECT id FROM appointments WHERE google_event_id = ?', [normalized.googleEventId])
    : null

  if (existingByGoogle?.id) {
    normalized.id = existingByGoogle.id
  }

  await db.run(`
    INSERT INTO appointments (
      id, ghl_appointment_id, google_event_id, calendar_id, contact_id, location_id, title, status,
      appointment_status, assigned_user_id, notes, address, start_time, end_time,
      date_added, date_updated, source, sync_status, sync_error, synced_at,
      google_sync_status, google_sync_error, google_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      ghl_appointment_id = COALESCE(excluded.ghl_appointment_id, appointments.ghl_appointment_id),
      google_event_id = COALESCE(excluded.google_event_id, appointments.google_event_id),
      calendar_id = COALESCE(excluded.calendar_id, appointments.calendar_id),
      contact_id = COALESCE(excluded.contact_id, appointments.contact_id),
      location_id = COALESCE(excluded.location_id, appointments.location_id),
      title = COALESCE(excluded.title, appointments.title),
      status = COALESCE(excluded.status, appointments.status),
      appointment_status = COALESCE(excluded.appointment_status, appointments.appointment_status),
      assigned_user_id = COALESCE(excluded.assigned_user_id, appointments.assigned_user_id),
      notes = COALESCE(excluded.notes, appointments.notes),
      address = COALESCE(excluded.address, appointments.address),
      start_time = COALESCE(excluded.start_time, appointments.start_time),
      end_time = COALESCE(excluded.end_time, appointments.end_time),
      date_added = COALESCE(appointments.date_added, excluded.date_added),
      date_updated = excluded.date_updated,
      source = COALESCE(excluded.source, appointments.source),
      sync_status = excluded.sync_status,
      sync_error = excluded.sync_error,
      synced_at = CASE WHEN excluded.sync_status = 'synced' THEN CURRENT_TIMESTAMP ELSE appointments.synced_at END,
      google_sync_status = COALESCE(excluded.google_sync_status, appointments.google_sync_status),
      google_sync_error = excluded.google_sync_error,
      google_synced_at = CASE WHEN excluded.google_sync_status = 'synced' THEN CURRENT_TIMESTAMP ELSE appointments.google_synced_at END,
      deleted_at = NULL
  `, [
    normalized.id,
    normalized.ghlAppointmentId,
    normalized.googleEventId,
    normalized.calendarId || null,
    normalized.contactId,
    normalized.locationId,
    normalized.title,
    normalized.status,
    normalized.appointmentStatus,
    normalized.assignedUserId,
    normalized.notes,
    normalized.address,
    normalized.startTime,
    normalized.endTime,
    normalized.dateAdded,
    normalized.dateUpdated,
    normalized.source,
    normalized.syncStatus,
    normalized.syncError,
    normalized.syncStatus === 'synced' ? new Date().toISOString() : null,
    normalized.googleSyncStatus,
    normalized.googleSyncError,
    normalized.googleSyncStatus === 'synced' ? new Date().toISOString() : null
  ])

  if (normalized.contactId) {
    await updateContactAppointmentDate(normalized.contactId)
  }

  const row = await getLocalAppointment(normalized.id)
  return row
}

export async function createLocalAppointment(appointmentData = {}, { locationId = null, syncStatus = 'pending' } = {}) {
  const startDate = new Date(appointmentData.startTime || appointmentData.start_time)
  const endDate = new Date(appointmentData.endTime || appointmentData.end_time)

  if (Number.isNaN(startDate.getTime())) {
    throw new Error('Fecha de inicio inválida')
  }

  if (Number.isNaN(endDate.getTime()) || endDate <= startDate) {
    throw new Error('La fecha de fin debe ser posterior al inicio')
  }

  return upsertLocalAppointment({
    ...appointmentData,
    id: appointmentData.id || makeId(LOCAL_APPOINTMENT_PREFIX),
    locationId: appointmentData.locationId || appointmentData.location_id || locationId,
    source: appointmentData.source || 'ristak'
  }, {
    source: appointmentData.source || 'ristak',
    syncStatus
  })
}

export async function getLocalAppointment(appointmentId) {
  if (!appointmentId) return null
  const row = await db.get(`
    SELECT
      a.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone
    FROM appointments a
    LEFT JOIN contacts c ON c.id = a.contact_id
    WHERE a.id = ? OR a.ghl_appointment_id = ? OR a.google_event_id = ?
    LIMIT 1
  `, [appointmentId, appointmentId, appointmentId])

  return row ? appointmentRowToApi(row) : null
}

export async function listLocalAppointments({ startTime, endTime, calendarId } = {}) {
  const conditions = ["COALESCE(sync_status, '') != 'pending_delete'", 'deleted_at IS NULL']
  const params = []

  if (startTime) {
    conditions.push('start_time >= ?')
    params.push(new Date(Number(startTime) || startTime).toISOString())
  }

  if (endTime) {
    conditions.push('start_time <= ?')
    params.push(new Date(Number(endTime) || endTime).toISOString())
  }

  if (calendarId) {
    conditions.push('calendar_id = ?')
    params.push(calendarId)
  }

  const rows = await db.all(`
    SELECT
      a.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone
    FROM appointments a
    LEFT JOIN contacts c ON c.id = a.contact_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY a.start_time ASC
  `, params)

  return rows.map(appointmentRowToApi)
}

export async function updateLocalAppointment(appointmentId, updates = {}, { syncStatus = 'pending' } = {}) {
  const existing = await getLocalAppointment(appointmentId)
  if (!existing) return null

  return upsertLocalAppointment({
    ...existing,
    ...updates,
    id: existing.id,
    ghlAppointmentId: existing.ghlAppointmentId,
    calendarId: updates.calendarId || updates.calendar_id || existing.calendarId,
    contactId: updates.contactId || updates.contact_id || existing.contactId,
    locationId: updates.locationId || updates.location_id || existing.locationId,
    source: existing.source || 'ristak',
    dateUpdated: new Date().toISOString()
  }, {
    syncStatus
  })
}

export async function deleteLocalAppointment(appointmentId, { markPendingDelete = false } = {}) {
  const existing = await getLocalAppointment(appointmentId)
  if (!existing) return false

  if (markPendingDelete && existing.ghlAppointmentId) {
    await db.run(`
      UPDATE appointments
      SET sync_status = 'pending_delete',
          appointment_status = 'cancelled',
          status = 'cancelled',
          date_updated = CURRENT_TIMESTAMP,
          deleted_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [existing.id])
  } else {
    await db.run('DELETE FROM appointments WHERE id = ?', [existing.id])
  }

  if (existing.contactId) {
    await updateContactAppointmentDate(existing.contactId)
  }

  return true
}

export async function updateContactAppointmentDate(contactId) {
  if (!contactId) return

  const row = await db.get(`
    SELECT MIN(start_time) AS appointment_date
    FROM appointments
    WHERE contact_id = ?
      AND deleted_at IS NULL
      AND COALESCE(sync_status, '') != 'pending_delete'
      AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled', 'invalid')
  `, [contactId])

  await db.run(
    'UPDATE contacts SET appointment_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [row?.appointment_date || null, contactId]
  )

  await updateSingleContactStats(contactId).catch(error => {
    logger.warn(`No se pudieron actualizar stats del contacto ${contactId}: ${error.message}`)
  })
}

function getCalendarOpenIntervals(calendar, date) {
  const openHours = normalizeOpenHours(calendar.openHours || calendar.open_hours)
  const jsDay = date.getDay()

  if (!openHours.length) {
    if (jsDay === 0 || jsDay === 6) return []
    return [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }]
  }

  const intervals = []
  for (const schedule of openHours) {
    const days = Array.isArray(schedule.daysOfTheWeek) ? schedule.daysOfTheWeek : []
    if (!days.includes(jsDay)) continue
    intervals.push(...(Array.isArray(schedule.hours) ? schedule.hours : []))
  }

  return intervals
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB
}

function sameText(a, b) {
  return cleanString(a).toLowerCase() === cleanString(b).toLowerCase()
}

function sameTime(a, b, toleranceMs = 60000) {
  const timeA = new Date(a).getTime()
  const timeB = new Date(b).getTime()
  if (!Number.isFinite(timeA) || !Number.isFinite(timeB)) return false
  return Math.abs(timeA - timeB) <= toleranceMs
}

function isRistakOwnedRow(row = {}, prefix = '') {
  const source = cleanString(row.source).toLowerCase()
  const id = cleanString(row.id)
  return source === 'ristak' || (prefix && id.startsWith(prefix))
}

export async function getLocalFreeSlots(calendarId, startDate, endDate, timezone) {
  const calendar = await getLocalCalendar(calendarId)
  if (!calendar) return []

  // Generar los horarios en la ZONA DE LA CUENTA, no en la del servidor (UTC en Render).
  // Así "9:00–17:00" significan 9–17 en la zona del negocio y no 9–17 UTC.
  const zone = isValidTimezone(timezone) ? timezone : await getAccountTimezone()

  const startDay = DateTime.fromISO(startDate, { zone }).startOf('day')
  const endDay = DateTime.fromISO(endDate, { zone }).startOf('day')
  if (!startDay.isValid || !endDay.isValid || endDay < startDay) return []

  // Las citas existentes están en UTC en la BD; comparamos por instante absoluto.
  const rangeStart = startDay.toUTC().toISO()
  const rangeEnd = endDay.endOf('day').toUTC().toISO()
  const existing = await listLocalAppointments({ startTime: rangeStart, endTime: rangeEnd, calendarId })

  const durationMinutes = Math.max(1, toInt(calendar.slotDuration, 60))
  const intervalMinutes = Math.max(1, toInt(calendar.slotInterval, durationMinutes))
  const nowMs = Date.now()
  const slotsByDate = []

  for (let cursor = startDay; cursor <= endDay; cursor = cursor.plus({ days: 1 })) {
    const dateKey = cursor.toISODate()
    // getCalendarOpenIntervals usa getDay() (0=domingo); construir una Date con los
    // componentes de la fecha preserva el día de la semana correcto.
    const intervals = getCalendarOpenIntervals(calendar, new Date(cursor.year, cursor.month - 1, cursor.day))
    const slots = []

    for (const interval of intervals) {
      const open = cursor.set({
        hour: toInt(interval.openHour, 9),
        minute: toInt(interval.openMinute, 0),
        second: 0,
        millisecond: 0
      })
      const close = cursor.set({
        hour: toInt(interval.closeHour, 17),
        minute: toInt(interval.closeMinute, 0),
        second: 0,
        millisecond: 0
      })

      for (let slot = open; slot.plus({ minutes: durationMinutes }) <= close; slot = slot.plus({ minutes: intervalMinutes })) {
        const slotStartMs = slot.toMillis()
        const slotEndMs = slot.plus({ minutes: durationMinutes }).toMillis()
        const hasConflict = existing.some(event => overlaps(
          slotStartMs,
          slotEndMs,
          new Date(event.startTime).getTime(),
          new Date(event.endTime || event.startTime).getTime()
        ))

        if (!hasConflict && slotStartMs >= nowMs) {
          slots.push(slot.toUTC().toISO())
        }
      }
    }

    slotsByDate.push({ date: dateKey, slots, timezone: zone })
  }

  return slotsByDate
}

function buildHighLevelCalendarPayload(calendar = {}, locationId) {
  const teamMembers = normalizeTeamMembers(calendar.teamMembers)
  const locationConfigurations = normalizeLocationConfigurations(calendar.locationConfigurations)
  const payload = {
    isActive: calendar.isActive !== false,
    locationId,
    name: calendar.name,
    description: calendar.description || '',
    slug: calendar.slug || slugify(calendar.name),
    calendarType: calendar.calendarType || 'event',
    widgetType: calendar.widgetType || 'classic',
    eventTitle: calendar.eventTitle || calendar.name || 'Cita',
    eventColor: calendar.eventColor || DEFAULT_EVENT_COLOR,
    slotDuration: toInt(calendar.slotDuration, 60),
    slotDurationUnit: calendar.slotDurationUnit || 'mins',
    slotInterval: toInt(calendar.slotInterval, toInt(calendar.slotDuration, 60)),
    slotIntervalUnit: calendar.slotIntervalUnit || 'mins',
    appoinmentPerSlot: toInt(calendar.appoinmentPerSlot, 1),
    appoinmentPerDay: toInt(calendar.appoinmentPerDay, 0),
    allowBookingAfter: toInt(calendar.allowBookingAfter, 0),
    allowBookingAfterUnit: calendar.allowBookingAfterUnit || 'hours',
    allowBookingFor: toInt(calendar.allowBookingFor, 30),
    allowBookingForUnit: calendar.allowBookingForUnit || 'days'
  }

  if (teamMembers.length) payload.teamMembers = teamMembers
  if (locationConfigurations.length) payload.locationConfigurations = locationConfigurations
  if (normalizeOpenHours(calendar.openHours).length) payload.openHours = normalizeOpenHours(calendar.openHours)
  if (calendar.notes) payload.notes = calendar.notes
  if (calendar.availabilityType !== undefined) payload.availabilityType = calendar.availabilityType
  if (calendar.preBuffer) payload.preBuffer = calendar.preBuffer
  if (calendar.preBufferUnit) payload.preBufferUnit = calendar.preBufferUnit
  if (calendar.slotBuffer) payload.slotBuffer = calendar.slotBuffer
  if (calendar.slotBufferUnit) payload.slotBufferUnit = calendar.slotBufferUnit

  return payload
}

async function getFallbackTeamMembers(client, locationId) {
  try {
    const users = await client.getLocationUsers(locationId)
    const user = users.find(candidate => candidate.id || candidate.userId)
    const userId = user?.id || user?.userId
    return userId ? [{ userId, priority: 0.5, isPrimary: true }] : []
  } catch (error) {
    logger.warn(`No se pudo resolver usuario default para calendario GHL: ${error.message}`)
    return []
  }
}

export async function syncLocalCalendarsToHighLevel(locationId, apiToken) {
  const rows = await db.all(`
    SELECT * FROM calendars
    WHERE (
        COALESCE(source, 'ristak') = 'ristak'
        OR id LIKE 'rstk_cal_%'
      )
      AND (
        COALESCE(ghl_calendar_id, '') = ''
        OR sync_status IN ('pending', 'error')
      )
    ORDER BY created_at ASC
  `)

  const client = new GHLClient(apiToken, locationId)
  let remoteCalendarsCache = null
  let created = 0
  let updated = 0
  let matched = 0
  let failed = 0

  for (const row of rows) {
    const calendar = calendarRowToApi(row)
    try {
      if (!isRistakOwnedRow(row, LOCAL_CALENDAR_PREFIX)) {
        logger.warn(`Saltando calendario no local para evitar duplicado en HighLevel: ${calendar.id}`)
        continue
      }

      let teamMembers = normalizeTeamMembers(calendar.teamMembers)
      if (!teamMembers.length) {
        teamMembers = await getFallbackTeamMembers(client, locationId)
      }

      const payload = buildHighLevelCalendarPayload({ ...calendar, teamMembers }, locationId)
      let response
      let ghlCalendarId = calendar.ghlCalendarId

      if (!ghlCalendarId) {
        if (!remoteCalendarsCache) {
          remoteCalendarsCache = await highlevelCalendarService.getCalendars(locationId, apiToken)
        }

        const slug = payload.slug || slugify(payload.name)
        const existingRemote = remoteCalendarsCache.find(remote => (
          sameText(remote.slug || remote.widgetSlug, slug) ||
          sameText(remote.name, payload.name)
        ))

        if (existingRemote?.id) {
          ghlCalendarId = existingRemote.id
          matched += 1
          response = existingRemote
        }
      }

      if (response) {
        // Ya encontramos un calendario remoto equivalente; solo ligamos IDs.
      } else if (ghlCalendarId) {
        response = await highlevelCalendarService.updateCalendar(ghlCalendarId, payload, apiToken)
        updated += 1
      } else {
        response = await highlevelCalendarService.createCalendar(payload, apiToken)
        created += 1
      }

      const remoteCalendar = response?.calendar || response
      ghlCalendarId = remoteCalendar?.id || ghlCalendarId

      if (!ghlCalendarId) {
        throw new Error('HighLevel no devolvió ID de calendario; se detiene para evitar duplicados')
      }

      await upsertLocalCalendar({
        ...calendar,
        ...remoteCalendar,
        id: calendar.id,
        ghlCalendarId,
        locationId,
        teamMembers: remoteCalendar?.teamMembers || teamMembers,
        source: calendar.source || 'ristak'
      }, {
        id: calendar.id,
        source: calendar.source || 'ristak',
        ghlCalendarId,
        locationId,
        syncStatus: 'synced',
        rawJson: remoteCalendar
      })
    } catch (error) {
      failed += 1
      await db.run(
        "UPDATE calendars SET sync_status = 'error', sync_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [error.message, calendar.id]
      )
      logger.warn(`No se pudo sincronizar calendario ${calendar.id} a HighLevel: ${error.message}`)
    }
  }

  return { total: rows.length, created, updated, matched, failed }
}

async function ensureHighLevelContactForAppointment(client, appointment = {}) {
  if (!appointment.contactId) return null

  if (!String(appointment.contactId).startsWith('rstk_') && !String(appointment.contactId).startsWith('waweb_contact_')) {
    return appointment.contactId
  }

  const contact = await db.get('SELECT * FROM contacts WHERE id = ?', [appointment.contactId])
  if (!contact) return appointment.contactId

  const searches = []
  if (contact.email) searches.push({ email: contact.email })
  if (contact.phone) searches.push({ phone: contact.phone })

  for (const search of searches) {
    const result = await client.searchContacts({ ...search, limit: 5 }).catch(() => null)
    const match = result?.contacts?.find(candidate => candidate.id)
    if (match?.id) {
      await db.run('UPDATE appointments SET contact_id = ? WHERE contact_id = ?', [match.id, appointment.contactId])
      return match.id
    }
  }

  const fullName = contact.full_name || `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || contact.email || contact.phone || 'Contacto Ristak'
  const created = await client.createContact({
    name: fullName,
    email: contact.email || '',
    phone: normalizePhoneForStorage(contact.phone) || contact.phone || ''
  })
  const highLevelContact = created.contact || created
  const targetId = highLevelContact.id

  if (targetId) {
    const phoneUpsert = await prepareContactPhoneUpsert({
      contactId: targetId,
      phone: highLevelContact.phone || contact.phone
    })

    await db.run(`
      INSERT INTO contacts (id, phone, email, full_name, first_name, last_name, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET
        phone = COALESCE(excluded.phone, contacts.phone),
        email = COALESCE(excluded.email, contacts.email),
        full_name = COALESCE(excluded.full_name, contacts.full_name),
        first_name = COALESCE(excluded.first_name, contacts.first_name),
        last_name = COALESCE(excluded.last_name, contacts.last_name),
        source = COALESCE(excluded.source, contacts.source),
        updated_at = CURRENT_TIMESTAMP
    `, [
      targetId,
      phoneUpsert.phone || null,
      highLevelContact.email || contact.email || null,
      highLevelContact.name || fullName,
      highLevelContact.firstName || contact.first_name || null,
      highLevelContact.lastName || contact.last_name || null,
      contact.source || 'ristak',
      contact.created_at || null
    ])

    await finalizePreparedPhoneUpsert(phoneUpsert, targetId)
    await db.run('UPDATE appointments SET contact_id = ? WHERE contact_id = ?', [targetId, appointment.contactId])
    return targetId
  }

  return appointment.contactId
}

export async function syncLocalAppointmentsToHighLevel(locationId, apiToken) {
  const rows = await db.all(`
    SELECT * FROM appointments
    WHERE (
        COALESCE(source, 'ristak') = 'ristak'
        OR id LIKE 'rstk_appt_%'
      )
      AND sync_status IN ('pending', 'error', 'pending_delete')
    ORDER BY date_added ASC
  `)

  const client = new GHLClient(apiToken, locationId)
  let created = 0
  let updated = 0
  let matched = 0
  let deleted = 0
  let failed = 0

  for (const row of rows) {
    const appointment = appointmentRowToApi(row)
    try {
      if (!isRistakOwnedRow(row, LOCAL_APPOINTMENT_PREFIX)) {
        logger.warn(`Saltando cita no local para evitar duplicado en HighLevel: ${appointment.id}`)
        continue
      }

      const calendar = await getLocalCalendar(appointment.calendarId)
      const remoteCalendarId = calendar?.ghlCalendarId || appointment.calendarId

      if (!remoteCalendarId) {
        throw new Error(`El calendario ${appointment.calendarId} todavía no tiene ID de HighLevel`)
      }

      if (appointment.syncStatus === 'pending_delete') {
        if (appointment.ghlAppointmentId) {
          await highlevelCalendarService.deleteEvent(appointment.ghlAppointmentId, apiToken)
        }
        await deleteLocalAppointment(appointment.id)
        deleted += 1
        continue
      }

      const contactId = await ensureHighLevelContactForAppointment(client, appointment)
      const payload = {
        ...appointment,
        calendarId: remoteCalendarId,
        contactId,
        locationId,
        appointmentStatus: appointment.appointmentStatus || appointment.status || 'confirmed'
      }

      let response
      let ghlAppointmentId = appointment.ghlAppointmentId

      if (!ghlAppointmentId) {
        const startMs = new Date(appointment.startTime).getTime()
        const endMs = new Date(appointment.endTime || appointment.startTime).getTime()
        const searchStart = Number.isFinite(startMs) ? startMs - 5 * 60000 : Date.now() - 5 * 60000
        const searchEnd = Number.isFinite(endMs) ? endMs + 5 * 60000 : searchStart + 15 * 60000
        const existingEvents = await highlevelCalendarService.getCalendarEvents(
          locationId,
          searchStart,
          searchEnd,
          apiToken,
          remoteCalendarId
        ).catch(error => {
          logger.warn(`No se pudo buscar cita existente antes de crear ${appointment.id}: ${error.message}`)
          return []
        })

        const existingRemote = existingEvents.find(event => (
          sameTime(event.startTime || event.start_time, appointment.startTime) &&
          (!contactId || !event.contactId || event.contactId === contactId) &&
          sameText(event.title || event.name || '', appointment.title || '')
        ))

        if (existingRemote?.id) {
          ghlAppointmentId = existingRemote.id
          response = existingRemote
          matched += 1
        }
      }

      if (response) {
        // Ya encontramos una cita remota equivalente; solo ligamos IDs.
      } else if (ghlAppointmentId) {
        response = await highlevelCalendarService.updateAppointment(ghlAppointmentId, payload, apiToken)
        updated += 1
      } else {
        response = await highlevelCalendarService.createAppointment(payload, locationId, apiToken)
        created += 1
      }

      const remoteAppointment = response?.appointment || response
      ghlAppointmentId = remoteAppointment?.id || ghlAppointmentId

      if (!ghlAppointmentId) {
        throw new Error('HighLevel no devolvió ID de cita; se detiene para evitar duplicados')
      }

      await upsertLocalAppointment({
        ...appointment,
        ...remoteAppointment,
        id: appointment.id,
        ghlAppointmentId,
        calendarId: appointment.calendarId,
        locationId,
        contactId
      }, {
        id: appointment.id,
        source: appointment.source || 'ristak',
        ghlAppointmentId,
        calendarId: appointment.calendarId,
        locationId,
        syncStatus: 'synced'
      })
    } catch (error) {
      failed += 1
      await db.run(
        "UPDATE appointments SET sync_status = 'error', sync_error = ?, date_updated = CURRENT_TIMESTAMP WHERE id = ?",
        [error.message, appointment.id]
      )
      logger.warn(`No se pudo sincronizar cita ${appointment.id} a HighLevel: ${error.message}`)
    }
  }

  return { total: rows.length, created, updated, matched, deleted, failed }
}

export default {
  createLocalCalendar,
  ensureDefaultLocalCalendar,
  getLocalCalendar,
  listLocalCalendars,
  upsertLocalCalendar,
  updateLocalCalendar,
  createLocalAppointment,
  deleteLocalAppointment,
  getLocalAppointment,
  getLocalFreeSlots,
  listLocalAppointments,
  syncLocalAppointmentsToHighLevel,
  syncLocalCalendarsToHighLevel,
  updateLocalAppointment,
  upsertLocalAppointment
}
