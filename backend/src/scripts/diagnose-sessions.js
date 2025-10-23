import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: 'postgresql://ristak_production_lrx7_user:2u01O2msGhIld5hiUOwMxrFg3tRSnVMG@dpg-d3orenemcj7s739hdg90-a.oregon-postgres.render.com/ristak_production_lrx7',
  ssl: {
    rejectUnauthorized: false
  }
});

async function diagnose() {
  try {
    console.log('🔍 Conectando a la base de datos...\n');

    // 1. Verificar si la tabla existe
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'sessions'
      );
    `);
    console.log('✅ Tabla sessions existe:', tableCheck.rows[0].exists);

    // 2. Contar registros totales
    const count = await pool.query('SELECT COUNT(*) as total FROM sessions');
    console.log('📊 Total de registros en sessions:', count.rows[0].total);

    // 3. Ver estructura de la tabla
    const structure = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'sessions'
      ORDER BY ordinal_position;
    `);
    console.log('\n📋 Estructura de la tabla sessions:');
    structure.rows.forEach(col => {
      console.log(`   - ${col.column_name}: ${col.data_type}`);
    });

    // 4. Verificar si existe sessions_backup_2025
    const backupCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'sessions_backup_2025'
      );
    `);
    console.log('\n🔍 Tabla sessions_backup_2025 existe:', backupCheck.rows[0].exists);

    if (backupCheck.rows[0].exists) {
      const backupCount = await pool.query('SELECT COUNT(*) as total FROM sessions_backup_2025');
      console.log('📦 Registros en backup:', backupCount.rows[0].total);
    }

    // 5. Ver registros recientes (últimos 5)
    if (parseInt(count.rows[0].total) > 0) {
      const recent = await pool.query(`
        SELECT id, session_id, visitor_id, started_at, page_url
        FROM sessions
        ORDER BY started_at DESC
        LIMIT 5
      `);
      console.log('\n📝 Últimos 5 registros:');
      recent.rows.forEach(row => {
        console.log(`   - ${row.started_at}: ${row.page_url} (visitor: ${row.visitor_id.substring(0, 8)}...)`);
      });
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
    console.log('\n📅 Registros por día (últimos 7 días):');
    if (byDate.rows.length > 0) {
      byDate.rows.forEach(row => {
        console.log(`   - ${row.date}: ${row.count} registros`);
      });
    } else {
      console.log('   (Sin datos en los últimos 7 días)');
    }

    await pool.end();
    console.log('\n✅ Diagnóstico completado');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

diagnose();
