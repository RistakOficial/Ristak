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

test('AI HTML draft edit returns edited draft without saving imported code', async () => {
  const {
    createImportedSiteFromHtml,
    deleteSite,
    getImportedSiteBySiteId,
    updateImportedSiteHtmlWithAI
  } = await import('../src/services/sitesService.js')

  let siteId = ''

  try {
    const html = '<!doctype html><html><head><title>AI draft test</title></head><body><main><h1 data-rstk-editable="true" data-rstk-edit-type="heading">Original heading</h1><button data-rstk-editable="true" data-rstk-edit-type="button">Original CTA</button></main></body></html>'
    const created = await createImportedSiteFromHtml({
      filename: 'ai-draft-test.html',
      fileBase64: Buffer.from(html, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `AI Draft Test ${Date.now()}`
    })
    siteId = created.site.id

    const storedHtml = created.import.codeFiles[0].content
    const currentDraftHtml = storedHtml.replace('Original heading', 'Draft heading from editor')
    const prompt = [
      'Elementos detectados dentro de la zona:',
      '1. tag=h1, role=titular, editId=heading_original_heading, editType=heading, label=Original heading, rect=x=10 y=10 w=200 h=40, text=Draft heading from editor',
      'HTML: <h1 data-rstk-editable="true" data-rstk-edit-type="heading" data-rstk-edit-id="heading_original_heading">Draft heading from editor</h1>',
      '',
      'Solicitud del usuario:',
      'cambia el título a "AI assistant heading"',
      '',
      'Reglas para esta edición:',
      '- Devuelve el HTML completo actualizado.'
    ].join('\n')

    const result = await updateImportedSiteHtmlWithAI(siteId, {
      siteKind: 'landing',
      pageId: 'page-1',
      draftOnly: true,
      currentHtml: currentDraftHtml,
      aiRegionRequest: 'cambia el título a "AI assistant heading"',
      messages: [{ role: 'user', content: prompt }]
    })

    assert.equal(result.status, 'updated')
    assert.match(result.draftHtml, /AI assistant heading/)
    assert.doesNotMatch(result.draftHtml, />Draft heading from editor</)
    assert.equal(result.site, undefined)
    assert.equal(result.import, undefined)

    const storedAfterDraft = await getImportedSiteBySiteId(siteId)
    assert.match(storedAfterDraft.htmlSanitized, /Original heading/)
    assert.doesNotMatch(storedAfterDraft.htmlSanitized, /AI assistant heading/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('imported HTML code editor saves popup code as site popup HTML', async () => {
  const {
    createImportedSiteFromHtml,
    deleteSite,
    getSitePreview,
    renderPublicSiteHtml,
    updateImportedSiteCodeFiles
  } = await import('../src/services/sitesService.js')

  let siteId = ''

  try {
    const html = '<!doctype html><html><head><title>Popup code test</title></head><body><main><h1>Página principal</h1><button data-rstk-button-action="open_popup">Abrir</button></main></body></html>'
    const created = await createImportedSiteFromHtml({
      filename: 'popup-code-test.html',
      fileBase64: Buffer.from(html, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `Popup Code Test ${Date.now()}`
    })
    siteId = created.site.id

    const popupHtml = [
      '<!doctype html>',
      '<html><head><style>.popup-code-title{color:#111827}</style></head>',
      '<body><section><h2 class="popup-code-title">Popup editado con código</h2><p>Contenido propio del pop up.</p></section></body></html>'
    ].join('')
    const updated = await updateImportedSiteCodeFiles(siteId, {
      files: [{ path: 'ristak-popup.html', content: popupHtml }]
    })

    const popupCodeFile = updated.import.codeFiles.find(file => file.path === 'ristak-popup.html')
    assert.ok(popupCodeFile)
    assert.equal(popupCodeFile.role, 'popup')
    assert.match(popupCodeFile.content, /Popup editado con código/)
    assert.match(updated.site.theme.importedPopupHtml, /Popup editado con código/)

    const previewSite = await getSitePreview(siteId)
    const rendered = await renderPublicSiteHtml(previewSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(rendered, /rstk-site-popup/)
    assert.match(rendered, /Popup editado con código/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('imported HTML internal page links stay inside the site preview flow', async () => {
  const {
    createImportedSiteFromHtml,
    deleteSite,
    getSitePreview,
    renderPublicSiteHtml,
    updateImportedSiteCodeFiles
  } = await import('../src/services/sitesService.js')

  let siteId = ''

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'inicio.html',
      siteType: 'landing_page',
      name: `Multi Page Links ${Date.now()}`,
      pages: [
        {
          id: 'page-1',
          title: 'Inicio',
          filename: 'inicio.html',
          html: '<!doctype html><html><head><title>Inicio</title></head><body><main><a id="next" href="gracias.html#detalle">Ir a gracias</a></main></body></html>'
        },
        {
          id: 'page-2',
          title: 'Gracias',
          filename: 'gracias.html',
          html: '<!doctype html><html><head><title>Gracias</title></head><body><main id="detalle"><h1>Gracias</h1><a href="inicio.html">Volver</a></main></body></html>'
        }
      ]
    })
    siteId = created.site.id

    let previewSite = await getSitePreview(siteId)
    let rendered = await renderPublicSiteHtml(previewSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(rendered, /href="\?page=page-2#detalle"/)
    assert.doesNotMatch(rendered, /href="\/api\/sites\/public\/imported-assets\/[^"]*gracias\.html/)

    await updateImportedSiteCodeFiles(siteId, {
      files: [{
        path: 'inicio.html',
        content: '<!doctype html><html><head><title>Inicio</title></head><body><main><a id="next" href="./gracias.html?src=cta#detalle">Ir a gracias</a></main></body></html>'
      }]
    })

    previewSite = await getSitePreview(siteId)
    rendered = await renderPublicSiteHtml(previewSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(rendered, /href="\?page=page-2&amp;src=cta#detalle"|href="\?page=page-2&src=cta#detalle"/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('AI HTML editor instructions stay scoped to active code only', async () => {
  const { buildSitesAIHtmlInstructions } = await import('../src/services/sitesService.js')

  const instructions = buildSitesAIHtmlInstructions({
    siteKind: 'landing',
    editMode: true,
    agentConfig: {
      business_context: 'Clinica secreta del negocio',
      market_context: 'Mercado privado guardado',
      ideal_customer: 'Cliente ideal guardado',
      brand_voice: 'Voz de marca del chatbot'
    }
  })

  assert.match(instructions, /Alcance privado del editor HTML/)
  assert.match(instructions, /Solo puedes usar el HTML\/CSS\/JS activo/)
  assert.match(instructions, /No tienes acceso al contexto del negocio/)
  assert.match(instructions, /Esta prohibido responderle al usuario dentro del HTML/)
  assert.match(instructions, /Aplica cambios en silencio/)
  assert.match(instructions, /NUNCA dejes un <video>/)
  assert.match(instructions, /rstk-imported-video-slot/)
  assert.match(instructions, /data-rstk-video-url/)
  assert.match(instructions, /Mantén el mismo valor en data-rstk-video-url y en src/)
  assert.doesNotMatch(instructions, /Clinica secreta del negocio/)
  assert.doesNotMatch(instructions, /Mercado privado guardado/)
  assert.doesNotMatch(instructions, /Cliente ideal guardado/)
  assert.doesNotMatch(instructions, /Voz de marca del chatbot/)
  assert.doesNotMatch(instructions, /Contexto del negocio configurado en Ristak/)
})

test('AI HTML editor sends uploaded references as multimodal input parts', async () => {
  const {
    buildSitesAIResponsesInput,
    normalizeSitesAIReferenceAttachments
  } = await import('../src/services/sitesService.js')

  const attachments = normalizeSitesAIReferenceAttachments([
    {
      name: 'referencia.png',
      size: 12,
      mimeType: 'image/png',
      kind: 'image',
      dataUrl: 'data:image/png;base64,aGVsbG8='
    },
    {
      name: 'brief.pdf',
      size: 16,
      mimeType: 'application/pdf',
      kind: 'pdf',
      dataUrl: 'data:application/pdf;base64,aGVsbG8='
    },
    {
      name: 'copy.md',
      size: 20,
      mimeType: 'text/markdown',
      kind: 'text',
      text: 'Usa este tono para el hero.'
    }
  ])

  assert.equal(attachments.length, 3)
  assert.equal(attachments[0].kind, 'image')
  assert.equal(attachments[1].kind, 'pdf')
  assert.equal(attachments[2].text, 'Usa este tono para el hero.')

  const input = buildSitesAIResponsesInput({
    currentHtml: '<!doctype html><html><body><h1>Demo</h1></body></html>',
    attachments
  })

  assert.equal(Array.isArray(input), true)
  const content = input[0].content
  assert.equal(content.some(part => part.type === 'input_image' && part.image_url === 'data:image/png;base64,aGVsbG8='), true)
  assert.equal(content.some(part => part.type === 'input_file' && part.filename === 'brief.pdf'), true)
  assert.equal(content.some(part => part.type === 'input_text' && /Contenido del archivo copy\.md/.test(part.text)), true)
  assert.equal(/data:image\/png;base64,aGVsbG8=/.test(content[0].text), false)
  assert.match(content[0].text, /contenido adjunto enviado como input_image\/input_file/)
})

test('AI HTML editor blocks assistant replies and prompt echoes inside page HTML', async () => {
  const { getSitesAIEditorReplyContaminationReason } = await import('../src/services/sitesService.js')

  const promptEchoPage = {
    html: '<!doctype html><html><body><main><h1>Hazme un sitio web sobre perros</h1><p>Servicios para mascotas.</p></main></body></html>'
  }
  assert.equal(
    getSitesAIEditorReplyContaminationReason(promptEchoPage, {
      aiRegionRequest: 'Hazme un sitio web sobre perros'
    }),
    'prompt_echo'
  )

  const assistantReplyPage = {
    html: '<!doctype html><html><body><main><p>Claro, aqui tienes el sitio web actualizado.</p><h1>Veterinaria Luna</h1></main></body></html>'
  }
  assert.equal(
    getSitesAIEditorReplyContaminationReason(assistantReplyPage, {
      aiRegionRequest: 'cambia el titulo'
    }),
    'assistant_reply_copy'
  )

  const cleanPage = {
    html: '<!doctype html><html><body><main><h1>Veterinaria Luna</h1><p>Cuidado moderno para perros y gatos.</p></main></body></html>'
  }
  assert.equal(
    getSitesAIEditorReplyContaminationReason(cleanPage, {
      aiRegionRequest: 'Hazme un sitio web sobre perros'
    }),
    ''
  )
})
