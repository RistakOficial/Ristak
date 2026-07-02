import test, { after } from 'node:test'
import assert from 'node:assert/strict'

// Fuerza SQLite (sin DATABASE_URL) para que el test sea autocontenido.
delete process.env.DATABASE_URL

const [{ db }, mediaStorageService] = await Promise.all([
  import('../src/config/database.js'),
  import('../src/services/mediaStorageService.js')
])
const { resolveAccountSlug, resetAccountSlugCache } = mediaStorageService

async function clearPersistedSlug() {
  await db.run('UPDATE storage_settings SET account_slug = NULL, account_label = NULL WHERE id = 1').catch(() => {})
  resetAccountSlugCache()
}

async function setBusinessName(name) {
  await db.run('DELETE FROM users').catch(() => {})
  if (name !== undefined) {
    await db.run(
      "INSERT INTO users (username, email, password_hash, business_name) VALUES ('owner', 'owner@test.dev', 'x', ?)",
      [name]
    )
  }
  resetAccountSlugCache()
}

// El SQLite de test es un archivo compartido entre procesos; dejamos el estado
// limpio para no contaminar el slug/negocio de otras suites (p.ej. las de storage).
after(async () => {
  await db.run('DELETE FROM users').catch(() => {})
  await db.run('UPDATE storage_settings SET account_slug = NULL, account_label = NULL WHERE id = 1').catch(() => {})
  resetAccountSlugCache()
})

test('sin nombre de negocio → slug = id técnico tal cual (sin sufijo, sin persistir)', async () => {
  await setBusinessName(undefined) // sin usuarios
  await clearPersistedSlug()

  const { slug, label } = await resolveAccountSlug('loc_test')

  assert.equal(slug, 'loc_test')
  assert.equal(label, '')
  const row = await db.get('SELECT account_slug FROM storage_settings WHERE id = 1')
  assert.equal(row.account_slug ?? null, null) // el provisional NO se persiste
})

test('con nombre de negocio → slug legible + sufijo de 6 hex, y se persiste', async () => {
  await clearPersistedSlug()
  await setBusinessName('Café Alexis MX!')

  const { slug, label } = await resolveAccountSlug('loc_test')

  assert.match(slug, /^cafe-alexis-mx-[0-9a-f]{6}$/) // acentos y símbolos limpiados
  assert.equal(label, 'Café Alexis MX!')
  const row = await db.get('SELECT account_slug, account_label FROM storage_settings WHERE id = 1')
  assert.equal(row.account_slug, slug)
  assert.equal(row.account_label, 'Café Alexis MX!')
})

test('slug guardado es estable: no cambia aunque cambie el nombre del negocio', async () => {
  await clearPersistedSlug()
  await setBusinessName('Primero SA')
  const first = await resolveAccountSlug('loc_test')
  assert.match(first.slug, /^primero-sa-[0-9a-f]{6}$/)

  await setBusinessName('Segundo Nombre Distinto') // cambia el negocio...
  const second = await resolveAccountSlug('loc_test')
  assert.equal(second.slug, first.slug) // ...pero manda el slug ya persistido
})

test('sufijo anti-colisión: mismo nombre, cuentas distintas → slug distinto', async () => {
  await clearPersistedSlug()
  await setBusinessName('Fitness Pro')
  const a = await resolveAccountSlug('cuenta_a')

  await clearPersistedSlug() // forzar re-derivación con otra cuenta
  const b = await resolveAccountSlug('cuenta_b')

  assert.match(a.slug, /^fitness-pro-[0-9a-f]{6}$/)
  assert.match(b.slug, /^fitness-pro-[0-9a-f]{6}$/)
  assert.notEqual(a.slug, b.slug) // el sufijo (derivado del id de cuenta) difiere
})
