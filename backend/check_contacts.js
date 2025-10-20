import pg from 'pg';
const { Client } = pg;

const connectionString = 'postgresql://ristak_production_lrx7_user:2u01O2msGhIld5hiUOwMxrFg3tRSnVMG@dpg-d3orenemcj7s739hdg90-a.oregon-postgres.render.com/ristak_production_lrx7';

const client = new Client({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 10000,
});

async function checkData() {
  try {
    console.log('🔄 Conectando a la DB...\n');
    await client.connect();
    console.log('✅ Conectado a la DB\n');

    // Ver rango de fechas de contactos
    const rangeQuery = `
      SELECT
        MIN(created_at) as primera_fecha,
        MAX(created_at) as ultima_fecha,
        COUNT(*) as total_contactos
      FROM contacts
    `;
    const rangeResult = await client.query(rangeQuery);
    console.log('📅 Rango de fechas en tabla contacts:');
    console.log(rangeResult.rows[0]);
    console.log('\n');

    // Ver contactos del 15 de octubre
    const oct15Query = `
      SELECT
        id,
        name,
        email,
        phone,
        created_at,
        attribution_ad_id
      FROM contacts
      WHERE created_at::date = '2025-10-15'
      ORDER BY created_at
    `;
    const oct15Result = await client.query(oct15Query);
    console.log('📋 Contactos creados el 15 de octubre 2025:');
    console.log(`Total: ${oct15Result.rows.length} contactos`);
    if (oct15Result.rows.length > 0) {
      oct15Result.rows.forEach(row => {
        const name = row.name || 'Sin nombre';
        const contact = row.email || row.phone;
        const adId = row.attribution_ad_id || 'N/A';
        console.log(`  - ${name} (${contact}) - ${row.created_at} - Ad ID: ${adId}`);
      });
    } else {
      console.log('  ❌ No hay contactos del 15 de octubre en la DB');
    }
    console.log('\n');

    // Ver si hay datos en tabla sessions del 15 de octubre
    const sessionsQuery = `
      SELECT COUNT(*) as total_sesiones
      FROM sessions
      WHERE created_at::date = '2025-10-15'
    `;
    const sessionsResult = await client.query(sessionsQuery);
    console.log('🔍 Sesiones en tracking del 15 de octubre:');
    console.log(sessionsResult.rows[0]);
    console.log('\n');

    // Ver contactos por día en octubre
    const octoberQuery = `
      SELECT
        created_at::date as fecha,
        COUNT(*) as contactos
      FROM contacts
      WHERE created_at >= '2025-10-01' AND created_at < '2025-11-01'
      GROUP BY created_at::date
      ORDER BY fecha
    `;
    const octoberResult = await client.query(octoberQuery);
    console.log('📊 Contactos por día en octubre 2025:');
    if (octoberResult.rows.length > 0) {
      octoberResult.rows.forEach(row => {
        console.log(`  ${row.fecha}: ${row.contactos} contactos`);
      });
    } else {
      console.log('  ❌ No hay contactos en octubre 2025');
    }
    console.log('\n');

    // Ver visitantes del 15 de octubre por ad_id
    const visitorsQuery = `
      SELECT
        ad_id,
        ad_name,
        COUNT(DISTINCT visitor_id) as visitantes_unicos
      FROM sessions
      WHERE created_at::date = '2025-10-15'
        AND ad_id IS NOT NULL
      GROUP BY ad_id, ad_name
      ORDER BY visitantes_unicos DESC
    `;
    const visitorsResult = await client.query(visitorsQuery);
    console.log('👥 Visitantes únicos del 15 oct por anuncio (sessions):');
    console.log(`Total ads con visitantes: ${visitorsResult.rows.length}`);
    if (visitorsResult.rows.length > 0) {
      visitorsResult.rows.slice(0, 10).forEach(row => {
        console.log(`  Ad ${row.ad_id} (${row.ad_name || 'Sin nombre'}): ${row.visitantes_unicos} visitantes`);
      });
    } else {
      console.log('  ❌ No hay visitantes del 15 de octubre en sessions');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
  } finally {
    await client.end();
    console.log('\n🔌 Conexión cerrada');
  }
}

checkData();
