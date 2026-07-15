import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  createImportedSiteFromHtml,
  deleteSite,
  getImportedSiteBySiteId,
  updateImportedSiteCodeFiles,
  updateImportedSiteFieldMapping
} from '../src/services/sitesService.js'

async function deleteSites(siteIds = []) {
  for (const siteId of new Set(siteIds.filter(Boolean))) {
    await deleteSite(siteId).catch(() => undefined)
  }
}

function activeForm(imported, formId) {
  return imported?.formMappings?.find(mapping => (
    mapping.present !== false && mapping.formId === formId
  ))
}

test('automatic form ids stay attached to their real forms when an omitted form appears first', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  const sourceFormIds = []

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'formularios-con-auxiliar.html',
      name: `Formularios con auxiliar ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <form id="provider-handshake">
          <input type="hidden" name="provider_token" value="abc">
          <button type="submit">Continuar</button>
        </form>
        <form id="lead-a" data-rstk-label="Lead A">
          <input name="email" type="email" data-rstk-field-id="correo-a">
          <button type="submit">Enviar A</button>
        </form>
        <form id="lead-b" data-rstk-label="Lead B">
          <input name="phone" type="tel" data-rstk-field-id="telefono-b">
          <button type="submit">Enviar B</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId))

    assert.deepEqual(
      created.import.formMappings.map(mapping => mapping.formId),
      ['page_lead_a', 'page_lead_b']
    )

    const openingForms = [...created.import.htmlSanitized.matchAll(/<form\b[^>]*>/gi)]
      .map(match => match[0])
    assert.equal(openingForms.length, 3)
    assert.doesNotMatch(openingForms[0], /data-rstk-form-id=/)
    assert.match(openingForms[1], /data-rstk-form-id="page_lead_a"/)
    assert.match(openingForms[2], /data-rstk-form-id="page_lead_b"/)
  } finally {
    await deleteSites([siteId, ...sourceFormIds])
  }
})

test('mapping auto-upgrade shares the mutation lock and preserves a concurrent field PATCH', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  const sourceFormIds = []
  const originalWithAdvisoryLock = db.withAdvisoryLock
  let restoreWithAdvisoryLock = false
  let releaseDelayedUpgrade = () => {}
  let autoReadPromise = null

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'auto-upgrade-concurrente.html',
      name: `Auto upgrade concurrente ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <form data-rstk-form-id="lead-lock" data-rstk-label="Lead lock">
          <input name="email" type="email" data-rstk-field-id="correo-principal">
          <textarea name="message" data-rstk-field-id="mensaje-principal"></textarea>
          <button type="submit">Enviar</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId))

    const staleDetectedForms = created.import.detectedForms.map(form => ({
      ...form,
      fields: form.fields.slice(0, 1)
    }))
    const staleMappings = created.import.formMappings.map(mapping => ({
      ...mapping,
      fields: mapping.fields.slice(0, 1)
    }))
    await db.run(`
      UPDATE public_site_imports SET
        detected_forms_json = ?,
        form_mappings_json = ?,
        status = 'mapping_pending',
        updated_at = CURRENT_TIMESTAMP
      WHERE site_id = ?
    `, [JSON.stringify(staleDetectedForms), JSON.stringify(staleMappings), siteId])

    let signalUpgradeStarted
    const upgradeStarted = new Promise(resolve => { signalUpgradeStarted = resolve })
    const delayedUpgrade = new Promise(resolve => { releaseDelayedUpgrade = resolve })
    let intercepted = false
    db.withAdvisoryLock = async (lockName, operation) => {
      if (!intercepted && lockName === `sites:imported-html:${siteId}`) {
        intercepted = true
        signalUpgradeStarted()
        await delayedUpgrade
      }
      return originalWithAdvisoryLock(lockName, operation)
    }
    restoreWithAdvisoryLock = true

    autoReadPromise = getImportedSiteBySiteId(siteId)
    await upgradeStarted

    await updateImportedSiteFieldMapping(siteId, {
      pagePath: '',
      formId: 'lead_lock',
      fieldId: 'correo_principal',
      destinationType: 'standard',
      destinationKey: 'phone'
    })

    releaseDelayedUpgrade()
    const autoRead = await autoReadPromise
    autoReadPromise = null

    const form = activeForm(autoRead, 'lead_lock')
    assert.equal(form.fields.filter(field => field.present !== false).length, 2)
    const patchedField = form.fields.find(field => field.fieldId === 'correo_principal')
    assert.equal(patchedField.destinationType, 'standard')
    assert.equal(patchedField.destinationKey, 'phone')
    assert.equal(patchedField.ignored, false)
    assert.equal(patchedField.present, true)
    assert.ok(form.fields.some(field => field.fieldId === 'mensaje_principal'))

    const persisted = await getImportedSiteBySiteId(siteId)
    const persistedForm = activeForm(persisted, 'lead_lock')
    assert.equal(
      persistedForm.fields.find(field => field.fieldId === 'correo_principal').destinationKey,
      'phone'
    )
    assert.ok(persistedForm.fields.some(field => field.fieldId === 'mensaje_principal'))
  } finally {
    releaseDelayedUpgrade()
    if (autoReadPromise) await autoReadPromise.catch(() => undefined)
    if (restoreWithAdvisoryLock) db.withAdvisoryLock = originalWithAdvisoryLock
    if (siteId) {
      const imported = await getImportedSiteBySiteId(siteId).catch(() => null)
      sourceFormIds.push(...(imported?.formMappings || []).map(mapping => mapping.formSiteId))
    }
    await deleteSites([siteId, ...sourceFormIds])
  }
})

test('code rewrite and field PATCH share one site lock and preserve both changes', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  const sourceFormIds = []
  const originalWithAdvisoryLock = db.withAdvisoryLock
  let restoreWithAdvisoryLock = false
  let releaseCodeLock = () => {}
  let codePromise = null
  let patchPromise = null

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'carrera-codigo-mapeo.html',
      name: `Carrera código y mapeo ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <form data-rstk-form-id="lead-carrera" data-rstk-label="Lead inicial">
          <label>Email <input name="email" type="email" data-rstk-field-id="contacto-principal"></label>
          <button type="submit">Enviar</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId))
    const initialSourceFormId = activeForm(created.import, 'lead_carrera')?.formSiteId || ''

    let signalCodeLockHeld
    const codeLockHeld = new Promise(resolve => { signalCodeLockHeld = resolve })
    const holdCodeLock = new Promise(resolve => { releaseCodeLock = resolve })
    let intercepted = false
    db.withAdvisoryLock = async (lockName, operation) => {
      if (!intercepted && lockName === `sites:imported-html:${siteId}`) {
        intercepted = true
        return originalWithAdvisoryLock(lockName, async () => {
          signalCodeLockHeld()
          await holdCodeLock
          return operation()
        })
      }
      return originalWithAdvisoryLock(lockName, operation)
    }
    restoreWithAdvisoryLock = true

    codePromise = updateImportedSiteCodeFiles(siteId, {
      files: [{
        path: '',
        content: `<!doctype html><html><body>
          <h1>Código reescrito</h1>
          <form data-rstk-form-id="lead-carrera" data-rstk-label="Lead actualizado">
            <label>Canal <input name="canal_contacto" data-rstk-field-id="contacto-principal"></label>
            <label>Mensaje <textarea name="mensaje" data-rstk-field-id="mensaje-secundario"></textarea></label>
            <button type="submit">Enviar actualización</button>
          </form>
        </body></html>`
      }]
    })
    await codeLockHeld

    let patchSettled = false
    patchPromise = updateImportedSiteFieldMapping(siteId, {
      pagePath: '',
      formId: 'lead_carrera',
      fieldId: 'contacto_principal',
      destinationType: 'standard',
      destinationKey: 'phone'
    }).finally(() => { patchSettled = true })

    await new Promise(resolve => setImmediate(resolve))
    assert.equal(patchSettled, false, 'the field PATCH must wait while the code rewrite owns the site lock')

    releaseCodeLock()
    await Promise.all([codePromise, patchPromise])
    codePromise = null
    patchPromise = null
    db.withAdvisoryLock = originalWithAdvisoryLock
    restoreWithAdvisoryLock = false

    const imported = await getImportedSiteBySiteId(siteId)
    sourceFormIds.push(...(imported.formMappings || []).map(mapping => mapping.formSiteId))
    assert.match(imported.codeFiles[0].content, /Código reescrito/)
    const form = activeForm(imported, 'lead_carrera')
    assert.equal(form.formSiteId, initialSourceFormId)
    assert.equal(form.formTitle, 'Lead actualizado')
    const routedField = form.fields.find(field => field.fieldId === 'contacto_principal')
    assert.equal(routedField.sourceName, 'canal_contacto')
    assert.equal(routedField.destinationType, 'standard')
    assert.equal(routedField.destinationKey, 'phone')
    assert.equal(routedField.present, true)
    assert.ok(form.fields.some(field => field.fieldId === 'mensaje_secundario' && field.present !== false))
  } finally {
    releaseCodeLock()
    if (codePromise) await codePromise.catch(() => undefined)
    if (patchPromise) await patchPromise.catch(() => undefined)
    if (restoreWithAdvisoryLock) db.withAdvisoryLock = originalWithAdvisoryLock
    if (siteId) {
      const imported = await getImportedSiteBySiteId(siteId).catch(() => null)
      sourceFormIds.push(...(imported?.formMappings || []).map(mapping => mapping.formSiteId))
    }
    await deleteSites([siteId, ...sourceFormIds])
  }
})
