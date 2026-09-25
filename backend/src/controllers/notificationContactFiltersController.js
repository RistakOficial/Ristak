import { CONTACT_ADVANCED_FIELD_GROUPS, getContactAdvancedOperators } from '../../../shared/contactAdvancedFilterCatalog.js'
import { db } from '../config/database.js'
import { listContactTags } from '../services/contactTagsService.js'
import { listContactCustomFieldDefinitions } from '../services/contactCustomFieldDefinitionsService.js'
import { hasUserAccess } from '../utils/userAccess.js'

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
        ...field, field: field.key,
        options: field.key === 'tags' ? tags.map(t => ({ value: t.id, label: t.name })) : catalogs[field.catalog] || field.options || [],
        operators: getContactAdvancedOperators(field)
      }))
    }))
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
