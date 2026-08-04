import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import test, { after, before } from 'node:test'
import express from 'express'

import { databaseReady, db, setAppConfig } from '../src/config/database.js'
import { __mcpRegistryTestHooks } from '../src/mcp/toolRegistry.js'
import installerCustomerOperationsRoutes from '../src/routes/installerCustomerOperations.routes.js'

const fixture = {
  server: null,
  origin: '',
  installationId: `inst_customer_ops_${crypto.randomBytes(8).toString('hex')}`,
  licenseKey: `RSTK-CUSTOMER-OPS-${crypto.randomBytes(8).toString('hex')}`,
  userId: null,
  email: `installer-customer-ops-${crypto.randomUUID()}@example.test`
}

function signatureHeaders(rawBody, nonce = crypto.randomUUID()) {
  const timestamp = String(Date.now())
  const signature = crypto
    .createHmac('sha256', fixture.licenseKey)
    .update(`${timestamp}.${nonce}.${rawBody}`)
    .digest('hex')
  return {
    'X-Ristak-Signature': signature,
    'X-Ristak-Timestamp': timestamp,
    'X-Ristak-Nonce': nonce,
    'X-Ristak-Installation-Id': fixture.installationId
  }
}

async function signedRequest(payload, { nonce } = {}) {
  const rawBody = JSON.stringify(payload)
  const response = await fetch(`${fixture.origin}/api/internal/customer-operations/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...signatureHeaders(rawBody, nonce)
    },
    body: rawBody
  })
  return {
    status: response.status,
    data: await response.json()
  }
}

before(async () => {
  await databaseReady
  await db.exec(await readFile(
    new URL('../migrations/versioned/129_mcp_oauth_control_plane.sqlite.sql', import.meta.url),
    'utf8'
  ))
  const inserted = await db.run(
    `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
     VALUES (?, ?, 'not-used', 'Installer Support Actor', 'admin', 1)`,
    [fixture.email, fixture.email]
  )
  fixture.userId = inserted.lastID
  await setAppConfig('license_key', fixture.licenseKey)
  await setAppConfig('installation_id', fixture.installationId)

  const app = express()
  app.set('trust proxy', 1)
  app.use('/api/internal/customer-operations', express.json({
    limit: '3mb',
    verify: (req, _res, buffer) => {
      req.rawBody = buffer.toString('utf8')
    }
  }))
  app.use('/api/internal/customer-operations', installerCustomerOperationsRoutes)
  fixture.server = http.createServer(app)
  await new Promise((resolve, reject) => {
    fixture.server.once('error', reject)
    fixture.server.listen(0, '127.0.0.1', resolve)
  })
  fixture.origin = `http://127.0.0.1:${fixture.server.address().port}`
  process.env.RENDER_EXTERNAL_URL = fixture.origin
})

after(async () => {
  await db.run('DELETE FROM mcp_audit_log WHERE actor_user_id = ?', [fixture.userId]).catch(() => undefined)
  await db.run('DELETE FROM mcp_idempotency_keys WHERE user_id = ?', [fixture.userId]).catch(() => undefined)
  await db.run('DELETE FROM oauth_grants WHERE user_id = ?', [fixture.userId]).catch(() => undefined)
  await db.run('DELETE FROM oauth_clients WHERE client_id = ?', ['client_ristak_installer_customer_operations']).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE email = ?', [fixture.email]).catch(() => undefined)
  await db.run('DELETE FROM users WHERE id = ?', [fixture.userId]).catch(() => undefined)
  await db.run("DELETE FROM app_config WHERE config_key IN ('license_key', 'installation_id')").catch(() => undefined)
  delete process.env.RENDER_EXTERNAL_URL
  if (fixture.server) await new Promise(resolve => fixture.server.close(resolve))
})

test('la delegación firmada lista el MCP real sin exigir Developers y conserva los módulos de negocio', async () => {
  const response = await signedRequest({
    operator: { id: 'admin_installer_1', email: 'soporte@ristak.test' },
    scopes: ['ristak.read', 'ristak.write', 'ristak.execute'],
    message: { jsonrpc: '2.0', id: 'list-1', method: 'tools/list', params: {} }
  })
  assert.equal(response.status, 200)
  const names = new Set(response.data.result.tools.map(tool => tool.name))
  assert.equal(names.has('mcp_search_capabilities'), true)
  assert.equal(names.has('contacts_create'), true)
  assert.equal(names.has('appointments_create'), true)
  assert.equal(names.has('contacts_archive'), false, 'no debe anunciar destructivas sin scope')

  const controlSpec = __mcpRegistryTestHooks.allSpecs.find(spec => spec.name === 'mcp_search_capabilities')
  const contactSpec = __mcpRegistryTestHooks.allSpecs.find(spec => spec.name === 'contacts_create')
  assert.deepEqual(
    __mcpRegistryTestHooks.enforcedModulePolicies({ supportDelegation: true }, controlSpec),
    []
  )
  assert.deepEqual(
    __mcpRegistryTestHooks.enforcedModulePolicies({ supportDelegation: true }, contactSpec),
    [{ module: 'contacts', access: 'write' }]
  )
})

test('ejecuta escrituras con la misma idempotencia y auditoría del MCP funcional', async () => {
  const payload = {
    operator: { id: 'admin_installer_1', email: 'soporte@ristak.test' },
    scopes: ['ristak.read', 'ristak.write', 'ristak.execute'],
    message: {
      jsonrpc: '2.0',
      id: 'call-1',
      method: 'tools/call',
      params: {
        name: 'contacts_create',
        arguments: {
          full_name: 'Contacto desde soporte',
          email: fixture.email,
          source: 'installer_support',
          idempotencyKey: 'installer-support-contact-001'
        }
      }
    }
  }
  const first = await signedRequest(payload)
  assert.equal(first.status, 200)
  assert.notEqual(first.data.result.isError, true)

  const second = await signedRequest({
    ...payload,
    message: { ...payload.message, id: 'call-2' }
  })
  assert.equal(second.status, 200)
  assert.notEqual(second.data.result.isError, true)

  const contacts = await db.all('SELECT id FROM contacts WHERE email = ?', [fixture.email])
  assert.equal(contacts.length, 1, 'el reintento con la misma idempotencyKey no debe duplicar el contacto')
  const audit = await db.all(
    `SELECT client_id, tool_name, success, user_agent
     FROM mcp_audit_log WHERE actor_user_id = ? AND tool_name = 'contacts_create'
     ORDER BY id ASC`,
    [fixture.userId]
  )
  assert.equal(audit.length, 2)
  assert.ok(audit.every(row => row.client_id === 'client_ristak_installer_customer_operations'))
  assert.ok(audit.every(row => Number(row.success) === 1))
  assert.ok(audit.every(row => String(row.user_agent).includes('soporte@ristak.test')))
})

test('rechaza firmas repetidas antes de ejecutar otra operación', async () => {
  const nonce = crypto.randomUUID()
  const payload = {
    operator: { id: 'admin_installer_1', email: 'soporte@ristak.test' },
    scopes: ['ristak.read'],
    message: { jsonrpc: '2.0', id: 'ping-1', method: 'ping', params: {} }
  }
  const first = await signedRequest(payload, { nonce })
  assert.equal(first.status, 200)
  const replay = await signedRequest(payload, { nonce })
  assert.equal(replay.status, 401)
  assert.equal(replay.data.code, 'INSTALLER_SIGNATURE_REPLAY')
})
