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
