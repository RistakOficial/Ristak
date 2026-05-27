import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { logger } from '../utils/logger.js'

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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Índices para contacts
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_ad_id ON contacts(attribution_ad_id)')

    // Tabla de pagos
    await db.run(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        amount REAL,
        currency TEXT DEFAULT 'MXN',
        status TEXT,
        payment_method TEXT,
        reference TEXT,
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

    // Tabla de configuración de Meta
    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ad_account_id TEXT UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        app_id TEXT,
        app_secret TEXT,
        token_expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

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

    // Tabla de versiones de Meta API (para auto-actualización)
    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_api_version (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Tabla de métodos de pago (tarjetas guardadas en Stripe)
    await db.run(`
      CREATE TABLE IF NOT EXISTS payment_methods (
        id TEXT PRIMARY KEY,
        location_id TEXT,
        contact_id TEXT,
        contact_name TEXT,
        contact_email TEXT,
        stripe_customer_id TEXT,
        stripe_payment_method_id TEXT UNIQUE,
        brand TEXT,
        last4 TEXT,
        exp_month INTEGER,
        exp_year INTEGER,
        is_default INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        last_used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_methods_contact ON payment_methods(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_methods_stripe_customer ON payment_methods(stripe_customer_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_methods_location ON payment_methods(location_id)')

    // Agregar columnas que puedan faltar en tablas existentes
    try {
      // Agregar ghl_invoice_id a payments (UNIQUE para evitar duplicados)
      try {
        await db.run('ALTER TABLE payments ADD COLUMN ghl_invoice_id TEXT UNIQUE')
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

      // Agregar columnas de Stripe a highlevel_config
      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN stripe_test_secret_key_encrypted TEXT')
      } catch (err) {
        // SQLite: "duplicate column name"
        // PostgreSQL: "column \"stripe_test_secret_key_encrypted\" of relation \"highlevel_config\" already exists"
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN stripe_live_secret_key_encrypted TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN stripe_mode TEXT DEFAULT \'test\'')
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

      // Crear índice para ghl_invoice_id DESPUÉS de agregar la columna
      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_payments_ghl_invoice ON payments(ghl_invoice_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column')) {
          throw err
        }
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
  await db.run(`
    INSERT INTO app_config (config_key, config_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO UPDATE SET
      config_value = excluded.config_value,
      updated_at = CURRENT_TIMESTAMP
  `, [key, value])
}

export { db }
