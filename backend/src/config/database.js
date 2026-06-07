import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { logger } from '../utils/logger.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DATABASE_URL = process.env.DATABASE_URL
const usePostgres = !!DATABASE_URL

let db

const WHATSAPP_API_SYSTEM_CUSTOM_FIELD_KEYS = new Set([
  'whatsapp_api_provider',
  'whatsapp_api_first_message',
  'whatsapp_api_source_id',
  'whatsapp_api_ctwa_clid',
  'whatsapp_api_source_url'
])

const normalizeCustomFieldKey = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')

function parseCustomFieldsPayload(value) {
  if (value === null || value === undefined || value === '') return []
  if (Array.isArray(value) || (typeof value === 'object' && value)) return value

  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function isWhatsAppApiSystemCustomField(field = {}, fallbackKey = '') {
  const tokens = [
    fallbackKey,
    field?.id,
    field?.key,
    field?.fieldKey,
    field?.field_key,
    field?.name,
    field?.label
  ].map(normalizeCustomFieldKey).filter(Boolean)

  return tokens.some(token => WHATSAPP_API_SYSTEM_CUSTOM_FIELD_KEYS.has(token))
}

function removeWhatsAppApiSystemCustomFieldsFromPayload(value) {
  const parsed = parseCustomFieldsPayload(value)

  if (Array.isArray(parsed)) {
    const next = parsed.filter(field => !isWhatsAppApiSystemCustomField(field))
    return {
      changed: next.length !== parsed.length,
      value: next
    }
  }

  if (parsed && typeof parsed === 'object') {
    const next = {}
    let changed = false
    for (const [key, fieldValue] of Object.entries(parsed)) {
      const field = fieldValue && typeof fieldValue === 'object' ? fieldValue : { value: fieldValue }
      if (isWhatsAppApiSystemCustomField(field, key)) {
        changed = true
        continue
      }
      next[key] = fieldValue
    }
    return { changed, value: next }
  }

  return { changed: false, value: parsed }
}

async function cleanupWhatsAppApiSystemCustomFields() {
  const definitionRows = await db.all(`
    SELECT id
    FROM contact_custom_field_definitions
    WHERE LOWER(field_key) IN (${Array.from(WHATSAPP_API_SYSTEM_CUSTOM_FIELD_KEYS).map(() => '?').join(', ')})
  `, Array.from(WHATSAPP_API_SYSTEM_CUSTOM_FIELD_KEYS))

  for (const row of definitionRows) {
    await db.run('DELETE FROM contact_custom_field_definition_sources WHERE definition_id = ?', [row.id])
    await db.run('DELETE FROM contact_custom_field_definitions WHERE id = ?', [row.id])
  }

  const contactRows = await db.all(`
    SELECT id, custom_fields
    FROM contacts
    WHERE custom_fields IS NOT NULL
  `)
  let cleanedContacts = 0

  for (const row of contactRows) {
    const cleaned = removeWhatsAppApiSystemCustomFieldsFromPayload(row.custom_fields)
    if (!cleaned.changed) continue

    await db.run(
      `UPDATE contacts SET custom_fields = ${usePostgres ? '?::jsonb' : '?'} WHERE id = ?`,
      [JSON.stringify(cleaned.value), row.id]
    )
    cleanedContacts += 1
  }

  if (definitionRows.length || cleanedContacts) {
    logger.info(`Limpieza WhatsApp API: ${definitionRows.length} definiciones y ${cleanedContacts} contactos sin campos personalizados internos.`)
  }
}

if (usePostgres) {
  // PostgreSQL (Producción en Render)
  logger.info('Usando PostgreSQL')

  const pg = await import('pg')
  const pool = new pg.default.Pool({
    connectionString: DATABASE_URL,
    options: '-c timezone=UTC',
    ssl: {
      rejectUnauthorized: false
    }
  })

  // Helper para convertir placeholders SQLite (?) a PostgreSQL ($1, $2, etc.)
  const convertPlaceholders = (sql) => {
    let index = 1
    return sql.replace(/\?/g, () => `$${index++}`)
  }

  db = {
    run: async (sql, params = []) => {
      const client = await pool.connect()
      try {
        // Convertir sintaxis SQLite a PostgreSQL
        sql = sql.replace(/AUTOINCREMENT/g, 'GENERATED ALWAYS AS IDENTITY')
        sql = sql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
        sql = sql.replace(/DATETIME/g, 'TIMESTAMP')
        // INSERT OR IGNORE se maneja específicamente donde se usa (ver app_config INSERT)

        // Convertir placeholders ? a $1, $2, etc.
        sql = convertPlaceholders(sql)

        const result = await client.query(sql, params)
        return {
          lastID: result.rows[0]?.id || null,
          changes: result.rowCount
        }
      } finally {
        client.release()
      }
    },

    get: async (sql, params = []) => {
      const client = await pool.connect()
      try {
        sql = sql.replace(/DATETIME/g, 'TIMESTAMP')
        sql = convertPlaceholders(sql)

        const result = await client.query(sql, params)
        return result.rows[0] || null
      } finally {
        client.release()
      }
    },

    all: async (sql, params = []) => {
      const client = await pool.connect()
      try {
        sql = sql.replace(/DATETIME/g, 'TIMESTAMP')
        sql = convertPlaceholders(sql)

        const result = await client.query(sql, params)
        return result.rows
      } finally {
        client.release()
      }
    },

    exec: async (sql) => {
      const client = await pool.connect()
      try {
        sql = sql.replace(/AUTOINCREMENT/g, 'GENERATED ALWAYS AS IDENTITY')
        sql = sql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
        sql = sql.replace(/DATETIME/g, 'TIMESTAMP')
        await client.query(sql)
      } finally {
        client.release()
      }
    }
  }

  logger.success('Conectado a PostgreSQL')
} else {
  // SQLite (Desarrollo local)
  logger.info('Usando SQLite')

  const sqlite3Module = await import('sqlite3')
  const sqlite3 = sqlite3Module.default

  const dbPath = join(__dirname, '../../../ristak.db')
  const sqliteDb = new sqlite3.Database(dbPath)
  logger.success('Conectado a SQLite:', dbPath)

  db = {
    run: (sql, params = []) => {
      return new Promise((resolve, reject) => {
        sqliteDb.run(sql, params, function(err) {
          if (err) reject(err)
          else resolve({ lastID: this.lastID, changes: this.changes })
        })
      })
    },

    get: (sql, params = []) => {
      return new Promise((resolve, reject) => {
        sqliteDb.get(sql, params, (err, row) => {
          if (err) reject(err)
          else resolve(row || null)
        })
      })
    },

    all: (sql, params = []) => {
      return new Promise((resolve, reject) => {
        sqliteDb.all(sql, params, (err, rows) => {
          if (err) reject(err)
          else resolve(rows)
        })
      })
    },

    exec: (sql) => {
      return new Promise((resolve, reject) => {
        sqliteDb.exec(sql, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
  }
}

const CONTACT_PHONE_REFERENCE_TABLES = [
  { table: 'payments', column: 'contact_id' },
  { table: 'payment_plans', column: 'contact_id' },
  { table: 'appointments', column: 'contact_id' },
  { table: 'appointment_attendance_signals', column: 'contact_id', deleteOnConflict: true },
  { table: 'meta_conversion_event_logs', column: 'contact_id' },
  { table: 'whatsapp_attribution', column: 'contact_id' },
  { table: 'whatsapp_api_contacts', column: 'contact_id' },
  { table: 'whatsapp_api_messages', column: 'contact_id' },
  { table: 'whatsapp_api_attribution', column: 'contact_id' },
  { table: 'scheduled_chat_messages', column: 'contact_id' },
  { table: 'payment_flows', column: 'contact_id' },
  { table: 'sessions', column: 'contact_id' }
]

function getContactPhoneScore(contact = {}, canonicalPhone = '') {
  let score = 0
  const id = String(contact.id || '')
  const source = String(contact.source || '').toLowerCase()

  if (!id.startsWith('waapi_contact_')) score += 1000
  if (Number(contact.total_paid || 0) > 0) score += 500
  if (Number(contact.purchases_count || 0) > 0) score += 250
  if (source.includes('gohighlevel') || source.includes('highlevel')) score += 150
  if (contact.phone === canonicalPhone) score += 50

  return score
}

function pickContactPhoneWinner(contacts = [], canonicalPhone = '') {
  return [...contacts].sort((a, b) => {
    const scoreDiff = getContactPhoneScore(b, canonicalPhone) - getContactPhoneScore(a, canonicalPhone)
    if (scoreDiff !== 0) return scoreDiff
    return String(a.created_at || '').localeCompare(String(b.created_at || ''))
  })[0]
}

async function updateContactReferences(fromId, toId) {
  for (const reference of CONTACT_PHONE_REFERENCE_TABLES) {
    try {
      await db.run(
        `UPDATE ${reference.table} SET ${reference.column} = ? WHERE ${reference.column} = ?`,
        [toId, fromId]
      )
    } catch (err) {
      if (reference.deleteOnConflict) {
        await db.run(`DELETE FROM ${reference.table} WHERE ${reference.column} = ?`, [fromId])
        continue
      }

      logger.warn(`Advertencia al fusionar referencias ${reference.table}.${reference.column}: ${err.message}`)
    }
  }
}

async function syncContactPhoneColumns(contactId, canonicalPhone) {
  const updates = [
    ['whatsapp_attribution', 'phone'],
    ['whatsapp_api_contacts', 'phone'],
    ['whatsapp_api_messages', 'phone'],
    ['whatsapp_api_attribution', 'phone'],
    ['payment_flows', 'contact_phone']
  ]

  for (const [table, column] of updates) {
    try {
      await db.run(`UPDATE ${table} SET ${column} = ? WHERE contact_id = ?`, [canonicalPhone, contactId])
    } catch (err) {
      logger.warn(`Advertencia al normalizar ${table}.${column}: ${err.message}`)
    }
  }
}

async function reconcileCanonicalContactPhones() {
  const rows = await db.all(`
    SELECT id, phone, email, full_name, first_name, last_name, source, visitor_id,
      attribution_url, attribution_session_source, attribution_medium, attribution_ctwa_clid,
      attribution_ad_name, attribution_ad_id, total_paid, purchases_count, created_at
    FROM contacts
    WHERE phone IS NOT NULL AND phone != ''
  `)

  const groups = new Map()
  for (const row of rows) {
    const canonicalPhone = normalizePhoneForStorage(row.phone)
    if (!canonicalPhone) continue
    if (!groups.has(canonicalPhone)) groups.set(canonicalPhone, [])
    groups.get(canonicalPhone).push(row)
  }

  let changed = 0

  for (const [canonicalPhone, contacts] of groups.entries()) {
    if (contacts.length === 1) {
      const [contact] = contacts
      if (contact.phone !== canonicalPhone) {
        await db.run(
          'UPDATE contacts SET phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [canonicalPhone, contact.id]
        )
        await syncContactPhoneColumns(contact.id, canonicalPhone)
        changed += 1
      }
      continue
    }

    const winner = pickContactPhoneWinner(contacts, canonicalPhone)
    const losers = contacts.filter(contact => contact.id !== winner.id)
    const merged = { ...winner }

    for (const loser of losers) {
      for (const field of [
        'full_name',
        'email',
        'first_name',
        'last_name',
        'source',
        'visitor_id',
        'attribution_url',
        'attribution_session_source',
        'attribution_medium',
        'attribution_ctwa_clid',
        'attribution_ad_name',
        'attribution_ad_id'
      ]) {
        if (!merged[field] && loser[field]) merged[field] = loser[field]
      }

      merged.total_paid = Math.max(Number(merged.total_paid || 0), Number(loser.total_paid || 0))
      merged.purchases_count = Math.max(Number(merged.purchases_count || 0), Number(loser.purchases_count || 0))

      await db.run('UPDATE contacts SET phone = NULL, email = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [loser.id])
      await updateContactReferences(loser.id, winner.id)
      await db.run('DELETE FROM contacts WHERE id = ?', [loser.id])
      changed += 1
    }

    await db.run(`
      UPDATE contacts SET
        phone = ?,
        email = ?,
        full_name = ?,
        first_name = ?,
        last_name = ?,
        source = ?,
        visitor_id = ?,
        attribution_url = ?,
        attribution_session_source = ?,
        attribution_medium = ?,
        attribution_ctwa_clid = ?,
        attribution_ad_name = ?,
        attribution_ad_id = ?,
        total_paid = ?,
        purchases_count = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      canonicalPhone,
      merged.email || null,
      merged.full_name || null,
      merged.first_name || null,
      merged.last_name || null,
      merged.source || null,
      merged.visitor_id || null,
      merged.attribution_url || null,
      merged.attribution_session_source || null,
      merged.attribution_medium || null,
      merged.attribution_ctwa_clid || null,
      merged.attribution_ad_name || null,
      merged.attribution_ad_id || null,
      Number(merged.total_paid || 0),
      Number(merged.purchases_count || 0),
      winner.id
    ])
    await syncContactPhoneColumns(winner.id, canonicalPhone)
  }

  if (changed > 0) {
    logger.success(`✅ Migración: ${changed} contactos normalizados/fusionados por teléfono`)
  }
}

// Inicializar tablas
async function initTables() {
  try {
    // Tabla de configuración de HighLevel
    await db.run(`
      CREATE TABLE IF NOT EXISTS highlevel_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        location_id TEXT UNIQUE,
        api_token TEXT,
        location_data TEXT,
        custom_labels TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Tabla de configuración global de la app (independiente de HighLevel)
    await db.run(`
      CREATE TABLE IF NOT EXISTS app_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_key TEXT UNIQUE NOT NULL,
        config_value TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    try {
      if (usePostgres) {
        await db.run(`
          DELETE FROM app_config a
          USING app_config b
          WHERE a.config_key = b.config_key
            AND a.id < b.id
        `)
      } else {
        await db.run(`
          DELETE FROM app_config
          WHERE id NOT IN (
            SELECT MAX(id)
            FROM app_config
            GROUP BY config_key
          )
        `)
      }

      await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_app_config_config_key ON app_config(config_key)')
    } catch (err) {
      logger.warn('Advertencia al asegurar unicidad de app_config.config_key:', err.message)
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        endpoint TEXT UNIQUE NOT NULL,
        subscription_json TEXT NOT NULL,
        calendar_ids_json TEXT,
        enabled INTEGER DEFAULT 1,
        user_agent TEXT,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS mobile_push_devices (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        platform TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        calendar_ids_json TEXT,
        enabled INTEGER DEFAULT 1,
        app_version TEXT,
        app_build TEXT,
        device_model TEXT,
        os_version TEXT,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    try {
      await db.run('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_enabled ON push_subscriptions(enabled)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_mobile_push_devices_enabled ON mobile_push_devices(enabled)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_mobile_push_devices_user ON mobile_push_devices(user_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_mobile_push_devices_platform ON mobile_push_devices(platform)')
    } catch (err) {
      logger.warn('Advertencia al crear índices de avisos push:', err.message)
    }

    // Sites públicos/formularios. El dashboard administra la estructura, pero
    // el render público se decide estrictamente por dominio verificado.
    await db.run(`
      CREATE TABLE IF NOT EXISTS public_sites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        site_type TEXT DEFAULT 'standard_form',
        status TEXT DEFAULT 'draft',
        domain TEXT UNIQUE,
        title TEXT,
        description TEXT,
        theme_json TEXT,
        meta_capi_enabled INTEGER DEFAULT 0,
        meta_event_name TEXT DEFAULT 'Lead',
        render_domain_verified INTEGER DEFAULT 0,
        render_domain_checked_at DATETIME,
        render_domain_error TEXT,
        published_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS public_site_blocks (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        block_type TEXT NOT NULL,
        label TEXT,
        content TEXT,
        placeholder TEXT,
        required INTEGER DEFAULT 0,
        options_json TEXT,
        settings_json TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (site_id) REFERENCES public_sites(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS public_site_submissions (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        contact_id TEXT,
        domain TEXT,
        response_json TEXT NOT NULL,
        raw_fields_json TEXT,
        mapped_fields_json TEXT,
        derived_fields_json TEXT,
        meta_json TEXT,
        status TEXT DEFAULT 'received',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (site_id) REFERENCES public_sites(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS public_site_imports (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL UNIQUE,
        original_filename TEXT,
        import_type TEXT DEFAULT 'html',
        html_original TEXT,
        html_sanitized TEXT NOT NULL,
        detected_forms_json TEXT,
        form_mappings_json TEXT,
        security_report_json TEXT,
        status TEXT DEFAULT 'mapping_pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (site_id) REFERENCES public_sites(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS public_site_import_assets (
        id TEXT PRIMARY KEY,
        import_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        asset_path TEXT NOT NULL,
        content_type TEXT NOT NULL,
        content_base64 TEXT NOT NULL,
        size_bytes INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (import_id) REFERENCES public_site_imports(id) ON DELETE CASCADE,
        FOREIGN KEY (site_id) REFERENCES public_sites(id) ON DELETE CASCADE
      )
    `)

    for (const [columnName, columnType] of [
      ['domain', 'TEXT UNIQUE'],
      ['title', 'TEXT'],
      ['description', 'TEXT'],
      ['theme_json', 'TEXT'],
      ['meta_capi_enabled', 'INTEGER DEFAULT 0'],
      ['meta_event_name', "TEXT DEFAULT 'Lead'"],
      ['render_domain_verified', 'INTEGER DEFAULT 0'],
      ['render_domain_checked_at', 'DATETIME'],
      ['render_domain_error', 'TEXT'],
      ['published_at', 'DATETIME']
    ]) {
      try {
        await db.run(`ALTER TABLE public_sites ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          logger.warn(`Advertencia al migrar public_sites.${columnName}: ${err.message}`)
        }
      }
    }

    for (const [columnName, columnType] of [
      ['raw_fields_json', 'TEXT'],
      ['mapped_fields_json', 'TEXT'],
      ['derived_fields_json', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE public_site_submissions ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          logger.warn(`Advertencia al migrar public_site_submissions.${columnName}: ${err.message}`)
        }
      }
    }

    try {
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_sites_status ON public_sites(status)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_site_blocks_site_order ON public_site_blocks(site_id, sort_order)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_site_submissions_site ON public_site_submissions(site_id, created_at)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_site_submissions_contact ON public_site_submissions(contact_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_site_imports_site ON public_site_imports(site_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_site_import_assets_import ON public_site_import_assets(import_id)')
      await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_public_site_import_assets_site_path ON public_site_import_assets(site_id, asset_path)')
      await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_public_sites_domain_lower ON public_sites(LOWER(domain)) WHERE domain IS NOT NULL AND domain != ''")
    } catch (err) {
      logger.warn('Advertencia al crear índices de public sites:', err.message)
    }

    // Tabla de configuración del agente AI
    await db.run(`
      CREATE TABLE IF NOT EXISTS ai_agent_config (
        id ${usePostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        openai_api_key_encrypted TEXT,
        model TEXT DEFAULT 'gpt-5.5',
        business_context TEXT,
        market_context TEXT,
        ideal_customer TEXT,
        location_context TEXT,
        competitors_context TEXT,
        brand_voice TEXT,
        research_domains TEXT,
        response_style TEXT DEFAULT 'advisor',
        recommendation_mode TEXT DEFAULT 'when_useful',
        web_search_enabled INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    const aiAgentColumns = [
      ['business_context', 'TEXT'],
      ['market_context', 'TEXT'],
      ['ideal_customer', 'TEXT'],
      ['location_context', 'TEXT'],
      ['competitors_context', 'TEXT'],
      ['brand_voice', 'TEXT'],
      ['research_domains', 'TEXT'],
      ['response_style', "TEXT DEFAULT 'advisor'"],
      ['recommendation_mode', "TEXT DEFAULT 'when_useful'"],
      ['web_search_enabled', 'INTEGER DEFAULT 0']
    ]

    for (const [columnName, columnType] of aiAgentColumns) {
      try {
        await db.run(`ALTER TABLE ai_agent_config ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Ignore if the column already exists.
      }
    }

    // Insertar configuración por defecto de Analytics (visible por defecto)
    // Usar INSERT con ON CONFLICT para compatibilidad SQLite/PostgreSQL
    try {
      await db.run(`
        INSERT INTO app_config (config_key, config_value)
        VALUES ('show_analytics', '1')
        ON CONFLICT (config_key) DO NOTHING
      `)
    } catch (err) {
      // Ignore si ya existe
    }

    try {
      await db.run(`
        INSERT INTO app_config (config_key, config_value)
        VALUES ('dashboard_show_funnel_visitors', '1')
        ON CONFLICT (config_key) DO NOTHING
      `)
    } catch (err) {
      // Ignore si ya existe
    }

    try {
      await db.run(`
        INSERT INTO app_config (config_key, config_value)
        VALUES ('report_manual_business_expenses_enabled', '0')
        ON CONFLICT (config_key) DO NOTHING
      `)
    } catch (err) {
      // Ignore si ya existe
    }

    // Plantillas internas de WhatsApp. Son locales a Ristak y quedan listas para
    // conectarse a YCloud sin depender de la estructura remota desde el inicio.
    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_template_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (parent_id) REFERENCES whatsapp_template_folders(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_template_custom_fields (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        field_key TEXT UNIQUE NOT NULL,
        merge_field TEXT UNIQUE NOT NULL,
        example TEXT,
        data_type TEXT DEFAULT 'text',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_message_templates (
        id TEXT PRIMARY KEY,
        folder_id TEXT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        category TEXT DEFAULT 'utility',
        language TEXT DEFAULT 'es_MX',
        status TEXT DEFAULT 'draft',
        header_enabled INTEGER DEFAULT 0,
        header_type TEXT DEFAULT 'none',
        header_text TEXT,
        header_media_url TEXT,
        header_location_json TEXT,
        body_text TEXT NOT NULL,
        footer_text TEXT,
        buttons_json TEXT,
        variables_json TEXT,
        variable_examples_json TEXT,
        variable_bindings_json TEXT,
        ycloud_template_id TEXT,
        ycloud_status TEXT,
        ycloud_reason TEXT,
        ycloud_status_update_event TEXT,
        ycloud_quality_rating TEXT,
        ycloud_raw_payload_json TEXT,
        ycloud_submitted_at DATETIME,
        ycloud_synced_at DATETIME,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (folder_id) REFERENCES whatsapp_template_folders(id) ON DELETE SET NULL
      )
    `)

    for (const [columnName, columnType] of [
      ['variable_bindings_json', 'TEXT'],
      ['ycloud_reason', 'TEXT'],
      ['ycloud_status_update_event', 'TEXT'],
      ['ycloud_quality_rating', 'TEXT'],
      ['ycloud_raw_payload_json', 'TEXT'],
      ['ycloud_submitted_at', 'DATETIME'],
      ['ycloud_synced_at', 'DATETIME'],
      ['last_error', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE whatsapp_message_templates ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_template_folders_parent ON whatsapp_template_folders(parent_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_message_templates_folder ON whatsapp_message_templates(folder_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_message_templates_status ON whatsapp_message_templates(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_message_templates_ycloud ON whatsapp_message_templates(ycloud_status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_template_custom_fields_key ON whatsapp_template_custom_fields(field_key)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS contact_custom_field_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS contact_custom_field_definitions (
        id TEXT PRIMARY KEY,
        owner_user_id INTEGER,
        field_key TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        data_type TEXT DEFAULT 'text',
        folder_id TEXT,
        field_group TEXT DEFAULT 'general',
        options_json TEXT,
        sync_target TEXT DEFAULT 'local',
        source_type TEXT DEFAULT 'manual',
        source_id TEXT,
        source_site_id TEXT,
        source_page_id TEXT,
        source_form_id TEXT,
        source_form_name TEXT,
        source_field_id TEXT,
        source_field_name TEXT,
        source_label TEXT,
        source_context_json TEXT,
        archived INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (folder_id) REFERENCES contact_custom_field_folders(id) ON DELETE SET NULL
      )
    `)

    try {
      await db.run('ALTER TABLE contact_custom_field_definitions ADD COLUMN folder_id TEXT')
    } catch (err) {
      // Columna ya existe, ignorar.
    }

    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_custom_field_folders_archived ON contact_custom_field_folders(archived)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_custom_field_folders_sort ON contact_custom_field_folders(sort_order, name)')
    await db.run('DROP INDEX IF EXISTS idx_contact_custom_field_definitions_owner_key')
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_custom_field_definitions_owner_key ON contact_custom_field_definitions(COALESCE(owner_user_id, 0), LOWER(field_key)) WHERE archived = 0')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_custom_field_definitions_folder ON contact_custom_field_definitions(folder_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_custom_field_definitions_source_site ON contact_custom_field_definitions(source_site_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_custom_field_definitions_archived ON contact_custom_field_definitions(archived)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS contact_custom_field_definition_sources (
        id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL,
        source_type TEXT DEFAULT 'manual',
        source_id TEXT,
        source_site_id TEXT,
        source_page_id TEXT,
        source_form_id TEXT,
        source_form_name TEXT,
        source_field_id TEXT,
        source_field_name TEXT,
        source_label TEXT,
        source_context_json TEXT,
        occurrence_count INTEGER DEFAULT 1,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (definition_id) REFERENCES contact_custom_field_definitions(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_custom_field_definition_sources_unique
      ON contact_custom_field_definition_sources(
        definition_id,
        source_type,
        COALESCE(source_id, ''),
        COALESCE(source_site_id, ''),
        COALESCE(source_page_id, ''),
        COALESCE(source_form_id, ''),
        COALESCE(source_field_id, ''),
        LOWER(COALESCE(source_field_name, ''))
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_custom_field_definition_sources_definition ON contact_custom_field_definition_sources(definition_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_custom_field_definition_sources_site ON contact_custom_field_definition_sources(source_site_id)')

    // Tabla de contactos
    await db.run(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        phone TEXT UNIQUE,
        email TEXT UNIQUE,
        full_name TEXT,
        first_name TEXT,
        last_name TEXT,
        source TEXT,
        visitor_id TEXT,
        attribution_url TEXT,
        attribution_session_source TEXT,
        attribution_medium TEXT,
        attribution_ctwa_clid TEXT,
        attribution_ad_name TEXT,
        attribution_ad_id TEXT,
        total_paid REAL DEFAULT 0,
        purchases_count INTEGER DEFAULT 0,
        last_purchase_date DATETIME,
        appointment_date DATETIME,
        meta_schedule_event_sent INTEGER DEFAULT 0,
        meta_schedule_event_sent_at DATETIME,
        meta_schedule_event_id TEXT,
        meta_purchase_event_sent INTEGER DEFAULT 0,
        meta_purchase_event_sent_at DATETIME,
        meta_purchase_event_id TEXT,
        preferred_whatsapp_phone_number_id TEXT,
        custom_fields ${usePostgres ? "JSONB DEFAULT '[]'::jsonb" : "TEXT DEFAULT '[]'"},
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    try {
      await db.run('ALTER TABLE contacts ADD COLUMN preferred_whatsapp_phone_number_id TEXT')
    } catch (err) {
      // Columna ya existe, ignorar.
    }

    // Índices para contacts
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_ad_id ON contacts(attribution_ad_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_preferred_whatsapp_phone ON contacts(preferred_whatsapp_phone_number_id)')
    try {
      await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_meta_schedule_sent ON contacts(meta_schedule_event_sent)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_meta_purchase_sent ON contacts(meta_purchase_event_sent)')
    } catch (err) {
      if (!err.message.includes('no such column') && !err.message.includes('does not exist')) {
        throw err
      }
    }

    // Catálogo local de productos/precios.
    // Ristak puede operar sin HighLevel; cuando GHL se conecta, estos registros
    // se emparejan por IDs remotos o firma exacta antes de crear nada remoto.
    await db.run(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        ghl_product_id TEXT UNIQUE,
        location_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        product_type TEXT DEFAULT 'DIGITAL',
        image TEXT,
        available_in_store INTEGER DEFAULT 0,
        currency TEXT DEFAULT 'MXN',
        is_active INTEGER DEFAULT 1,
        source TEXT DEFAULT 'ristak',
        sync_status TEXT DEFAULT 'pending',
        sync_origin TEXT DEFAULT 'ristak',
        sync_error TEXT,
        raw_json TEXT,
        last_synced_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS product_prices (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        ghl_price_id TEXT UNIQUE,
        ghl_product_id TEXT,
        location_id TEXT,
        name TEXT NOT NULL,
        type TEXT DEFAULT 'one_time',
        currency TEXT DEFAULT 'MXN',
        amount REAL NOT NULL,
        description TEXT,
        interval TEXT,
        interval_count INTEGER,
        trial_period INTEGER,
        total_cycles INTEGER,
        setup_fee REAL,
        compare_at_price REAL,
        sku TEXT,
        track_inventory INTEGER DEFAULT 0,
        available_quantity REAL,
        allow_out_of_stock_purchases INTEGER DEFAULT 0,
        is_digital_product INTEGER DEFAULT 1,
        variant_option_ids TEXT,
        shipping_options TEXT,
        metadata TEXT,
        source TEXT DEFAULT 'ristak',
        sync_status TEXT DEFAULT 'pending',
        sync_origin TEXT DEFAULT 'ristak',
        sync_error TEXT,
        raw_json TEXT,
        last_synced_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_products_ghl_product ON products(ghl_product_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_products_sync_status ON products(sync_status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_product_prices_product ON product_prices(product_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_product_prices_ghl_price ON product_prices(ghl_price_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_product_prices_sync_status ON product_prices(sync_status)')

    // Tabla de pagos
    await db.run(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        amount REAL,
        currency TEXT DEFAULT 'MXN',
        status TEXT,
        payment_method TEXT,
        payment_mode TEXT DEFAULT 'live',
        reference TEXT,
        title TEXT,
        description TEXT,
        date DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_payments_contact ON payments(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(date)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)')

    // Tabla local de planes de pago / invoice schedules de HighLevel.
    // GoHighLevel sigue siendo la integración activa, pero guardamos un espejo local
    // para reportes, respaldo y lectura cuando GHL no esté disponible.
    await db.run(`
      CREATE TABLE IF NOT EXISTS payment_plans (
        id TEXT PRIMARY KEY,
        ghl_schedule_id TEXT UNIQUE,
        contact_id TEXT,
        contact_name TEXT,
        email TEXT,
        phone TEXT,
        name TEXT,
        title TEXT,
        status TEXT,
        total REAL DEFAULT 0,
        currency TEXT,
        description TEXT,
        recurrence_label TEXT,
        start_date DATETIME,
        next_run_at DATETIME,
        end_date DATETIME,
        live_mode INTEGER,
        item_count INTEGER DEFAULT 0,
        schedule_json TEXT,
        raw_json TEXT,
        source TEXT DEFAULT 'ghl',
        last_synced_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_plans_contact ON payment_plans(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_plans_status ON payment_plans(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_plans_next_run ON payment_plans(next_run_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_plans_updated ON payment_plans(updated_at)')

    // Tabla de citas
    await db.run(`
      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        calendar_id TEXT,
        contact_id TEXT,
        location_id TEXT,
        title TEXT,
        status TEXT,
        appointment_status TEXT,
        assigned_user_id TEXT,
        notes TEXT,
        address TEXT,
        start_time DATETIME,
        end_time DATETIME,
        date_added DATETIME,
        date_updated DATETIME,
        google_event_id TEXT UNIQUE,
        google_sync_status TEXT,
        google_sync_error TEXT,
        google_synced_at DATETIME,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_contact ON appointments(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_start_time ON appointments(start_time)')

    // Calendarios locales de Ristak. Si un calendario viene de HighLevel,
    // ghl_calendar_id guarda el ID remoto; si nace en Ristak, se llena al sincronizar.
    await db.run(`
      CREATE TABLE IF NOT EXISTS calendars (
        id TEXT PRIMARY KEY,
        ghl_calendar_id TEXT UNIQUE,
        location_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        slug TEXT,
        widget_slug TEXT,
        calendar_type TEXT DEFAULT 'event',
        widget_type TEXT,
        event_title TEXT,
        event_color TEXT DEFAULT '#3b82f6',
        is_active INTEGER DEFAULT 1,
        team_members TEXT,
        location_configurations TEXT,
        slot_duration INTEGER DEFAULT 60,
        slot_duration_unit TEXT DEFAULT 'mins',
        slot_interval INTEGER DEFAULT 60,
        slot_interval_unit TEXT DEFAULT 'mins',
        slot_buffer INTEGER DEFAULT 0,
        slot_buffer_unit TEXT DEFAULT 'mins',
        pre_buffer INTEGER DEFAULT 0,
        pre_buffer_unit TEXT DEFAULT 'mins',
        appoinment_per_slot INTEGER DEFAULT 1,
        appoinment_per_day INTEGER DEFAULT 0,
        allow_booking_after INTEGER DEFAULT 0,
        allow_booking_after_unit TEXT DEFAULT 'hours',
        allow_booking_for INTEGER DEFAULT 30,
        allow_booking_for_unit TEXT DEFAULT 'days',
        open_hours TEXT,
        auto_confirm INTEGER DEFAULT 1,
        allow_reschedule INTEGER DEFAULT 1,
        allow_cancellation INTEGER DEFAULT 1,
        notes TEXT,
        availability_type INTEGER DEFAULT 0,
        source TEXT DEFAULT 'ristak',
        sync_status TEXT DEFAULT 'pending',
        sync_error TEXT,
        last_synced_at DATETIME,
        raw_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_calendars_ghl ON calendars(ghl_calendar_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_calendars_source ON calendars(source)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_calendars_active ON calendars(is_active)')
    try {
      await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_calendars_ghl_unique ON calendars(ghl_calendar_id) WHERE ghl_calendar_id IS NOT NULL AND ghl_calendar_id != ''")
    } catch (err) {
      logger.warn('Advertencia al crear índice único de calendars.ghl_calendar_id:', err.message)
    }

    for (const [columnName, columnType] of [
      ['ghl_appointment_id', 'TEXT'],
      ['source', "TEXT DEFAULT 'ghl'"],
      ['sync_status', "TEXT DEFAULT 'synced'"],
      ['sync_error', 'TEXT'],
      ['synced_at', 'DATETIME'],
      ['deleted_at', 'DATETIME'],
      ['google_event_id', 'TEXT'],
      ['google_sync_status', 'TEXT'],
      ['google_sync_error', 'TEXT'],
      ['google_synced_at', 'DATETIME']
    ]) {
      try {
        await db.run(`ALTER TABLE appointments ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    try {
      await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_ghl ON appointments(ghl_appointment_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_sync_status ON appointments(sync_status)')
      await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_ghl_unique ON appointments(ghl_appointment_id) WHERE ghl_appointment_id IS NOT NULL AND ghl_appointment_id != ''")
      await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_google ON appointments(google_event_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_google_sync_status ON appointments(google_sync_status)')
      await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_google_unique ON appointments(google_event_id) WHERE google_event_id IS NOT NULL AND google_event_id != ''")
    } catch (err) {
      logger.warn('Advertencia al crear índices de sync de appointments:', err.message)
    }

    for (const [columnName, columnType] of [
      ['ghl_calendar_id', 'TEXT'],
      ['location_id', 'TEXT'],
      ['description', 'TEXT'],
      ['slug', 'TEXT'],
      ['widget_slug', 'TEXT'],
      ['calendar_type', "TEXT DEFAULT 'event'"],
      ['widget_type', 'TEXT'],
      ['event_title', 'TEXT'],
      ['event_color', "TEXT DEFAULT '#3b82f6'"],
      ['is_active', 'INTEGER DEFAULT 1'],
      ['team_members', 'TEXT'],
      ['location_configurations', 'TEXT'],
      ['slot_duration', 'INTEGER DEFAULT 60'],
      ['slot_duration_unit', "TEXT DEFAULT 'mins'"],
      ['slot_interval', 'INTEGER DEFAULT 60'],
      ['slot_interval_unit', "TEXT DEFAULT 'mins'"],
      ['slot_buffer', 'INTEGER DEFAULT 0'],
      ['slot_buffer_unit', "TEXT DEFAULT 'mins'"],
      ['pre_buffer', 'INTEGER DEFAULT 0'],
      ['pre_buffer_unit', "TEXT DEFAULT 'mins'"],
      ['appoinment_per_slot', 'INTEGER DEFAULT 1'],
      ['appoinment_per_day', 'INTEGER DEFAULT 0'],
      ['allow_booking_after', 'INTEGER DEFAULT 0'],
      ['allow_booking_after_unit', "TEXT DEFAULT 'hours'"],
      ['allow_booking_for', 'INTEGER DEFAULT 30'],
      ['allow_booking_for_unit', "TEXT DEFAULT 'days'"],
      ['open_hours', 'TEXT'],
      ['auto_confirm', 'INTEGER DEFAULT 1'],
      ['allow_reschedule', 'INTEGER DEFAULT 1'],
      ['allow_cancellation', 'INTEGER DEFAULT 1'],
      ['notes', 'TEXT'],
      ['availability_type', 'INTEGER DEFAULT 0'],
      ['source', "TEXT DEFAULT 'ristak'"],
      ['sync_status', "TEXT DEFAULT 'pending'"],
      ['sync_error', 'TEXT'],
      ['last_synced_at', 'DATETIME'],
      ['raw_json', 'TEXT'],
      ['created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP'],
      ['updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP']
    ]) {
      try {
        await db.run(`ALTER TABLE calendars ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    // Señales irreversibles para atribución de asistencia.
    // No alteran el estado operativo del calendario.
    await db.run(`
      CREATE TABLE IF NOT EXISTS appointment_attendance_signals (
        contact_id TEXT PRIMARY KEY,
        appointment_id TEXT,
        source TEXT NOT NULL DEFAULT 'webhook_showed',
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_attendance_signals_appointment ON appointment_attendance_signals(appointment_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_attendance_signals_contact ON appointment_attendance_signals(contact_id)')

    // Tabla de configuración de Meta
    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ad_account_id TEXT UNIQUE,
        access_token TEXT NOT NULL,
        app_id TEXT,
        app_secret TEXT,
        instagram_account_id TEXT,
        token_expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_social_contacts (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        platform TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        recipient_id TEXT,
        page_id TEXT,
        instagram_account_id TEXT,
        profile_name TEXT,
        username TEXT,
        profile_picture_url TEXT,
        raw_profile_json TEXT,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        message_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(platform, sender_id),
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_social_messages (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        meta_message_id TEXT,
        meta_social_contact_id TEXT,
        contact_id TEXT,
        sender_id TEXT,
        recipient_id TEXT,
        page_id TEXT,
        instagram_account_id TEXT,
        direction TEXT,
        status TEXT,
        message_type TEXT,
        message_text TEXT,
        media_url TEXT,
        media_mime_type TEXT,
        postback_payload TEXT,
        message_timestamp DATETIME,
        raw_payload_json TEXT,
        referral_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (meta_social_contact_id) REFERENCES meta_social_contacts(id) ON DELETE SET NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_social_webhook_events (
        id TEXT PRIMARY KEY,
        platform TEXT,
        object_type TEXT,
        event_type TEXT,
        signature_valid INTEGER,
        processed_status TEXT DEFAULT 'received',
        processed_error TEXT,
        raw_payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_conversion_event_logs (
        id ${usePostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        contact_id TEXT,
        event_type TEXT NOT NULL,
        meta_event_name TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        request_payload TEXT,
        response_payload TEXT,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_conversion_logs_contact ON meta_conversion_event_logs(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_conversion_logs_event ON meta_conversion_event_logs(event_type, event_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_conversion_logs_created ON meta_conversion_event_logs(created_at)')

    // Tabla de ads de Meta
    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_ads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        ad_account_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        campaign_name TEXT,
        adset_id TEXT NOT NULL,
        adset_name TEXT,
        ad_id TEXT NOT NULL,
        ad_name TEXT,
        creative_id TEXT,
        creative_type TEXT,
        creative_thumbnail_url TEXT,
        creative_image_url TEXT,
        creative_video_id TEXT,
        creative_video_url TEXT,
        creative_preview_url TEXT,
        spend REAL DEFAULT 0,
        reach INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        cpc REAL DEFAULT 0,
        cpm REAL DEFAULT 0,
        ctr REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(date, campaign_id, adset_id, ad_id)
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_ads_date ON meta_ads(date)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_ads_campaign ON meta_ads(campaign_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_ads_ad ON meta_ads(ad_id)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_campaign_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT,
        mode TEXT,
        template_version INTEGER DEFAULT 1,
        template_json TEXT NOT NULL,
        is_system INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_templates_category ON meta_campaign_templates(category)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_templates_active ON meta_campaign_templates(is_active)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_campaign_drafts (
        id TEXT PRIMARY KEY,
        template_id TEXT,
        status TEXT DEFAULT 'draft',
        trace_id TEXT UNIQUE,
        name TEXT,
        user_id INTEGER,
        source_content_json TEXT,
        config_snapshot_json TEXT,
        template_snapshot_json TEXT,
        payload_json TEXT,
        validation_json TEXT,
        preview_json TEXT,
        execution_status TEXT DEFAULT 'not_executed',
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        executed_at DATETIME
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_drafts_template ON meta_campaign_drafts(template_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_drafts_status ON meta_campaign_drafts(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_drafts_trace ON meta_campaign_drafts(trace_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_drafts_created ON meta_campaign_drafts(created_at)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_campaign_execution_logs (
        id TEXT PRIMARY KEY,
        draft_id TEXT,
        trace_id TEXT,
        step TEXT NOT NULL,
        status TEXT,
        mcp_server_url TEXT,
        request_payload_json TEXT,
        response_payload_json TEXT,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_logs_draft ON meta_campaign_execution_logs(draft_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_logs_trace ON meta_campaign_execution_logs(trace_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_logs_created ON meta_campaign_execution_logs(created_at)')

    // Tabla de atribución de WhatsApp
    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_attribution (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id TEXT,
        phone TEXT,
        referral_source_url TEXT,
        referral_source_type TEXT,
        referral_source_id TEXT,
        referral_headline TEXT,
        referral_body TEXT,
        referral_image_url TEXT,
        referral_video_url TEXT,
        referral_thumbnail_url TEXT,
        referral_ctwa_clid TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)

    // Agregar columnas nuevas si no existen (para migración) - PRIMERO
    try {
      await db.run(`ALTER TABLE whatsapp_attribution ADD COLUMN message_content TEXT`)
    } catch (err) {
      // Columna ya existe, ignorar
    }

    try {
      await db.run(`ALTER TABLE whatsapp_attribution ADD COLUMN ad_id_thru_message TEXT`)
    } catch (err) {
      // Columna ya existe, ignorar
    }

    // Eliminar columna extracted_ad_id si existe (renombrada a ad_id_thru_message)
    try {
      await db.run(`ALTER TABLE whatsapp_attribution DROP COLUMN extracted_ad_id`)
    } catch (err) {
      // Columna no existe o DB no soporta DROP, ignorar
    }

    // Crear índices DESPUÉS de asegurar que las columnas existen
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_contact ON whatsapp_attribution(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_ad_id ON whatsapp_attribution(ad_id_thru_message)')

    const oldWhatsAppPrefix = ['whatsapp', 'web'].join('_')
    for (const suffix of [
      'logs',
      'attribution',
      'messages',
      'chats',
      'contacts',
      'auth_state',
      'sessions'
    ]) {
      const tableName = `${oldWhatsAppPrefix}_${suffix}`
      try {
        await db.run(`DROP TABLE IF EXISTS ${tableName}`)
      } catch (err) {
        logger.warn(`No se pudo eliminar ${tableName}: ${err.message}`)
      }
    }

    // Tablas de WhatsApp_API oficial via YCloud.
    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_phone_numbers (
        id TEXT PRIMARY KEY,
        waba_id TEXT,
        phone_number TEXT,
        display_phone_number TEXT,
        verified_name TEXT,
        profile_picture_url TEXT,
        business_profile_json TEXT,
        quality_rating TEXT,
        messaging_limit TEXT,
        status TEXT,
        raw_payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    for (const [columnName, columnType] of [
      ['profile_picture_url', 'TEXT'],
      ['business_profile_json', 'TEXT'],
      ['label', 'TEXT'],
      ['is_default_sender', 'INTEGER DEFAULT 0'],
      ['api_send_enabled', 'INTEGER DEFAULT 1'],
      ['qr_send_enabled', 'INTEGER DEFAULT 0'],
      ['qr_consent_accepted_at', 'DATETIME'],
      ['qr_consent_accepted_by', 'TEXT'],
      ['qr_status', 'TEXT'],
      ['qr_connected_phone', 'TEXT'],
      ['qr_last_connected_at', 'DATETIME'],
      ['qr_last_disconnected_at', 'DATETIME'],
      ['qr_last_error', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE whatsapp_api_phone_numbers ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_contacts (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        phone TEXT UNIQUE,
        profile_name TEXT,
        profile_picture_url TEXT,
        profile_picture_source TEXT,
        profile_picture_updated_at DATETIME,
        profile_picture_error TEXT,
        raw_profile_json TEXT,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        message_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    for (const [columnName, columnType] of [
      ['profile_picture_url', 'TEXT'],
      ['profile_picture_source', 'TEXT'],
      ['profile_picture_updated_at', 'DATETIME'],
      ['profile_picture_error', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE whatsapp_api_contacts ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_messages (
        id TEXT PRIMARY KEY,
        ycloud_message_id TEXT,
        wamid TEXT,
        waba_id TEXT,
        business_phone_number_id TEXT,
        whatsapp_api_contact_id TEXT,
        contact_id TEXT,
        phone TEXT,
        from_phone TEXT,
        to_phone TEXT,
        business_phone TEXT,
        transport TEXT DEFAULT 'api',
        direction TEXT,
        message_type TEXT,
        message_text TEXT,
        media_url TEXT,
        media_mime_type TEXT,
        media_filename TEXT,
        media_duration_ms INTEGER,
        status TEXT,
        error_code TEXT,
        error_message TEXT,
        message_timestamp DATETIME,
        raw_payload_json TEXT,
        context_json TEXT,
        referral_json TEXT,
        detected_ctwa_clid TEXT,
        detected_source_id TEXT,
        detected_source_url TEXT,
        detected_source_type TEXT,
        detected_source_app TEXT,
        detected_entry_point TEXT,
        detected_headline TEXT,
        detected_body TEXT,
        detected_conversion_data TEXT,
        detected_ctwa_payload TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (whatsapp_api_contact_id) REFERENCES whatsapp_api_contacts(id) ON DELETE SET NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    for (const [columnName, columnType] of [
      ['business_phone_number_id', 'TEXT'],
      ['transport', "TEXT DEFAULT 'api'"],
      ['media_url', 'TEXT'],
      ['media_mime_type', 'TEXT'],
      ['media_filename', 'TEXT'],
      ['media_duration_ms', 'INTEGER']
    ]) {
      try {
        await db.run(`ALTER TABLE whatsapp_api_messages ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_chat_messages (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        channel TEXT,
        transport TEXT,
        message_text TEXT NOT NULL,
        to_phone TEXT,
        from_phone TEXT,
        business_phone_number_id TEXT,
        scheduled_at DATETIME NOT NULL,
        status TEXT DEFAULT 'scheduled',
        external_id TEXT,
        sent_message_id TEXT,
        attempts INTEGER DEFAULT 0,
        error_message TEXT,
        raw_payload_json TEXT,
        last_attempt_at DATETIME,
        sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)

    for (const [columnName, columnType] of [
      ['provider', 'TEXT'],
      ['channel', 'TEXT'],
      ['transport', 'TEXT'],
      ['message_text', 'TEXT'],
      ['to_phone', 'TEXT'],
      ['from_phone', 'TEXT'],
      ['business_phone_number_id', 'TEXT'],
      ['scheduled_at', 'DATETIME'],
      ['status', "TEXT DEFAULT 'scheduled'"],
      ['external_id', 'TEXT'],
      ['sent_message_id', 'TEXT'],
      ['attempts', 'INTEGER DEFAULT 0'],
      ['error_message', 'TEXT'],
      ['raw_payload_json', 'TEXT'],
      ['last_attempt_at', 'DATETIME'],
      ['sent_at', 'DATETIME']
    ]) {
      try {
        await db.run(`ALTER TABLE scheduled_chat_messages ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_attribution (
        id TEXT PRIMARY KEY,
        whatsapp_api_message_id TEXT,
        whatsapp_api_contact_id TEXT,
        contact_id TEXT,
        phone TEXT,
        ycloud_message_id TEXT,
        wamid TEXT,
        detected_ctwa_clid TEXT,
        detected_source_id TEXT,
        detected_source_url TEXT,
        detected_source_type TEXT,
        detected_source_app TEXT,
        detected_entry_point TEXT,
        detected_headline TEXT,
        detected_body TEXT,
        detected_conversion_data TEXT,
        detected_ctwa_payload TEXT,
        referral_json TEXT,
        raw_payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (whatsapp_api_message_id) REFERENCES whatsapp_api_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (whatsapp_api_contact_id) REFERENCES whatsapp_api_contacts(id) ON DELETE SET NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_webhook_events (
        id TEXT PRIMARY KEY,
        event_id TEXT UNIQUE,
        event_type TEXT,
        api_version TEXT,
        webhook_endpoint_id TEXT,
        signature_valid INTEGER,
        processed_status TEXT DEFAULT 'received',
        processed_error TEXT,
        raw_payload_json TEXT,
        ycloud_create_time DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_balance (
        id TEXT PRIMARY KEY,
        amount REAL DEFAULT 0,
        currency TEXT,
        raw_payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_templates (
        id TEXT PRIMARY KEY,
        official_template_id TEXT,
        waba_id TEXT NOT NULL,
        name TEXT NOT NULL,
        language TEXT NOT NULL,
        category TEXT,
        sub_category TEXT,
        previous_category TEXT,
        message_send_ttl_seconds INTEGER,
        status TEXT,
        quality_rating TEXT,
        reason TEXT,
        status_update_event TEXT,
        disable_date DATETIME,
        components_json TEXT,
        raw_payload_json TEXT,
        ycloud_create_time DATETIME,
        ycloud_update_time DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(waba_id, name, language)
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_alerts (
        id TEXT PRIMARY KEY,
        severity TEXT DEFAULT 'info',
        alert_type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT,
        source_event_id TEXT,
        entity_type TEXT,
        entity_id TEXT,
        status TEXT DEFAULT 'active',
        raw_payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (source_event_id) REFERENCES whatsapp_api_webhook_events(id) ON DELETE SET NULL
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_template_sends (
        id TEXT PRIMARY KEY,
        template_id TEXT,
        template_name TEXT,
        language TEXT,
        to_phone TEXT,
        from_phone TEXT,
        ycloud_message_id TEXT,
        wamid TEXT,
        status TEXT,
        variables_json TEXT,
        raw_payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (template_id) REFERENCES whatsapp_api_templates(id) ON DELETE SET NULL
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_qr_sessions (
        id TEXT PRIMARY KEY,
        phone_number_id TEXT NOT NULL,
        expected_phone TEXT NOT NULL,
        connected_phone TEXT,
        status TEXT DEFAULT 'disconnected',
        qr_code TEXT,
        qr_code_data_url TEXT,
        consent_accepted INTEGER DEFAULT 0,
        consent_text TEXT,
        consent_accepted_at DATETIME,
        consent_accepted_by TEXT,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_connected_at DATETIME,
        last_disconnected_at DATETIME,
        FOREIGN KEY (phone_number_id) REFERENCES whatsapp_api_phone_numbers(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_qr_auth_state (
        phone_number_id TEXT NOT NULL,
        auth_key TEXT NOT NULL,
        value_json TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (phone_number_id, auth_key),
        FOREIGN KEY (phone_number_id) REFERENCES whatsapp_api_phone_numbers(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_phone_numbers_phone ON whatsapp_api_phone_numbers(phone_number)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_phone_numbers_default ON whatsapp_api_phone_numbers(is_default_sender)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_contacts_phone ON whatsapp_api_contacts(phone)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_contacts_contact ON whatsapp_api_contacts(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_contact ON whatsapp_api_messages(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_contact_date ON whatsapp_api_messages(contact_id, message_timestamp, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_phone ON whatsapp_api_messages(phone)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_business_phone ON whatsapp_api_messages(business_phone)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_business_phone_id ON whatsapp_api_messages(business_phone_number_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_created ON whatsapp_api_messages(created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_wamid ON whatsapp_api_messages(wamid)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_scheduled_chat_messages_contact ON scheduled_chat_messages(contact_id, status, scheduled_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_scheduled_chat_messages_due ON scheduled_chat_messages(status, scheduled_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_attr_contact ON whatsapp_api_attribution(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_attr_source ON whatsapp_api_attribution(detected_source_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_attr_ctwa ON whatsapp_api_attribution(detected_ctwa_clid)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_events_type_created ON whatsapp_api_webhook_events(event_type, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_balance_updated ON whatsapp_api_balance(updated_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_templates_status ON whatsapp_api_templates(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_templates_waba ON whatsapp_api_templates(waba_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_alerts_status_severity ON whatsapp_api_alerts(status, severity, updated_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_alerts_entity ON whatsapp_api_alerts(entity_type, entity_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_template_sends_created ON whatsapp_api_template_sends(created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_template_sends_status ON whatsapp_api_template_sends(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_qr_sessions_phone ON whatsapp_qr_sessions(phone_number_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_qr_sessions_status ON whatsapp_qr_sessions(status, updated_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_qr_auth_state_phone ON whatsapp_qr_auth_state(phone_number_id)')

    // Tabla de versiones de Meta API (para auto-actualización)
    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_api_version (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Tabla de flujos de pago por parcialidades.
    // Guarda el estado de autorización/tarjeta sin contaminar la tabla de pagos reales.
    await db.run(`
      CREATE TABLE IF NOT EXISTS payment_flows (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        contact_name TEXT,
        contact_email TEXT,
        contact_phone TEXT,
        total_amount REAL NOT NULL,
        currency TEXT DEFAULT 'MXN',
        concept TEXT,
        payment_type TEXT DEFAULT 'partial',
        first_payment_amount REAL DEFAULT 0,
        first_payment_type TEXT,
        first_payment_value REAL,
        first_payment_date DATETIME,
        first_payment_method TEXT,
        first_payment_status TEXT,
        first_payment_invoice_id TEXT,
        remaining_automatic INTEGER DEFAULT 0,
        card_setup_required INTEGER DEFAULT 0,
        card_setup_amount REAL DEFAULT 25,
        card_setup_status TEXT,
        card_setup_invoice_id TEXT,
        card_setup_payment_link TEXT,
        ghl_customer_id TEXT,
        ghl_payment_method_id TEXT,
        ghl_payment_method_type TEXT,
        ghl_card_brand TEXT,
        ghl_card_last4 TEXT,
        ghl_card_authorization_invoice_id TEXT,
        ghl_payment_provider_type TEXT,
        ghl_payment_provider_account TEXT,
        ghl_payment_live_mode INTEGER,
        current_state TEXT NOT NULL,
        state_history TEXT,
        card_authorized_at DATETIME,
        installment_plan_created_at DATETIME,
        installment_plan_active_at DATETIME,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_contact ON payment_flows(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_state ON payment_flows(current_state)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_first_invoice ON payment_flows(first_payment_invoice_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_card_setup_invoice ON payment_flows(card_setup_invoice_id)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS installment_payments (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        amount REAL NOT NULL,
        percentage REAL,
        due_date DATETIME,
        frequency TEXT DEFAULT 'custom',
        payment_method TEXT,
        automatic INTEGER DEFAULT 0,
        status TEXT NOT NULL,
        ghl_invoice_id TEXT,
        ghl_schedule_id TEXT,
        ghl_schedule_status TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (flow_id) REFERENCES payment_flows(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_flow ON installment_payments(flow_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_status ON installment_payments(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_due_date ON installment_payments(due_date)')

    // Agregar columnas que puedan faltar en tablas existentes
    try {
      // Agregar ghl_invoice_id a payments. SQLite no permite ADD COLUMN con UNIQUE
      // en tablas existentes; el índice se crea después si la columna existe.
      try {
        await db.run('ALTER TABLE payments ADD COLUMN ghl_invoice_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar invoice_number para mostrar en UI
      try {
        await db.run('ALTER TABLE payments ADD COLUMN invoice_number TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar due_date para pagos pendientes
      try {
        await db.run('ALTER TABLE payments ADD COLUMN due_date DATETIME')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar sent_at para saber cuándo se envió
      try {
        await db.run('ALTER TABLE payments ADD COLUMN sent_at DATETIME')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar updated_at para soportar edición de pagos
      try {
        await db.run('ALTER TABLE payments ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar payment_mode para separar pagos reales de modo prueba/test
      try {
        await db.run('ALTER TABLE payments ADD COLUMN payment_mode TEXT DEFAULT \'live\'')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE payments ADD COLUMN title TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_payments_payment_mode ON payments(payment_mode)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column')) {
          throw err
        }
      }

      // Agregar location_data a highlevel_config si no existe
      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN location_data TEXT')
      } catch (err) {
        // Si falla es porque la columna ya existe, está bien
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar custom_labels a highlevel_config si no existe
      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN custom_labels TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar updated_at a contacts si no existe
      try {
        await db.run('ALTER TABLE contacts ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      const contactMetaEventColumns = [
        ['meta_schedule_event_sent', 'INTEGER DEFAULT 0'],
        ['meta_schedule_event_sent_at', 'DATETIME'],
        ['meta_schedule_event_id', 'TEXT'],
        ['meta_purchase_event_sent', 'INTEGER DEFAULT 0'],
        ['meta_purchase_event_sent_at', 'DATETIME'],
        ['meta_purchase_event_id', 'TEXT']
      ]

      for (const [columnName, columnType] of contactMetaEventColumns) {
        try {
          await db.run(`ALTER TABLE contacts ADD COLUMN ${columnName} ${columnType}`)
        } catch (err) {
          if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
            throw err
          }
        }
      }

      try {
        await db.run(`ALTER TABLE contacts ADD COLUMN custom_fields ${usePostgres ? "JSONB DEFAULT '[]'::jsonb" : "TEXT DEFAULT '[]'"}`)
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_meta_schedule_sent ON contacts(meta_schedule_event_sent)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_meta_purchase_sent ON contacts(meta_purchase_event_sent)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column') && !err.message.includes('does not exist')) {
          throw err
        }
      }

      // Agregar columnas de timezone a meta_config
      try {
        await db.run('ALTER TABLE meta_config ADD COLUMN timezone_id INTEGER')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE meta_config ADD COLUMN timezone_name TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE meta_config ADD COLUMN timezone_offset_hours_utc INTEGER')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar columna pixel_id a meta_config
      try {
        await db.run('ALTER TABLE meta_config ADD COLUMN pixel_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar columna pixel_api_token a meta_config (Conversions API Token)
      try {
        await db.run('ALTER TABLE meta_config ADD COLUMN pixel_api_token TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar columna page_id a meta_config
      try {
        await db.run('ALTER TABLE meta_config ADD COLUMN page_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE meta_config ADD COLUMN instagram_account_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        if (usePostgres) {
          await db.run('ALTER TABLE meta_config ALTER COLUMN ad_account_id DROP NOT NULL')
        } else {
          const columns = await db.all('PRAGMA table_info(meta_config)')
          const adAccountColumn = columns.find(column => column.name === 'ad_account_id')

          if (adAccountColumn?.notnull) {
            await db.exec(`
              PRAGMA foreign_keys=off;
              DROP TABLE IF EXISTS meta_config_shared_token_migration;
              CREATE TABLE meta_config_shared_token_migration (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ad_account_id TEXT UNIQUE,
                access_token TEXT NOT NULL,
                app_id TEXT,
                app_secret TEXT,
                token_expires_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                timezone_id INTEGER,
                timezone_name TEXT,
                timezone_offset_hours_utc INTEGER,
                pixel_id TEXT,
                pixel_api_token TEXT,
                page_id TEXT,
                instagram_account_id TEXT
              );
              INSERT INTO meta_config_shared_token_migration (
                id, ad_account_id, access_token, app_id, app_secret, token_expires_at,
                created_at, updated_at, timezone_id, timezone_name, timezone_offset_hours_utc,
                pixel_id, pixel_api_token, page_id, instagram_account_id
              )
              SELECT
                id, ad_account_id, access_token, app_id, app_secret, token_expires_at,
                created_at, updated_at, timezone_id, timezone_name, timezone_offset_hours_utc,
                pixel_id, pixel_api_token, page_id, instagram_account_id
              FROM meta_config;
              DROP TABLE meta_config;
              ALTER TABLE meta_config_shared_token_migration RENAME TO meta_config;
              PRAGMA foreign_keys=on;
            `)
          }
        }
      } catch (err) {
        if (!err.message.includes('already exists')) {
          logger.warn('Advertencia al permitir token Meta compartido sin cuenta de anuncios:', err.message)
        }
      }

      // Agregar columnas de creative a meta_ads para previsualizar anuncios
      const metaAdsCreativeColumns = [
        ['creative_id', 'TEXT'],
        ['creative_type', 'TEXT'],
        ['creative_thumbnail_url', 'TEXT'],
        ['creative_image_url', 'TEXT'],
        ['creative_video_id', 'TEXT'],
        ['creative_video_url', 'TEXT'],
        ['creative_preview_url', 'TEXT']
      ]

      for (const [columnName, columnType] of metaAdsCreativeColumns) {
        try {
          await db.run(`ALTER TABLE meta_ads ADD COLUMN ${columnName} ${columnType}`)
        } catch (err) {
          if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
            throw err
          }
        }
      }

      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_contacts_contact ON meta_social_contacts(contact_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_contacts_sender ON meta_social_contacts(platform, sender_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_messages_contact ON meta_social_messages(contact_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_messages_contact_date ON meta_social_messages(contact_id, message_timestamp, created_at)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_messages_sender ON meta_social_messages(platform, sender_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_messages_created ON meta_social_messages(created_at)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_messages_meta_id ON meta_social_messages(meta_message_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_events_status ON meta_social_webhook_events(processed_status, created_at)')

      try {
        await db.run('ALTER TABLE meta_social_messages ADD COLUMN status TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar columnas de configuración de invoices/pagos
      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN invoice_title TEXT DEFAULT \'PAGO\'')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN invoice_number_prefix TEXT DEFAULT \'INV-\'')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN invoice_terms_notes TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN invoice_due_days INTEGER DEFAULT 7')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN transfer_info_url TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN card_setup_amount REAL DEFAULT 25')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN ghl_invoice_mode TEXT DEFAULT \'live\'')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      const paymentFlowColumns = [
        ['ghl_customer_id', 'TEXT'],
        ['ghl_payment_method_id', 'TEXT'],
        ['ghl_payment_method_type', 'TEXT'],
        ['ghl_card_brand', 'TEXT'],
        ['ghl_card_last4', 'TEXT'],
        ['ghl_card_authorization_invoice_id', 'TEXT'],
        ['ghl_payment_provider_type', 'TEXT'],
        ['ghl_payment_provider_account', 'TEXT'],
        ['ghl_payment_live_mode', 'INTEGER']
      ]

      for (const [column, type] of paymentFlowColumns) {
        try {
          await db.run(`ALTER TABLE payment_flows ADD COLUMN ${column} ${type}`)
        } catch (err) {
          if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
            throw err
          }
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_ghl_payment_method ON payment_flows(ghl_payment_method_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column') && !err.message.includes('does not exist')) {
          throw err
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_ghl_authorization_invoice ON payment_flows(ghl_card_authorization_invoice_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column') && !err.message.includes('does not exist')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE installment_payments ADD COLUMN ghl_schedule_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE installment_payments ADD COLUMN ghl_schedule_status TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE installment_payments ADD COLUMN notes TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_schedule ON installment_payments(ghl_schedule_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column') && !err.message.includes('does not exist')) {
          throw err
        }
      }

      // Crear índice para ghl_invoice_id DESPUÉS de agregar la columna
      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_payments_ghl_invoice ON payments(ghl_invoice_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column')) {
          throw err
        }
      }

      try {
        await db.run(`
          DELETE FROM payments
          WHERE (ghl_invoice_id IS NULL OR ghl_invoice_id = '')
            AND status IN ('paid', 'succeeded', 'completed')
            AND LOWER(COALESCE(description, '')) LIKE '%primer pago%'
            AND EXISTS (
              SELECT 1
              FROM payments invoice_payment
              WHERE invoice_payment.id != payments.id
                AND invoice_payment.ghl_invoice_id IS NOT NULL
                AND invoice_payment.contact_id = payments.contact_id
                AND ABS(COALESCE(invoice_payment.amount, 0) - COALESCE(payments.amount, 0)) < 0.01
                AND LOWER(COALESCE(invoice_payment.description, '')) = LOWER(COALESCE(payments.description, ''))
                AND invoice_payment.status IN ('paid', 'succeeded', 'completed')
            )
        `)
      } catch (err) {
        logger.warn('No se pudo limpiar duplicados históricos de primer pago:', err.message)
      }
    } catch (error) {
      logger.warn('Error agregando columnas opcionales:', error.message)
    }

    // Tabla de sesiones de tracking (pixel /snip.js)
    // Cada page_view = 1 registro (captura navegación completa)
    await db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id ${usePostgres ? 'UUID PRIMARY KEY DEFAULT gen_random_uuid()' : 'TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))'},
        session_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        contact_id TEXT,
        full_name TEXT,
        email TEXT,
        event_name TEXT NOT NULL DEFAULT 'page_view',
        started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

        page_url TEXT,
        referrer_url TEXT,

        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        utm_term TEXT,
        utm_content TEXT,
        gclid TEXT,
        fbclid TEXT,
        fbc TEXT,
        fbp TEXT,
        wbraid TEXT,
        gbraid TEXT,
        msclkid TEXT,
        ttclid TEXT,

        channel TEXT,
        source_platform TEXT,
        campaign_id TEXT,
        adset_id TEXT,
        ad_group_id TEXT,
        ad_id TEXT,
        campaign_name TEXT,
        adset_name TEXT,
        ad_group_name TEXT,
        ad_name TEXT,
        placement TEXT,
        site_source_name TEXT,
        network TEXT,
        match_type TEXT,
        keyword TEXT,
        search_query TEXT,
        creative_id TEXT,
        ad_position TEXT,

        ip TEXT,
        user_agent TEXT,
        device_type TEXT,
        os TEXT,
        browser TEXT,
        browser_version TEXT,
        language TEXT,
        timezone TEXT,

        geo_country TEXT,
        geo_region TEXT,
        geo_city TEXT,

        tracking_source TEXT DEFAULT 'external_pixel',
        site_id TEXT,
        site_slug TEXT,
        site_name TEXT,
        site_type TEXT,
        form_site_id TEXT,
        form_site_name TEXT,
        public_page_id TEXT,
        public_page_title TEXT,
        conversion_type TEXT,
        submission_id TEXT,

        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    for (const [columnName, columnType] of [
      ['tracking_source', "TEXT DEFAULT 'external_pixel'"],
      ['site_id', 'TEXT'],
      ['site_slug', 'TEXT'],
      ['site_name', 'TEXT'],
      ['site_type', 'TEXT'],
      ['form_site_id', 'TEXT'],
      ['form_site_name', 'TEXT'],
      ['public_page_id', 'TEXT'],
      ['public_page_title', 'TEXT'],
      ['conversion_type', 'TEXT'],
      ['submission_id', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE sessions ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          logger.warn(`Advertencia al migrar sessions.${columnName}: ${err.message}`)
        }
      }
    }

    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_visitor ON sessions(visitor_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_utm ON sessions(utm_source, utm_medium, utm_campaign)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_ids ON sessions(gclid, fbclid, msclkid, ttclid)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_campaign ON sessions(campaign_id, adset_id, ad_group_id, ad_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_geo ON sessions(geo_country, geo_region, geo_city)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_contact ON sessions(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_tracking_source ON sessions(tracking_source)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_site ON sessions(site_id, site_type)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_form_site ON sessions(form_site_id)')

    // Tabla de usuarios (para autenticación)
    await db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE,
        password_hash TEXT NOT NULL,
        full_name TEXT,
        role TEXT DEFAULT 'admin',
        is_active INTEGER DEFAULT 1,
        last_login DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS ai_agent_user_preferences (
        id ${usePostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        user_id INTEGER NOT NULL UNIQUE,
        action_customizations TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_ai_agent_user_preferences_user_id ON ai_agent_user_preferences(user_id)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL UNIQUE,
        user_id INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        domain TEXT,
        action TEXT,
        source_of_truth TEXT,
        input_summary TEXT,
        output_summary TEXT,
        view_context_json TEXT,
        route_json TEXT,
        model TEXT,
        usage_json TEXT,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS agent_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        step_type TEXT NOT NULL,
        tool_name TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        input_json TEXT,
        output_json TEXT,
        error_message TEXT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS agent_pending_actions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        domain TEXT,
        action_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        payload_json TEXT,
        confirmation_token TEXT,
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS agent_tool_idempotency (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        provider_ref TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_agent_runs_trace ON agent_runs(trace_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created ON agent_runs(user_id, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_agent_steps_run_index ON agent_steps(run_id, step_index)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_agent_steps_type ON agent_steps(step_type, tool_name)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_agent_pending_actions_run ON agent_pending_actions(run_id, status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_agent_tool_idempotency_run ON agent_tool_idempotency(run_id, tool_name)')

    const userOptionalColumns = [
      ['first_name', 'TEXT'],
      ['last_name', 'TEXT'],
      ['phone', 'TEXT'],
      ['business_name', 'TEXT'],
      ['api_token_hash', 'TEXT'],
      ['api_token_prefix', 'TEXT'],
      ['api_token_last_four', 'TEXT'],
      ['api_token_created_at', 'DATETIME'],
      ['api_token_last_used_at', 'DATETIME'],
      ['api_token_revoked_at', 'DATETIME']
    ]

    for (const [columnName, columnType] of userOptionalColumns) {
      try {
        if (usePostgres) {
          await db.run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${columnName} ${columnType}`)
        } else {
          await db.run(`ALTER TABLE users ADD COLUMN ${columnName} ${columnType}`)
        }
      } catch (err) {
        // Ignore if the column already exists.
      }
    }

    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_token_hash ON users(api_token_hash)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT,
        redirect_uris TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT,
        resource TEXT,
        expires_at DATETIME NOT NULL,
        used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        scope TEXT,
        resource TEXT,
        expires_at DATETIME NOT NULL,
        revoked_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_authorization_codes(client_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh_tokens(user_id)')

    // Tabla para filtros de contactos ocultos
    await db.run(`
      CREATE TABLE IF NOT EXISTS hidden_contact_filters (
        id ${usePostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        filter_text VARCHAR(255) NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_hidden_filters_text ON hidden_contact_filters(filter_text)')

    // Migración: Agregar columna match_type a hidden_contact_filters
    try {
      if (usePostgres) {
        await db.run(`
          ALTER TABLE hidden_contact_filters
          ADD COLUMN IF NOT EXISTS match_type VARCHAR(20) DEFAULT 'contains'
        `)
      } else {
        // SQLite no soporta IF NOT EXISTS en ALTER TABLE, intentar y capturar error
        await db.run(`
          ALTER TABLE hidden_contact_filters
          ADD COLUMN match_type VARCHAR(20) DEFAULT 'contains'
        `)
      }
      logger.success('✅ Migración: Columna match_type agregada a hidden_contact_filters')
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        logger.warn('Advertencia al agregar match_type a hidden_contact_filters:', err.message)
      }
    }

    // MIGRACIONES PARA POSTGRESQL
    if (usePostgres) {
      // Migración 1: Agregar columna contact_id a appointments si no existe
      try {
        await db.run('ALTER TABLE appointments ADD COLUMN contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE')
        logger.success('✅ Migración: Columna contact_id agregada a appointments')
      } catch (err) {
        if (err.code !== '42701' && !err.message.includes('already exists')) {
          logger.warn('Advertencia al agregar contact_id a appointments:', err.message)
        }
      }

      // Crear índice para contact_id en appointments
      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_contact ON appointments(contact_id)')
      } catch (err) {
        // Ignorar si ya existe
      }
    }

    // Tabla de costos (impuestos, comisiones, gastos fijos, etc.)
    await db.run(`
      CREATE TABLE IF NOT EXISTS costs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        calculation_type TEXT NOT NULL,
        value REAL NOT NULL,
        applies_to TEXT,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_costs_type ON costs(type)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_costs_active ON costs(is_active)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS report_manual_business_expenses (
        period_type TEXT NOT NULL,
        period_start TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (period_type, period_start)
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_report_manual_business_expenses_period ON report_manual_business_expenses(period_type, period_start)')

    try {
      await cleanupWhatsAppApiSystemCustomFields()
    } catch (err) {
      logger.warn('Advertencia al limpiar campos internos de WhatsApp API:', err.message)
    }

    try {
      await reconcileCanonicalContactPhones()
    } catch (err) {
      logger.warn('Advertencia al reconciliar teléfonos de contactos:', err.message)
    }

    logger.success('Todas las tablas inicializadas correctamente')
  } catch (error) {
    logger.error('Error inicializando tablas:', error)
    throw error
  }
}

// Inicializar al importar
await initTables()

/**
 * Obtiene la configuración de HighLevel desde la base de datos
 */
export async function getHighLevelConfig() {
  return await db.get('SELECT * FROM highlevel_config LIMIT 1')
}

/**
 * Obtiene un valor de configuración global de la app
 */
export async function getAppConfig(key) {
  const row = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', [key])
  return row ? row.config_value : null
}

/**
 * Guarda un valor de configuración global de la app
 */
export async function setAppConfig(key, value) {
  const normalizedValue = value === null || value === undefined
    ? null
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)

  await db.run(`
    INSERT INTO app_config (config_key, config_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO UPDATE SET
      config_value = excluded.config_value,
      updated_at = CURRENT_TIMESTAMP
  `, [key, normalizedValue])
}

export { db }
