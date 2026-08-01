import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { siteToolSpecs } from '../src/mcp/siteTools.js'

function tool(name) {
  const found = siteToolSpecs.find((entry) => entry.name === name)
  assert.ok(found, `No existe la herramienta ${name}`)
  return found
}

function recorder(response = { success: true, data: {} }) {
  const calls = []
  return {
    calls,
    context: {
      user: { id: 'user_1' },
      baseUrl: 'https://app.example.com',
      async invoke(handler, request) {
        calls.push({ handler: handler.name, request })
        return typeof response === 'function' ? response(handler, request, calls.length) : response
      }
    }
  }
}

function codeRevision(files = []) {
  const hash = createHash('sha256')
  for (const file of [...files].sort((left, right) => String(left.path || '').localeCompare(String(right.path || '')))) {
    const path = String(file.path || '')
    const content = String(file.content || '')
    hash.update(`${Buffer.byteLength(path, 'utf8')}:${path}:${Buffer.byteLength(content, 'utf8')}:${content}\n`)
  }
  return `sha256:${hash.digest('hex')}`
}

test('las specs de Sites tienen nombres únicos y metadata de seguridad completa', () => {
  assert.ok(siteToolSpecs.length >= 20)
  assert.equal(new Set(siteToolSpecs.map((entry) => entry.name)).size, siteToolSpecs.length)

  for (const entry of siteToolSpecs) {
    assert.match(entry.name, /^sites_[a-z0-9_]+$/)
    assert.equal(entry.module, 'sites')
    assert.ok(['read', 'write'].includes(entry.access))
    assert.ok(['ristak.read', 'ristak.write', 'ristak.execute', 'ristak.destructive'].includes(entry.scope))
    assert.ok(['low', 'medium', 'high', 'critical'].includes(entry.risk))
    assert.deepEqual(entry.featureKeys, ['sites'])
    assert.equal(typeof entry.confirmRequired, 'boolean')
    assert.equal(typeof entry.idempotencyRequired, 'boolean')
    assert.equal(entry.inputSchema.type, 'object')
    assert.equal(entry.inputSchema.additionalProperties, false)
    assert.equal(typeof entry.execute, 'function')

    if (entry.confirmRequired) {
      assert.equal(entry.inputSchema.properties.confirm.type, 'boolean')
      assert.ok(entry.inputSchema.required.includes('confirm'))
    }
    if (entry.idempotencyRequired) {
      assert.equal(entry.inputSchema.properties.idempotencyKey.type, 'string')
      assert.ok(entry.inputSchema.required.includes('idempotencyKey'))
    }
  }
})

test('el módulo MCP de Sites no consulta tablas ni duplica SQL de negocio', async () => {
  const source = await readFile(new URL('../src/mcp/siteTools.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.\/config\/database\.js['"]/)
  assert.doesNotMatch(source, /\b(?:SELECT|INSERT|UPDATE|DELETE)\s+(?:FROM|INTO|public_)/i)
  assert.match(source, /from ['"]\.\.\/controllers\/sitesController\.js['"]/)
})

test('crear e importar siempre fuerza un borrador y no propaga controles MCP al controller', async () => {
  const createRecorder = recorder()
  await tool('sites_create_draft').execute(createRecorder.context, {
    name: 'Landing nueva',
    siteType: 'landing_page',
    idempotencyKey: 'create-site-001'
  })
  assert.equal(createRecorder.calls[0].handler, 'createSiteHandler')
  assert.equal(createRecorder.calls[0].request.body.status, 'draft')
  assert.equal(createRecorder.calls[0].request.body.idempotencyKey, undefined)

  const importRecorder = recorder()
  await tool('sites_import_html').execute(importRecorder.context, {
    name: 'Landing HTML',
    filename: 'index.html',
    html: '<!doctype html><html><body>Hola</body></html>',
    idempotencyKey: 'import-site-001'
  })
  assert.equal(importRecorder.calls[0].handler, 'importSiteHtmlHandler')
  assert.equal(importRecorder.calls[0].request.body.status, undefined)
  assert.equal(importRecorder.calls[0].request.body.idempotencyKey, undefined)
})

test('el flujo HTML premium es la ruta principal y separa claramente los bloques nativos', () => {
  const validateTool = tool('sites_validate_html')
  const createHtmlTool = tool('sites_create_html_draft')
  const livePreviewTool = tool('sites_open_html_live_preview')
  const patchHtmlTool = tool('sites_patch_html_draft')
  const replaceHtmlTool = tool('sites_replace_html_draft')
  const nativeTool = tool('sites_create_draft')

  assert.ok(
    siteToolSpecs.indexOf(createHtmlTool) < siteToolSpecs.indexOf(nativeTool),
    'el selector MCP debe ver primero la creación HTML'
  )
  assert.equal(validateTool.scope, 'ristak.read')
  assert.equal(createHtmlTool.scope, 'ristak.write')
  assert.equal(livePreviewTool.scope, 'ristak.read')
  assert.equal(patchHtmlTool.scope, 'ristak.write')
  assert.equal(replaceHtmlTool.scope, 'ristak.write')
  assert.equal(patchHtmlTool.confirmRequired, false)
  assert.equal(patchHtmlTool.inputSchema.required.includes('expectedRevision'), false)
  assert.equal(replaceHtmlTool.confirmRequired, false)
  assert.equal(replaceHtmlTool.inputSchema.properties.confirm, undefined)
  assert.match(createHtmlTool.description, /bloques genéricos/i)
  assert.match(nativeTool.description, /sites_create_html_draft/)
  assert.equal(createHtmlTool.outputSchema.additionalProperties, false)
  assert.equal(validateTool.outputSchema.additionalProperties, false)
})

test('sites_validate_html detecta incompatibilidades antes de crear un borrador', async () => {
  const invalid = await tool('sites_validate_html').execute(recorder().context, {
    html: '<main><h1>Fragmento</h1><script>alert(1)</script></main>'
  })
  assert.equal(invalid.data.ready, false)
  assert.ok(invalid.data.qualityReport.errors.some(issue => issue.code === 'missing_doctype'))
  assert.ok(invalid.data.qualityReport.errors.some(issue => issue.code === 'unsupported_scripts'))
  assert.equal(invalid.data.recommendedCreateTool, '')

  const validHtml = `<!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Landing premium</title>
        <style>
          main { display: grid; grid-template-columns: minmax(0, 1fr); }
          @media (max-width: 700px) { main { padding: 1rem; } }
        </style>
      </head>
      <body><main><h1>Una propuesta clara</h1></main></body>
    </html>`
  const valid = await tool('sites_validate_html').execute(recorder().context, { html: validHtml })
  assert.equal(valid.data.ready, true)
  assert.equal(valid.data.recommendedCreateTool, 'sites_create_html_draft')
  assert.equal(valid.data.qualityReport.errors.length, 0)
})

test('sites_create_html_draft exige HTML completo y devuelve un contrato compacto', async () => {
  const createTool = tool('sites_create_html_draft')
  const blockedRecorder = recorder()
  await assert.rejects(
    () => createTool.execute(blockedRecorder.context, {
      name: 'Landing rota',
      html: '<main><h1>Sin documento</h1></main>',
      idempotencyKey: 'html-draft-invalid-001'
    }),
    error => error.code === 'site_html_not_ready' && error.details?.qualityReport?.ready === false
  )
  assert.equal(blockedRecorder.calls.length, 0)

  const html = `<!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Landing lista</title>
        <style>main{display:grid;grid-template-columns:minmax(0,1fr)}</style>
      </head>
      <body><main><h1>Landing lista</h1></main></body>
    </html>`
  const storedFiles = [{
    path: '',
    label: 'index.html',
    pageId: 'page-1',
    pageTitle: 'Landing lista',
    contentType: 'text/html; charset=utf-8',
    language: 'html',
    content: html,
    sizeBytes: Buffer.byteLength(html),
    updatedAt: '2026-07-28T00:00:00.000Z',
    role: 'main_html'
  }]
  const createRecorder = recorder({
    success: true,
    data: {
      site: {
        id: 'site_html_1',
        name: 'Landing lista',
        status: 'draft',
        slug: 'landing-lista',
        siteType: 'landing_page',
        title: 'Landing lista',
        description: ''
      },
      import: {
        codeFiles: storedFiles,
        detectedForms: [],
        securityReport: ['Se agrego favicon de respaldo']
      }
    }
  })

  const result = await createTool.execute(createRecorder.context, {
    name: 'Landing lista',
    html,
    idempotencyKey: 'html-draft-create-001'
  })

  assert.equal(createRecorder.calls.length, 1)
  assert.equal(createRecorder.calls[0].handler, 'importSiteHtmlHandler')
  assert.equal(createRecorder.calls[0].request.body.filename, 'index.html')
  assert.equal(result.data.siteId, 'site_html_1')
  assert.equal(result.data.editorMode, 'html')
  assert.equal(result.data.revision, codeRevision(storedFiles))
  assert.equal(result.data.files[0].content, undefined)
  assert.equal(result.data.workflow.editDraft, 'sites_patch_html_draft')
  assert.equal(result.data.workflow.replaceDocument, 'sites_replace_html_draft')
  assert.equal(result.data.workflow.livePreview, 'sites_open_html_live_preview')
  assert.equal('htmlOriginal' in result.data, false)
})

test('sites_replace_html_draft guarda sin confirmación sólo con estado y revisión vigentes', async () => {
  const replaceTool = tool('sites_replace_html_draft')
  const currentHtml = '<!doctype html><html><head><title>Anterior</title></head><body><main><h1>Anterior</h1></main></body></html>'
  const nextHtml = `<!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Nueva versión</title>
        <style>main{display:grid;grid-template-columns:minmax(0,1fr)}</style>
      </head>
      <body><main><h1>Nueva versión</h1></main></body>
    </html>`
  const currentFiles = [{
    path: '',
    label: 'index.html',
    language: 'html',
    content: currentHtml,
    role: 'main_html'
  }]
  const nextFiles = [{
    path: '',
    label: 'index.html',
    language: 'html',
    content: nextHtml,
    role: 'main_html'
  }]
  const saveRecorder = recorder((_handler, _request, callNumber) => {
    if (callNumber === 1) {
      return { success: true, data: { siteId: 'site_1', codeFiles: currentFiles } }
    }
    return {
      success: true,
      data: {
        site: {
          id: 'site_1',
          name: 'Landing',
          status: 'draft',
          slug: 'landing',
          siteType: 'landing_page',
          title: 'Nueva versión',
          description: ''
        },
        import: {
          codeFiles: nextFiles,
          detectedForms: [],
          securityReport: []
        }
      }
    }
  })

  const result = await replaceTool.execute(saveRecorder.context, {
    siteId: 'site_1',
    expectedRevision: codeRevision(currentFiles),
    html: nextHtml,
    idempotencyKey: 'html-draft-replace-001'
  })

  assert.deepEqual(saveRecorder.calls.map(entry => entry.handler), [
    'getImportedSiteMappingHandler',
    'updateImportedSiteCodeFilesHandler'
  ])
  assert.deepEqual(saveRecorder.calls[1].request.body, {
    expectedRevision: codeRevision(currentFiles),
    requireDraft: true,
    responseMode: 'compact',
    files: [{ path: '', content: nextHtml }]
  })
  assert.equal(result.data.revision, codeRevision(nextFiles))

  const publishedRecorder = recorder((_handler, _request, callNumber) => {
    if (callNumber === 1) {
      return { success: true, data: { siteId: 'site_live', codeFiles: currentFiles } }
    }
    const error = new Error('Este guardado seguro sólo modifica borradores.')
    error.code = 'site_must_be_draft'
    error.status = 409
    throw error
  })
  await assert.rejects(
    () => replaceTool.execute(publishedRecorder.context, {
      siteId: 'site_live',
      expectedRevision: codeRevision(currentFiles),
      html: nextHtml,
      idempotencyKey: 'html-draft-replace-002'
    }),
    error => error.code === 'site_must_be_draft'
  )
  assert.equal(publishedRecorder.calls.length, 2)
})

test('sites_patch_html_draft edita fragmentos exactos sin reenviar el documento completo', async () => {
  const patchTool = tool('sites_patch_html_draft')
  const currentHtml = `<!doctype html>
    <html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Original</title>
    <style>main{display:grid;grid-template-columns:minmax(0,1fr)}</style></head>
    <body><main><h1>Original</h1><p>Texto estable</p></main></body></html>`
  const nextHtml = currentHtml
    .replace('<title>Original</title>', '<title>Editada</title>')
    .replace('<h1>Original</h1>', '<h1>Editada</h1>')
  const currentFiles = [{ path: '', language: 'html', role: 'main_html', content: currentHtml }]
  const nextFiles = [{ path: '', language: 'html', role: 'main_html', content: nextHtml }]
  const patchRecorder = recorder((_handler, _request, callNumber) => {
    if (callNumber === 1) {
      return { success: true, data: { siteId: 'site_1', codeFiles: currentFiles } }
    }
    return {
      success: true,
      data: {
        site: {
          id: 'site_1',
          name: 'Landing',
          status: 'draft',
          slug: 'landing',
          siteType: 'landing_page',
          title: 'Editada',
          description: ''
        },
        import: { codeFiles: nextFiles, detectedForms: [], securityReport: [] }
      }
    }
  })

  const result = await patchTool.execute(patchRecorder.context, {
    siteId: 'site_1',
    edits: [
      { search: '<title>Original</title>', replacement: '<title>Editada</title>' },
      { search: '<h1>Original</h1>', replacement: '<h1>Editada</h1>' }
    ],
    idempotencyKey: 'html-text-patch-001'
  })

  assert.deepEqual(patchRecorder.calls.map(entry => entry.handler), [
    'getImportedSiteMappingHandler',
    'updateImportedSiteCodeFilesHandler'
  ])
  assert.deepEqual(patchRecorder.calls[1].request.body, {
    expectedRevision: codeRevision(currentFiles),
    requireDraft: true,
    responseMode: 'compact',
    files: [{ path: '', content: nextHtml }]
  })
  assert.equal(result.data.revision, codeRevision(nextFiles))
  assert.equal(result.data.workflow.editDraft, 'sites_patch_html_draft')

  const mismatchRecorder = recorder({
    success: true,
    data: { siteId: 'site_1', codeFiles: currentFiles }
  })
  await assert.rejects(
    () => patchTool.execute(mismatchRecorder.context, {
      siteId: 'site_1',
      edits: [
        { search: '<title>Original</title>', replacement: '<title>Cambio temporal</title>' },
        { search: '<h1>No existe</h1>', replacement: '<h1>Nueva</h1>' }
      ],
      idempotencyKey: 'html-text-patch-002'
    }),
    error => error.code === 'site_html_text_patch_mismatch' &&
      error.details?.editIndex === 1 &&
      error.details?.foundOccurrences === 0 &&
      error.details?.expectedOccurrences === 1
  )
  assert.equal(mismatchRecorder.calls.length, 1)
})

test('sites_open_html_live_preview delega una liga temporal sin pedir confirmación', async () => {
  const previewRecorder = recorder({
    success: true,
    data: {
      siteId: 'site_1',
      status: 'draft',
      revision: `sha256:${'a'.repeat(64)}`,
      url: 'https://app.example.com/api/sites/public/mcp-html-live-preview/token',
      expiresAt: '2026-08-01T21:00:00.000Z',
      refreshIntervalMs: 750,
      trackingEnabled: false,
      mutationsEnabled: false
    }
  })

  const result = await tool('sites_open_html_live_preview').execute(previewRecorder.context, {
    siteId: 'site_1',
    pageId: 'page-1'
  })

  assert.equal(previewRecorder.calls[0].handler, 'createMcpHtmlLivePreviewHandler')
  assert.deepEqual(previewRecorder.calls[0].request.body, { pageId: 'page-1' })
  assert.equal(result.data.trackingEnabled, false)
  assert.equal(result.data.mutationsEnabled, false)
})

test('sites_get_code devuelve inventario compacto y contenido sólo cuando corresponde', async () => {
  const response = {
    success: true,
    data: {
      id: 'import_1',
      siteId: 'site_1',
      importType: 'html',
      status: 'mapping_pending',
      updatedAt: '2026-07-21T10:00:00.000Z',
      htmlOriginal: 'duplicado que no debe salir',
      codeFiles: [
        {
          path: '',
          label: 'index.html',
          language: 'html',
          content: '<h1>Hola</h1>',
          sizeBytes: 13,
          updatedAt: '2026-07-21T10:00:00.000Z',
          role: 'main_html'
        },
        {
          path: 'styles.css',
          label: 'styles.css',
          language: 'css',
          content: 'body{}',
          sizeBytes: 6,
          updatedAt: '2026-07-21T10:00:00.000Z',
          role: 'asset'
        }
      ]
    }
  }

  const listRecorder = recorder(response)
  const list = await tool('sites_get_code').execute(listRecorder.context, { siteId: 'site_1' })
  assert.equal(list.data.revision, codeRevision(response.data.codeFiles))
  assert.equal(list.data.updatedAt, '2026-07-21T10:00:00.000Z')
  assert.equal(list.data.files.length, 2)
  assert.equal('content' in list.data.files[0], false)
  assert.equal('htmlOriginal' in list.data, false)

  const fileRecorder = recorder(response)
  const file = await tool('sites_get_code').execute(fileRecorder.context, {
    siteId: 'site_1',
    path: 'styles.css'
  })
  assert.equal(file.data.files.length, 1)
  assert.equal(file.data.files[0].content, 'body{}')
})

test('sites_update_code bloquea confirmación ausente y revisiones obsoletas', async () => {
  const codeTool = tool('sites_update_code')
  const args = {
    siteId: 'site_1',
    expectedRevision: `sha256:${'0'.repeat(64)}`,
    files: [{ path: '', content: '<h1>Nuevo</h1>' }],
    idempotencyKey: 'update-code-001'
  }
  await assert.rejects(
    () => codeTool.execute(recorder().context, args),
    (error) => error.code === 'confirmation_required'
  )

  const staleRecorder = recorder({
    success: true,
    data: {
      siteId: 'site_1',
      updatedAt: 'rev-2',
      codeFiles: [{ path: '', content: '<h1>Otro</h1>' }]
    }
  })
  await assert.rejects(
    () => codeTool.execute(staleRecorder.context, { ...args, confirm: true }),
    (error) => error.status === 409 && error.code === 'site_code_revision_conflict'
  )
  assert.equal(staleRecorder.calls.length, 1)
  assert.equal(staleRecorder.calls[0].handler, 'getImportedSiteMappingHandler')
})

test('sites_update_code hace preflight y luego usa el controller canónico', async () => {
  const revisionDate = new Date('2026-07-21T10:00:00.000Z')
  const currentFiles = [{ path: '', content: '<h1>Anterior</h1>' }]
  const codeRecorder = recorder((_handler, _request, callNumber) => {
    if (callNumber === 1) {
      return {
        success: true,
        data: { siteId: 'site_1', updatedAt: revisionDate, codeFiles: currentFiles }
      }
    }
    return {
      success: true,
      data: {
        site: { id: 'site_1' },
        import: {
          id: 'import_1',
          siteId: 'site_1',
          updatedAt: 'rev-2',
          codeFiles: [{ path: '', content: '<h1>Nuevo</h1>', sizeBytes: 14 }]
        }
      }
    }
  })

  const result = await tool('sites_update_code').execute(codeRecorder.context, {
    siteId: 'site_1',
    expectedRevision: codeRevision(currentFiles),
    files: [{ path: '', content: '<h1>Nuevo</h1>' }],
    confirm: true,
    idempotencyKey: 'update-code-002'
  })

  assert.deepEqual(codeRecorder.calls.map((entry) => entry.handler), [
    'getImportedSiteMappingHandler',
    'updateImportedSiteCodeFilesHandler'
  ])
  assert.deepEqual(codeRecorder.calls[1].request.body, {
    expectedRevision: codeRevision(currentFiles),
    responseMode: 'compact',
    files: [{ path: '', content: '<h1>Nuevo</h1>' }]
  })
  assert.equal(result.data.revision, codeRevision([{ path: '', content: '<h1>Nuevo</h1>', sizeBytes: 14 }]))
  assert.equal('content' in result.data.files[0], false)
})

test('publicar, retirar y archivar sólo envían el estado explícito', async () => {
  for (const [name, status] of [
    ['sites_publish', 'published'],
    ['sites_unpublish', 'draft'],
    ['sites_archive', 'archived']
  ]) {
    const stateRecorder = recorder()
    await tool(name).execute(stateRecorder.context, {
      siteId: 'site_1',
      confirm: true,
      idempotencyKey: `${name}-001`
    })
    assert.equal(stateRecorder.calls[0].handler, 'updateSiteHandler')
    assert.deepEqual(stateRecorder.calls[0].request.body, { status })
  }
})

test('las acciones destructivas exigen confirmación antes de tocar controllers', async () => {
  for (const [name, args] of [
    ['sites_delete', { siteId: 'site_1' }],
    ['sites_delete_block', { siteId: 'site_1', blockId: 'block_1' }],
    ['sites_delete_content_asset', { siteId: 'site_1', bindingId: 'binding_1' }],
    ['sites_remove_public_domain', { domainId: 'domain_1' }]
  ]) {
    const destructiveRecorder = recorder()
    await assert.rejects(
      () => tool(name).execute(destructiveRecorder.context, {
        ...args,
        idempotencyKey: `${name}-001`
      }),
      (error) => error.code === 'confirmation_required'
    )
    assert.equal(destructiveRecorder.calls.length, 0)
  }
})

test('dominios sólo aceptan hostname y se delegan a los handlers administrados', async () => {
  const addRecorder = recorder()
  await tool('sites_add_public_domain').execute(addRecorder.context, {
    domain: 'www.example.com',
    siteId: 'site_1',
    confirm: true,
    idempotencyKey: 'domain-add-001'
  })
  assert.equal(addRecorder.calls[0].handler, 'createSitesPublicDomainHandler')
  assert.deepEqual(addRecorder.calls[0].request.body, {
    domain: 'www.example.com',
    siteId: 'site_1',
    pageId: undefined
  })

  const routeRecorder = recorder()
  await tool('sites_set_domain_default_route').execute(routeRecorder.context, {
    domainId: 'domain_1',
    siteId: 'site_1',
    pageId: 'page_1',
    confirm: true,
    idempotencyKey: 'domain-route-001'
  })
  assert.equal(routeRecorder.calls[0].handler, 'setSitesPublicDomainDefaultRouteHandler')

  const verifyTool = tool('sites_verify_public_domain')
  const blockedVerify = recorder()
  await assert.rejects(
    () => verifyTool.execute(blockedVerify.context, {
      domainId: 'domain_1',
      idempotencyKey: 'domain-verify-001'
    }),
    (error) => error.code === 'confirmation_required'
  )
  assert.equal(blockedVerify.calls.length, 0)

  const verifyRecorder = recorder()
  await verifyTool.execute(verifyRecorder.context, {
    domainId: 'domain_1',
    confirm: true,
    idempotencyKey: 'domain-verify-002'
  })
  assert.equal(verifyRecorder.calls[0].handler, 'verifySitesPublicDomainByIdHandler')
})
