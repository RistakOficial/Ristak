import { writeFileSync } from 'fs';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: 'postgresql://ristak_production_lrx7_user:2u01O2msGhIld5hiUOwMxrFg3tRSnVMG@dpg-d3orenemcj7s739hdg90-a.oregon-postgres.render.com/ristak_production_lrx7',
  ssl: {
    rejectUnauthorized: false
  }
});

const OUTPUT_FILE = 'diagnose-sessions-report.json';

async function diagnose() {
  const report = {
    startedAt: new Date().toISOString(),
    status: 'pending'
  };

  try {
    // 1. Verificar si la tabla existe
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'sessions'
      );
    `);
    report.tableExists = Boolean(tableCheck.rows[0].exists);

    // 2. Contar registros totales
    const count = await pool.query('SELECT COUNT(*) as total FROM sessions');
    report.totalSessions = Number(count.rows[0].total || 0);

    // 3. Ver estructura de la tabla
    const structure = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'sessions'
      ORDER BY ordinal_position;
    `);
    report.tableStructure = structure.rows.map(col => ({
      column: col.column_name,
      type: col.data_type
    }));

    // 4. Verificar si existe sessions_backup_2025
    const backupCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'sessions_backup_2025'
      );
    `);
    report.backup = {
      exists: Boolean(backupCheck.rows[0].exists)
    };

    if (report.backup.exists) {
      const backupCount = await pool.query('SELECT COUNT(*) as total FROM sessions_backup_2025');
      report.backup.total = Number(backupCount.rows[0].total || 0);
    }

    // 5. Ver registros recientes (últimos 5)
    if (report.totalSessions > 0) {
      const recent = await pool.query(`
        SELECT id, session_id, visitor_id, started_at, page_url
        FROM sessions
        ORDER BY started_at DESC
        LIMIT 5
      `);
      report.recentSessions = recent.rows.map(row => ({
        id: row.id,
        sessionId: row.session_id,
        visitorId: row.visitor_id,
        startedAt: row.started_at,
        pageUrl: row.page_url
      }));
    } else {
      report.recentSessions = [];
    }

    // 6. Contar por fecha (últimos 7 días)
    const byDate = await pool.query(`
      SELECT DATE(started_at) as date, COUNT(*) as count
      FROM sessions
      WHERE started_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(started_at)
      ORDER BY date DESC
      LIMIT 7
    `);
    report.countsByDate = byDate.rows.map(row => ({
      date: row.date,
      count: Number(row.count || 0)
    }));

    report.status = 'ok';
  } catch (error) {
    report.status = 'error';
    report.error = error instanceof Error ? error.message : String(error);
    writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
    await pool.end();
    process.exit(1);
  }

  await pool.end();
  writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
}

diagnose();
