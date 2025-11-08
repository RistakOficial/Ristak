import pg from 'pg';
const { Client } = pg;

const DATABASE_URL = "postgresql://ristak_production_lrx7_user:2u01O2msGhIld5hiUOwMxrFg3tRSnVMG@dpg-d3orenemcj7s739hdg90-a.oregon-postgres.render.com/ristak_production_lrx7";

async function checkPayments() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('✅ Conectado a la base de datos de producción');

    // Ver 10 pagos recientes con todos los campos
    const result = await client.query(`
      SELECT
        id,
        description,
        reference,
        status,
        amount,
        ghl_invoice_id,
        created_at
      FROM payments
      ORDER BY created_at DESC
      LIMIT 10
    `);

    console.log('\n=== ÚLTIMOS 10 PAGOS EN LA DB ===\n');
    result.rows.forEach((row, i) => {
      console.log(`Pago ${i + 1}:`);
      console.log(`  ID: ${row.id?.substring(0, 10)}...`);
      console.log(`  Descripción: "${row.description || 'VACÍO'}"`);
      console.log(`  Reference: ${row.reference || 'null'}`);
      console.log(`  Status: ${row.status}`);
      console.log(`  Amount: ${row.amount}`);
      console.log(`  GHL Invoice ID: ${row.ghl_invoice_id?.substring(0, 10)}...`);
      console.log(`  Creado: ${row.created_at}`);
      console.log('');
    });

    // Contar cuántos tienen descripción vacía
    const emptyResult = await client.query(`
      SELECT COUNT(*) as empty_count
      FROM payments
      WHERE description IS NULL OR description = '' OR description = 'Pago' OR description = 'PAGO'
    `);

    const totalResult = await client.query('SELECT COUNT(*) as total FROM payments');

    console.log('=== ESTADÍSTICAS ===');
    console.log(`Total de pagos: ${totalResult.rows[0].total}`);
    console.log(`Pagos sin descripción real: ${emptyResult.rows[0].empty_count}`);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

checkPayments();