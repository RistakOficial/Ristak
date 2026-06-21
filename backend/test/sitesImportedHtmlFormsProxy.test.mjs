import test from 'node:test'
import assert from 'node:assert/strict'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import {
  createImportedSiteFromHtml,
  createSubmissionFromRequest,
  deleteSite,
  getSite,
  getSitesTrackingSummary,
  listSites,
  updateImportedSiteCodeFiles,
  updateSite
} from '../src/services/sitesService.js'

const DOMAIN_KEYS = {
  domain: 'sites_public_domain',
  verified: 'sites_public_domain_verified',
  checkedAt: 'sites_public_domain_checked_at',
  error: 'sites_public_domain_error'
}

function getSourceQuestionBlocks(site) {
  return (site.blocks || [])
    .filter(block => block.settings?.pageId === 'page-1')
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
}

test('imported HTML forms materialize Forms-page source forms and route submissions to them', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const email = `html-proxy-${suffix}@example.test`
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  let siteId = ''
  let sourceFormId = ''

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    const html = `
      <!doctype html>
      <html>
        <head><title>Landing HTML proxy</title></head>
        <body>
          <main>
            <h1>Agenda una llamada</h1>
            <form id="lead-form">
              <label for="full_name">Nombre completo</label>
              <input id="full_name" name="full_name" placeholder="Tu nombre" required>
              <label for="email">Correo</label>
              <input id="email" type="email" name="email" placeholder="tu@email.com" required>
              <label for="plan">Plan</label>
              <select id="plan" name="plan">
                <option value="starter">Starter</option>
                <option value="pro">Pro</option>
              </select>
              <button type="submit">Quiero info</button>
            </form>
          </main>
        </body>
      </html>
    `

    const created = await createImportedSiteFromHtml({
      filename: 'landing-html-proxy.html',
      fileBase64: Buffer.from(html, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `Landing HTML Proxy ${suffix}`
    })
    siteId = created.site.id

    const mapping = created.import.formMappings[0]
    assert.ok(mapping.formSiteId)
    sourceFormId = mapping.formSiteId

    let sourceForm = await getSite(sourceFormId, { includeBlocks: true, includeSubmissions: true })
    assert.equal(sourceForm.siteType, 'standard_form')
    assert.match(sourceForm.name, /^Formulario de Landing HTML Proxy/)
    assert.equal(sourceForm.theme.importedHtmlSource, true)
    assert.equal(sourceForm.theme.importedHtmlSourceSiteId, siteId)
    assert.equal(sourceForm.theme.pages[0].buttonText, 'Quiero info')
    assert.deepEqual(
      getSourceQuestionBlocks(sourceForm).map(block => [block.blockType, block.label, block.placeholder, block.required]),
      [
        ['short_text', 'Nombre completo', 'Tu nombre', true],
        ['email', 'Correo', 'tu@email.com', true],
        ['dropdown', 'Plan', '', false]
      ]
    )

    const savedHtml = created.import.codeFiles[0].content
      .replace('>Quiero info<', '>Enviar lead<')
      .replace('</form>', '<textarea name="message" placeholder="Cuéntanos"></textarea></form>')
    const updated = await updateImportedSiteCodeFiles(siteId, {
      files: [{ path: '', content: savedHtml }]
    })

    assert.equal(updated.import.formMappings[0].formSiteId, sourceFormId)
    sourceForm = await getSite(sourceFormId, { includeBlocks: true, includeSubmissions: true })
    assert.equal(sourceForm.theme.pages[0].buttonText, 'Enviar lead')
    assert.equal(getSourceQuestionBlocks(sourceForm).length, 4)
    assert.ok(getSourceQuestionBlocks(sourceForm).some(block => block.blockType === 'paragraph' && block.label === 'Cuéntanos'))

    await updateSite(siteId, {
      status: 'published',
      siteType: 'landing_page',
      theme: created.site.theme
    })

    const result = await createSubmissionFromRequest(
      {
        headers: { host: 'example.test', 'user-agent': 'node-test' },
        hostname: 'example.test',
        path: `/${created.site.slug}`,
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' }
      },
      {
        siteId,
        importedFormId: updated.import.formMappings[0].formId,
        rawFields: {
          full_name: 'Ana Proxy',
          email,
          plan: 'pro',
          message: 'Necesito detalles'
        }
      }
    )

    const submission = await db.get('SELECT site_id, form_site_id, meta_json FROM public_site_submissions WHERE id = ?', [result.submissionId])
    assert.equal(submission.site_id, siteId)
    assert.equal(submission.form_site_id, sourceFormId)
    assert.equal(JSON.parse(submission.meta_json).formSiteId, sourceFormId)

    sourceForm = await getSite(sourceFormId, { includeBlocks: true, includeSubmissions: true })
    assert.equal(sourceForm.submissions.length, 1)
    assert.equal(sourceForm.submissions[0].id, result.submissionId)

    const listedSourceForm = (await listSites()).find(site => site.id === sourceFormId)
    assert.equal(listedSourceForm.submissionsCount, 1)

    const summary = await getSitesTrackingSummary({ siteIds: [sourceFormId] })
    assert.equal(summary.bySiteId[sourceFormId].conversions, 1)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    if (sourceFormId) await deleteSite(sourceFormId).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain || '')
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified || '')
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt || '')
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error || '')
  }
})
