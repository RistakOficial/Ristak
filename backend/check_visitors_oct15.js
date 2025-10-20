import pg from 'pg';
const { Client } = pg;

const client = new Client({
  host: 'dpg-d3orenemcj7s739hdg90-a.oregon-postgres.render.com',
  port: 5432,
  database: 'ristak_production_lrx7',
  user: 'ristak_production_lrx7_user',
  password: '2u01O2msGhIld5hiUOwMxrFg3tRSnVMG',
  ssl: { rejectUnauthorized: false }
});

async function checkVisitorsOct15() {
  try {
    await client.connect();
    console.log('✅ Conectado a la base de datos\n');

    // 1. Verificar visitantes del 15 de octubre en sessions
    console.log('🔍 VERIFICANDO VISITANTES EN SESSIONS (15 oct 2025):\n');
    const visitorsResult = await client.query(`
      SELECT
        TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
        COUNT(DISTINCT visitor_id) as visitors
      FROM sessions
      WHERE ad_id IS NOT NULL
        AND ad_id != ''
        AND created_at::date = '2025-10-15'::date
      GROUP BY day
      ORDER BY day
    `);
    console.log('Resultado visitantes:', visitorsResult.rows);

    // 2. Verificar leads del 15 de octubre en contacts
    console.log('\n🔍 VERIFICANDO LEADS EN CONTACTS (15 oct 2025):\n');
    const leadsResult = await client.query(`
      SELECT
        TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
        COUNT(DISTINCT id) as leads
      FROM contacts
      WHERE attribution_ad_id IS NOT NULL
        AND attribution_ad_id != ''
        AND created_at::date = '2025-10-15'::date
      GROUP BY day
      ORDER BY day
    `);
    console.log('Resultado leads:', leadsResult.rows);

    // 3. Verificar todas las sesiones del 15 de octubre (con o sin ad_id)
    console.log('\n🔍 TODAS LAS SESIONES DEL 15 DE OCTUBRE (con o sin ad_id):\n');
    const allSessionsResult = await client.query(`
      SELECT COUNT(*) as total_sessions,
             COUNT(DISTINCT visitor_id) as unique_visitors,
             COUNT(CASE WHEN ad_id IS NOT NULL AND ad_id != '' THEN 1 END) as sessions_with_ad
      FROM sessions
      WHERE created_at::date = '2025-10-15'::date
    `);
    console.log('Todas las sesiones:', allSessionsResult.rows);

    // 4. Ver rango completo de octubre 2025
    console.log('\n📊 RESUMEN TODO OCTUBRE 2025:\n');
    const summaryResult = await client.query(`
      SELECT
        TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
        COUNT(DISTINCT visitor_id) as visitors,
        COUNT(*) as total_sessions
      FROM sessions
      WHERE ad_id IS NOT NULL
        AND ad_id != ''
        AND created_at::date >= '2025-10-01'::date
        AND created_at::date < '2025-11-01'::date
      GROUP BY day
      ORDER BY day
    `);
    console.log('Visitantes por día (sessions con ad_id):');
    console.table(summaryResult.rows);

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await client.end();
    console.log('\n🔌 Conexión cerrada');
  }
}

checkVisitorsOct15();
