import fetch from 'node-fetch';
import { db } from './backend/src/config/database.js';

async function testInvoiceDescription() {
  const apiToken = 'pit-770e1e5f-6ce1-4736-84e2-e635883409b4';
  const locationId = 'cAEl3p2eZROgv2GFvMZM';

  console.log('🔵 Obteniendo invoices de GHL...');

  // Obtener 3 invoices para ver la estructura exacta
  const url = `https://services.leadconnectorhq.com/invoices/?altId=${locationId}&altType=location&limit=3&offset=0`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    },
  });

  const data = await response.json();
  const invoices = data.invoices || [];

  console.log(`✅ Obtenidos ${invoices.length} invoices\n`);

  for (let i = 0; i < invoices.length; i++) {
    const invoice = invoices[i];
    console.log(`=== INVOICE ${i + 1} ===`);
    console.log('ID:', invoice._id);
    console.log('Status:', invoice.status);
    console.log('invoice.title:', invoice.title);
    console.log('invoice.name:', invoice.name);
    console.log('invoice.invoiceItems existe?:', !!invoice.invoiceItems);
    console.log('invoice.invoiceItems es array?:', Array.isArray(invoice.invoiceItems));
    console.log('invoice.invoiceItems.length:', invoice.invoiceItems?.length);

    if (invoice.invoiceItems && invoice.invoiceItems.length > 0) {
      console.log('--- Items del invoice ---');
      invoice.invoiceItems.forEach((item, idx) => {
        console.log(`  Item ${idx + 1}:`);
        console.log(`    name: "${item.name}"`);
        console.log(`    description: "${item.description}"`);
        console.log(`    amount: ${item.amount}`);
      });
    }

    console.log('\n🎯 DESCRIPCIÓN QUE SE GUARDARÍA:');
    const description = invoice.invoiceItems?.[0]?.name ||
                        invoice.invoiceItems?.[0]?.description ||
                        invoice.title ||
                        invoice.name ||
                        'Pago';
    console.log(`  → "${description}"`);
    console.log('');
  }

  // Ahora ver qué hay en la DB
  console.log('=== VERIFICANDO BASE DE DATOS ===');
  const payments = await db.all(
    'SELECT id, ghl_invoice_id, description, status FROM payments LIMIT 5'
  );

  console.log(`Primeros 5 pagos en DB:`);
  payments.forEach(p => {
    console.log(`- ID: ${p.id.substring(0, 8)}... | Desc: "${p.description}" | Status: ${p.status}`);
  });
}

testInvoiceDescription().catch(console.error);