import test, { after } from 'node:test'
import assert from 'node:assert/strict'

// Fuerza SQLite (sin DATABASE_URL) para que el test sea autocontenido.
delete process.env.DATABASE_URL

const [{ db }, mediaStorageService] = await Promise.all([
  import('../src/config/database.js'),
  import('../src/services/mediaStorageService.js')
])
const { resolveAccountSlug, resetAccountSlugCache, buildAccountReadmeContent } = mediaStorageService

const IDENTITY_ENV = ['RISTAK_ACCOUNT_SLUG', 'ACCOUNT_SLUG', 'RENDER_EXTERNAL_URL', 'PUBLIC_URL', 'APP_URL']
function clearIdentityEnv() {
  for (const k of IDENTITY_ENV) delete process.env[k]
}
clearIdentityEnv()

async function clearPersistedSlug() {
  clearIdentityEnv()
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

test('_LEEME.txt documenta la cuenta y la leyenda de categorías', async () => {
  const content = buildAccountReadmeContent({
    id: 'loc_mexico',
    slug: 'cafe-alexis-a1b2c3',
    label: 'Café Alexis MX'
  })
  assert.match(content, /BODEGA RISTAK/)
  assert.match(content, /Cuenta: Café Alexis MX/)
  assert.match(content, /accounts\/cafe-alexis-a1b2c3\//)
  assert.match(content, /id interno: loc_mexico/)
  // La leyenda lista las categorías legibles (incluidas las nuevas).
  for (const folder of ['avatars/', 'sites/', 'forms/', 'chat/', 'ad_creatives/']) {
    assert.ok(content.includes(folder), `falta la categoría ${folder}`)
  }
})

test('_LEEME.txt cae al slug/id cuando no hay label', async () => {
  const content = buildAccountReadmeContent({ id: 'loc_solo', slug: 'loc_solo' })
  assert.match(content, /Cuenta: loc_solo/)
  assert.match(content, /accounts\/loc_solo\//)
})

test('RISTAK_ACCOUNT_SLUG (installer) manda sobre business_name y sin sufijo', async () => {
  await clearPersistedSlug()
  await setBusinessName('Café Alexis MX') // habría dado cafe-alexis-mx-<hash>...
  process.env.RISTAK_ACCOUNT_SLUG = 'marcomaxilofacial' // ...pero la env explícita gana
  resetAccountSlugCache()
  const { slug, label } = await resolveAccountSlug('loc_test')
  assert.equal(slug, 'marcomaxilofacial') // único de por sí → sin sufijo
  assert.equal(label, 'Café Alexis MX')
})

test('subdominio del install (RENDER_EXTERNAL_URL) se usa si no hay env explícita', async () => {
  await clearPersistedSlug()
  await setBusinessName(undefined)
  process.env.RENDER_EXTERNAL_URL = 'https://marcomaxilofacial.onrender.com'
  resetAccountSlugCache()
  const { slug } = await resolveAccountSlug('loc_test')
  assert.equal(slug, 'marcomaxilofacial')
})

test('subdominios genéricos (app/www) se ignoran y cae a business_name', async () => {
  await clearPersistedSlug()
  await setBusinessName('Clinica Fisio')
  process.env.RENDER_EXTERNAL_URL = 'https://app.ristak.com' // subdominio genérico
  resetAccountSlugCache()
  const { slug } = await resolveAccountSlug('loc_test')
  assert.match(slug, /^clinica-fisio-[0-9a-f]{6}$/) // usa el negocio, no 'app'
})

// El SQLite de test es un archivo compartido entre procesos; dejamos el estado
// limpio para no contaminar el slug/negocio de otras suites (p.ej. las de storage).
after(async () => {
  clearIdentityEnv()
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
