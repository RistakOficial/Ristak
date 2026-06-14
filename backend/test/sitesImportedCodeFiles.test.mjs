import test from 'node:test'
import assert from 'node:assert/strict'

test('imported HTML code files are listed and saved through the code editor endpoint', async () => {
  const {
    createImportedSiteFromHtml,
    deleteSite,
    getSitePreview,
    renderPublicSiteHtml,
    updateImportedSiteCodeFiles
  } = await import('../src/services/sitesService.js')

  let siteId = ''

  try {
    const html = '<!doctype html><html><head><title>Code file test</title></head><body><main><h1>Original heading</h1><p>Original copy</p></main></body></html>'
    const created = await createImportedSiteFromHtml({
      filename: 'code-file-test.html',
      fileBase64: Buffer.from(html, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `Code File Test ${Date.now()}`
    })
    siteId = created.site.id

    assert.equal(created.import.codeFiles.length, 1)
    assert.equal(created.import.codeFiles[0].path, '')
    assert.equal(created.import.codeFiles[0].language, 'html')
    assert.match(created.import.codeFiles[0].content, /Original heading/)

    const updatedContent = created.import.codeFiles[0].content.replace('>Original heading<', '>Edited from code<')
    const updated = await updateImportedSiteCodeFiles(siteId, {
      files: [{ path: '', content: updatedContent }]
    })

    assert.match(updated.import.codeFiles[0].content, /Edited from code/)

    const previewSite = await getSitePreview(siteId)
    const rendered = await renderPublicSiteHtml(previewSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(rendered, /Edited from code/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})
