import { CONTACT_ADVANCED_FIELD_GROUPS, getContactAdvancedOperators } from '../../../shared/contactAdvancedFilterCatalog.js'
import { db } from '../config/database.js'
import { listContactTags } from '../services/contactTagsService.js'
import { listContactCustomFieldDefinitions } from '../services/contactCustomFieldDefinitionsService.js'
import { hasUserAccess } from '../utils/userAccess.js'
import { getEditableNotificationEventFilter, NOTIFICATION_CALENDAR_FIELD } from '../services/notificationContactFiltersService.js'

export async function getNotificationContactFilterCatalog(req, res) {
  try {
    const [tags, definitions, users, calendars] = await Promise.all([
      listContactTags(), listContactCustomFieldDefinitions(),
      db.all('SELECT id, full_name, username FROM users WHERE is_active = 1 ORDER BY full_name, username'),
      hasUserAccess(req.user, 'appointments') ? db.all('SELECT id, name FROM calendars ORDER BY name') : []
    ])
    const catalogs = {
      users: users.map(u => ({ value: String(u.id), label: u.full_name || u.username })),
      calendars: calendars.map(c => ({ value: String(c.id), label: c.name })),
    }
    const groups = CONTACT_ADVANCED_FIELD_GROUPS.map(group => ({
      label: group.label,
      fields: group.fields.filter(f => f.type !== 'custom_field').map(field => ({
        ...field, field: field.key, label: field.key === 'appointment_calendar' ? 'Contacto con citas en calendario' : field.label,
        options: field.key === 'tags' ? tags.map(t => ({ value: t.id, label: t.name })) : catalogs[field.catalog] || field.options || [],
        // Named entities are selected by exact ID, never by an ID substring.
        operators: getContactAdvancedOperators(catalogs[field.catalog] ? { ...field, type: 'select' } : field)
      }))
    }))
    groups.unshift({ label: 'Este aviso', fields: [{ ...NOTIFICATION_CALENDAR_FIELD, options: catalogs.calendars, operators: getContactAdvancedOperators(NOTIFICATION_CALENDAR_FIELD) }] })
    groups.push({ label: 'Campos personalizados y formularios', fields: definitions.map(definition => {
      const options = (definition.options || []).map(option => typeof option === 'object'
        ? { value: String(option.value ?? option.label ?? option.name ?? ''), label: String(option.label ?? option.name ?? option.value ?? '') }
        : { value: String(option), label: String(option) }).filter(option => option.value)
      const dataType = String(definition.dataType || '').toLowerCase()
      const type = options.length ? 'select' : ['number', 'currency', 'decimal', 'integer'].includes(dataType) ? 'number'
        : ['date', 'datetime', 'date_time'].includes(dataType) ? 'date'
        : ['checkbox', 'boolean', 'switch', 'yes_no'].includes(dataType) ? 'boolean' : 'text'
      const customKey = definition.definitionId || definition.key || definition.fieldKey
      const field = { key: `custom:${customKey}`, field: 'custom_field', customKey, type, label: definition.label || definition.name || customKey, options }
      return { ...field, operators: getContactAdvancedOperators(field) }
    }) })
    res.json({ success: true, data: { groups } })
  } catch {
    res.status(500).json({ success: false, error: 'No se pudieron cargar los campos para filtrar. Intenta de nuevo.' })
  }
}

export async function getNotificationEventFilter(req, res) {
  try {
    const filter = await getEditableNotificationEventFilter(req.user.userId, req.params.key)
    res.json({ success: true, data: filter })
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.statusCode === 400 ? error.message : 'No se pudieron cargar los filtros de este aviso.' })
  }
}
