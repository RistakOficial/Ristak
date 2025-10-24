import pg from 'pg';
const { Client } = pg;

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkVisitorIds() {
  try {
    await client.connect();

    console.log('\n🔍 ANÁLISIS DE VISITOR_IDS EN SESSIONS:\n');

    // 1. Total de registros
    const totalResult = await client.query('SELECT COUNT(*) as total FROM sessions');
    console.log(`📊 Total de registros en sessions: ${totalResult.rows[0].total}`);

    // 2. Visitor_ids únicos
    const uniqueResult = await client.query('SELECT COUNT(DISTINCT visitor_id) as unique_visitors FROM sessions');
    console.log(`👤 Visitantes únicos (DISTINCT visitor_id): ${uniqueResult.rows[0].unique_visitors}`);

    // 3. Visitor_ids NULL
    const nullResult = await client.query('SELECT COUNT(*) as nulls FROM sessions WHERE visitor_id IS NULL');
    console.log(`❌ Sesiones con visitor_id NULL: ${nullResult.rows[0].nulls}`);

    // 4. Sesiones por visitor_id (top 10)
    console.log('\n📋 Top 10 visitantes con más sesiones:');
    const topVisitors = await client.query(`
      SELECT
        visitor_id,
        COUNT(*) as sessions_count
      FROM sessions
      WHERE visitor_id IS NOT NULL
      GROUP BY visitor_id
      ORDER BY sessions_count DESC
      LIMIT 10
    `);
    topVisitors.rows.forEach((row, i) => {
      console.log(`  ${i + 1}. ${row.visitor_id.substring(0, 24)}... → ${row.sessions_count} sesiones`);
    });

    // 5. Fuentes de tráfico con COUNT(*)
    console.log('\n📊 MÉTODO VIEJO - COUNT(*) por fuente normalizada:');
    const oldMethod = await client.query(`
      WITH normalized_sources AS (
        SELECT
          CASE
            WHEN referrer_url ~* 'facebook|fb\\.' THEN 'Facebook'
            WHEN referrer_url ~* 'instagram' THEN 'Instagram'
            WHEN site_source_name ~* 'facebook|fb|meta' THEN 'Facebook'
            WHEN site_source_name ~* 'instagram|ig' THEN 'Instagram'
            WHEN utm_source ~* 'facebook|fb|meta' THEN 'Facebook'
            WHEN utm_source ~* 'instagram|ig' THEN 'Instagram'
            ELSE 'Otro'
          END as source
        FROM sessions
      )
      SELECT source, COUNT(*) as count
      FROM normalized_sources
      GROUP BY source
      ORDER BY count DESC
    `);
    oldMethod.rows.forEach(row => {
      console.log(`  ${row.source}: ${row.count}`);
    });

    // 6. Fuentes de tráfico con COUNT(DISTINCT visitor_id)
    console.log('\n✅ MÉTODO NUEVO - COUNT(DISTINCT visitor_id) por fuente:');
    const newMethod = await client.query(`
      WITH normalized_sources AS (
        SELECT
          visitor_id,
          CASE
            WHEN referrer_url ~* 'facebook|fb\\.' THEN 'Facebook'
            WHEN referrer_url ~* 'instagram' THEN 'Instagram'
            WHEN site_source_name ~* 'facebook|fb|meta' THEN 'Facebook'
            WHEN site_source_name ~* 'instagram|ig' THEN 'Instagram'
            WHEN utm_source ~* 'facebook|fb|meta' THEN 'Facebook'
            WHEN utm_source ~* 'instagram|ig' THEN 'Instagram'
            ELSE 'Otro'
          END as source
        FROM sessions
      )
      SELECT source, COUNT(DISTINCT visitor_id) as count
      FROM normalized_sources
      GROUP BY source
      ORDER BY count DESC
    `);
    newMethod.rows.forEach(row => {
      console.log(`  ${row.source}: ${row.count}`);
    });

    await client.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    await client.end();
    process.exit(1);
  }
}

checkVisitorIds();
