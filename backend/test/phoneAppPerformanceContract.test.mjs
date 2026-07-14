import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')

test('la superficie móvil carga únicamente la sección visible y acota sus listas', async () => {
  const source = await readFile(join(repoRoot, 'frontend/src/pages/PhoneApp/PhoneApp.tsx'), 'utf8')
  const loadStart = source.indexOf('const loadPhoneData = async () =>')
  const loadEnd = source.indexOf('const dashboardTiles = useMemo', loadStart)
  const loader = source.slice(loadStart, loadEnd)

  assert.ok(loadStart >= 0 && loadEnd > loadStart)
  assert.match(loader, /data-\$\{activeSectionId\}-\$\{featureAccessKey\}/)
  assert.match(loader, /const loadDashboard = activeSectionId === 'dashboard'/)
  assert.match(loader, /const loadTransactions = activeSectionId === 'transactions'/)
  assert.match(loader, /const loadContacts = activeSectionId === 'contacts'/)
  assert.match(loader, /const loadAnalytics = activeSectionId === 'analytics'/)

  assert.doesNotMatch(loader, /transactionsService\.getTransactions\(/)
  assert.match(loader, /transactionsService\.getTransactionsPage\(\{[\s\S]*?limit: 5/)
  assert.doesNotMatch(loader, /reportsService\.getContactsList\(/)
  assert.match(loader, /contactsService\.getContactsPage\(\{[\s\S]*?limit: 5/)

  assert.match(loader, /loadDashboard && canUseDashboard/)
  assert.match(loader, /\(loadAppointments \|\| loadAnalytics\) && canUseAppointments/)
  assert.match(loader, /loadCampaigns && canUseCampaigns/)
  assert.match(loader, /loadReports && canUseReports/)
})

test('el detalle móvil de pagos recientes usa página acotada y no descarga el rango completo', async () => {
  const source = await readFile(join(repoRoot, 'frontend/src/pages/PhonePayments/PhonePayments.tsx'), 'utf8')
  const loadStart = source.indexOf('const loadRecentPayments = async () =>')
  const loadEnd = source.indexOf('loadRecentPayments()', loadStart)
  const loader = source.slice(loadStart, loadEnd)

  assert.ok(loadStart >= 0 && loadEnd > loadStart)
  assert.doesNotMatch(loader, /transactionsService\.getTransactions\(/)
  assert.match(loader, /transactionsService\.getTransactionsPage\(\{[\s\S]*?limit: 80/)
  assert.match(loader, /statuses: \['paid', 'partial'\]/)
})
