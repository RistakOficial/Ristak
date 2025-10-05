import 'dotenv/config'
import { db } from './src/config/database.js'

async function checkData() {
  try {
    // Contar contactos
    const contacts = await db.get('SELECT COUNT(*) as total FROM contacts')
    console.log(`📋 Contactos: ${contacts.total}`)

    // Contar pagos
    const payments = await db.get('SELECT COUNT(*) as total FROM payments')
    console.log(`💳 Pagos: ${payments.total}`)

    // Contar citas
    const appointments = await db.get('SELECT COUNT(*) as total FROM appointments')
    console.log(`📅 Citas: ${appointments.total}`)

    // Contar ads de Meta
    const metaAds = await db.get('SELECT COUNT(*) as total FROM meta_ads')
    console.log(`📊 Meta Ads: ${metaAds.total}`)

    // Ver algunos contactos
    const someContacts = await db.all('SELECT id, full_name, email FROM contacts LIMIT 5')
    console.log('\n📌 Primeros 5 contactos:')
    someContacts.forEach(c => {
      console.log(`  - ${c.full_name || 'Sin nombre'} (${c.email || 'Sin email'})`)
    })

    // Ver algunos pagos
    const somePayments = await db.all('SELECT id, amount, status, date FROM payments LIMIT 5')
    console.log('\n💰 Primeros 5 pagos:')
    somePayments.forEach(p => {
      console.log(`  - $${p.amount} - ${p.status} - ${p.date}`)
    })

    process.exit(0)
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  }
}

checkData()