import { db } from './src/config/database.js'

async function checkDates() {
  const result = await db.get(`
    SELECT
      MIN(created_at) as earliest,
      MAX(created_at) as latest,
      COUNT(*) as total
    FROM contacts
  `)
  console.log('Contact creation dates:')
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

checkDates().catch(console.error)
