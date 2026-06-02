import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { logger } from '../utils/logger.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DATABASE_URL = process.env.DATABASE_URL
const usePostgres = !!DATABASE_URL

let db

if (usePostgres) {
  // PostgreSQL (Producción en Render)
  logger.info('Usando PostgreSQL')

  const pg = await import('pg')
  const pool = new pg.default.Pool({
    connectionString: DATABASE_URL,
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
  { table: 'whatsapp_web_contacts', column: 'contact_id' },
  { table: 'whatsapp_web_messages', column: 'contact_id' },
  { table: 'whatsapp_web_attribution', column: 'contact_id' },
  { table: 'payment_flows', column: 'contact_id' },
  { table: 'sessions', column: 'contact_id' }
]

function getContactPhoneScore(contact = {}, canonicalPhone = '') {
  let score = 0
  const id = String(contact.id || '')
  const source = String(contact.source || '').toLowerCase()

  if (!id.startsWith('waweb_contact_')) score += 1000
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
    ['whatsapp_web_contacts', 'phone'],
    ['whatsapp_web_messages', 'phone'],
    ['whatsapp_web_attribution', 'phone'],
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
    SELECT id, phone, full_name, first_name, last_name, source, visitor_id,
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

      await db.run('UPDATE contacts SET phone = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [loser.id])
      await updateContactReferences(loser.id, winner.id)
      await db.run('DELETE FROM contacts WHERE id = ?', [loser.id])
      changed += 1
    }

    await db.run(`
      UPDATE contacts SET
        phone = ?,
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
        custom_fields ${usePostgres ? "JSONB DEFAULT '[]'::jsonb" : "TEXT DEFAULT '[]'"},
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Índices para contacts
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_ad_id ON contacts(attribution_ad_id)')
    try {
      await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_meta_schedule_sent ON contacts(meta_schedule_event_sent)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_meta_purchase_sent ON contacts(meta_purchase_event_sent)')
    } catch (err) {
      if (!err.message.includes('no such column') && !err.message.includes('does not exist')) {
        throw err
      }
    }

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
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_contact ON appointments(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_start_time ON appointments(start_time)')

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

    // Tabla de configuración de Meta
    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ad_account_id TEXT UNIQUE,
        access_token TEXT NOT NULL,
        app_id TEXT,
        app_secret TEXT,
        token_expires_at DATETIME,
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

    // Tablas de WhatsApp Web / Baileys. Separadas de WhatsApp API oficial y de la
    // atribucion actual para no mezclar fuentes ni modelos de integracion.
    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_web_sessions (
        id TEXT PRIMARY KEY,
        label TEXT,
        status TEXT DEFAULT 'disconnected',
        phone TEXT,
        jid TEXT,
        push_name TEXT,
        profile_picture_url TEXT,
        business_profile_json TEXT,
        account_info_json TEXT,
        qr_code TEXT,
        qr_image TEXT,
        last_error TEXT,
        connected_at DATETIME,
        disconnected_at DATETIME,
        last_qr_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    for (const [columnName, columnType] of [
      ['profile_picture_url', 'TEXT'],
      ['business_profile_json', 'TEXT'],
      ['account_info_json', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE whatsapp_web_sessions ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_web_auth_state (
        session_id TEXT NOT NULL,
        auth_key TEXT NOT NULL,
        value_json TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id, auth_key),
        FOREIGN KEY (session_id) REFERENCES whatsapp_web_sessions(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_web_contacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        contact_id TEXT,
        remote_jid TEXT,
        phone TEXT,
        push_name TEXT,
        display_name TEXT,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        message_count INTEGER DEFAULT 0,
        raw_profile_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, remote_jid),
        FOREIGN KEY (session_id) REFERENCES whatsapp_web_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_web_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        whatsapp_web_contact_id TEXT,
        contact_id TEXT,
        remote_jid TEXT,
        phone TEXT,
        message_id TEXT,
        direction TEXT,
        message_type TEXT,
        message_text TEXT,
        push_name TEXT,
        message_timestamp DATETIME,
        raw_payload_json TEXT,
        context_info_json TEXT,
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
        FOREIGN KEY (session_id) REFERENCES whatsapp_web_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (whatsapp_web_contact_id) REFERENCES whatsapp_web_contacts(id) ON DELETE SET NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_web_attribution (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        whatsapp_web_message_id TEXT,
        whatsapp_web_contact_id TEXT,
        contact_id TEXT,
        remote_jid TEXT,
        phone TEXT,
        message_id TEXT,
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
        external_ad_reply_json TEXT,
        context_info_json TEXT,
        raw_payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES whatsapp_web_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (whatsapp_web_message_id) REFERENCES whatsapp_web_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (whatsapp_web_contact_id) REFERENCES whatsapp_web_contacts(id) ON DELETE SET NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    for (const [tableName, columnName, columnType] of [
      ['whatsapp_web_messages', 'detected_headline', 'TEXT'],
      ['whatsapp_web_messages', 'detected_body', 'TEXT'],
      ['whatsapp_web_attribution', 'detected_headline', 'TEXT'],
      ['whatsapp_web_attribution', 'detected_body', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_web_sessions_status ON whatsapp_web_sessions(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_web_contacts_phone ON whatsapp_web_contacts(phone)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_web_contacts_contact ON whatsapp_web_contacts(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_web_messages_contact ON whatsapp_web_messages(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_web_messages_remote ON whatsapp_web_messages(remote_jid)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_web_messages_created ON whatsapp_web_messages(created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_web_attr_contact ON whatsapp_web_attribution(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_web_attr_ctwa ON whatsapp_web_attribution(detected_ctwa_clid)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_web_attr_source ON whatsapp_web_attribution(detected_source_id)')

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
                page_id TEXT
              );
              INSERT INTO meta_config_shared_token_migration (
                id, ad_account_id, access_token, app_id, app_secret, token_expires_at,
                created_at, updated_at, timezone_id, timezone_name, timezone_offset_hours_utc,
                pixel_id, pixel_api_token, page_id
              )
              SELECT
                id, ad_account_id, access_token, app_id, app_secret, token_expires_at,
                created_at, updated_at, timezone_id, timezone_name, timezone_offset_hours_utc,
                pixel_id, pixel_api_token, page_id
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

        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_visitor ON sessions(visitor_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_utm ON sessions(utm_source, utm_medium, utm_campaign)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_ids ON sessions(gclid, fbclid, msclkid, ttclid)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_campaign ON sessions(campaign_id, adset_id, ad_group_id, ad_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_geo ON sessions(geo_country, geo_region, geo_city)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_contact ON sessions(contact_id)')

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

    const userApiTokenColumns = [
      ['api_token_hash', 'TEXT'],
      ['api_token_prefix', 'TEXT'],
      ['api_token_last_four', 'TEXT'],
      ['api_token_created_at', 'DATETIME'],
      ['api_token_last_used_at', 'DATETIME'],
      ['api_token_revoked_at', 'DATETIME']
    ]

    for (const [columnName, columnType] of userApiTokenColumns) {
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
