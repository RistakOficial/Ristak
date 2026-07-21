import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import express from 'express'
import { databaseReady, db, getAppConfig } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import centralBrokerRoutes from '../src/routes/centralBroker.routes.js'
import {
  CENTRAL_BROKER_CONFIG_KEYS,
  ensureCentralBrokerRegistration,
  getStoredCentralBrokerConfig,
  resetCentralBrokerStateForTests
} from '../src/services/centralBrokerService.js'

let tenantServer
let brokerServer
let tenantBaseUrl
let brokerBaseUrl
let registrationRequests = 0

const MANAGED_KEYS = [
  'LICENSE_SERVER_URL', 'RISTAK_LICENSE_SERVER_URL',
  'CLIENT_ID', 'RISTAK_CLIENT_ID',
  'LICENSE_KEY', 'RISTAK_LICENSE_KEY',
  'INSTALLATION_ID', 'RISTAK_INSTALLATION_ID'
]

function normalizePem(value) {
  return crypto.createPublicKey(value).export({ type: 'spki', format: 'pem' }).toString().trim()
}

function proofManifest({ challenge, appUrl, publicKey }) {
  const normalizedKey = normalizePem(publicKey)
  const fingerprint = crypto.createHash('sha256').update(normalizedKey).digest('hex')
  return ['ristak-broker-registration-v1', challenge, new URL(appUrl).origin, fingerprint].join('\n')
}

before(async () => {
  await databaseReady
  await initializeMasterKey()

  const tenantApp = express()
  tenantApp.set('trust proxy', true)
  tenantApp.use(express.json())
  tenantApp.use('/api/central-broker', centralBrokerRoutes)
  tenantApp.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message })
  })
  tenantServer = http.createServer(tenantApp)
  await new Promise(resolve => tenantServer.listen(0, '127.0.0.1', resolve))
  tenantBaseUrl = `http://127.0.0.1:${tenantServer.address().port}`

  const brokerApp = express()
  brokerApp.use(express.json())
  brokerApp.post('/api/broker/register', async (req, res) => {
    registrationRequests += 1
    const challenge = crypto.randomBytes(32).toString('base64url')
    const proofResponse = await fetch(`${req.body.app_url}/api/central-broker/registration-proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 'ristak-broker-registration-v1',
        challenge,
        app_url: req.body.app_url,
        public_key: req.body.public_key
      })
    })
    const proof = await proofResponse.json()
    assert.equal(proofResponse.status, 200)
    assert.equal(normalizePem(proof.public_key), normalizePem(req.body.public_key))
    assert.equal(crypto.verify(
      null,
      Buffer.from(proofManifest({ challenge, appUrl: req.body.app_url, publicKey: req.body.public_key })),
      crypto.createPublicKey(req.body.public_key),
      Buffer.from(proof.signature, 'base64url')
    ), true)

    res.json({
      success: true,
      registration: {
        mode: 'standalone_broker',
        client_id: 'broker_cli_test',
        installation_id: 'broker_inst_test',
        license_key: 'RSTK-BROKER-SECRET'
      }
    })
  })
  brokerServer = http.createServer(brokerApp)
  await new Promise(resolve => brokerServer.listen(0, '127.0.0.1', resolve))
  brokerBaseUrl = `http://127.0.0.1:${brokerServer.address().port}`
})

after(() => {
  tenantServer?.closeAllConnections?.()
  tenantServer?.close()
  brokerServer?.closeAllConnections?.()
  brokerServer?.close()
  delete process.env.CENTRAL_BROKER_URL
  delete process.env.RENDER_EXTERNAL_URL
})

beforeEach(async () => {
  for (const key of MANAGED_KEYS) delete process.env[key]
  process.env.CENTRAL_BROKER_URL = brokerBaseUrl
  process.env.RENDER_EXTERNAL_URL = tenantBaseUrl
  registrationRequests = 0
  resetCentralBrokerStateForTests()
  await db.run(
    'DELETE FROM app_config WHERE config_key IN (?, ?)',
    [CENTRAL_BROKER_CONFIG_KEYS.identity, CENTRAL_BROKER_CONFIG_KEYS.registration]
  )
})

test('genera identidad, demuestra control de URL y guarda credenciales cifradas', async () => {
  const first = await ensureCentralBrokerRegistration({ appUrl: tenantBaseUrl })
  const second = await ensureCentralBrokerRegistration({ appUrl: tenantBaseUrl })

  assert.deepEqual(second, first)
  assert.equal(first.mode, 'standalone_broker')
  assert.equal(first.clientId, 'broker_cli_test')
  assert.equal(first.installationId, 'broker_inst_test')
  assert.equal(first.licenseKey, 'RSTK-BROKER-SECRET')
  assert.equal(registrationRequests, 1)

  const stored = await getStoredCentralBrokerConfig()
  assert.deepEqual(stored, first)
  const encryptedIdentity = await getAppConfig(CENTRAL_BROKER_CONFIG_KEYS.identity)
  const encryptedRegistration = await getAppConfig(CENTRAL_BROKER_CONFIG_KEYS.registration)
  assert.ok(encryptedIdentity)
  assert.ok(encryptedRegistration)
  assert.equal(encryptedIdentity.includes('PRIVATE KEY'), false)
  assert.equal(encryptedRegistration.includes(first.licenseKey), false)
})

test('la ruta de prueba no firma un origen distinto al que recibió la solicitud', async () => {
  const identityRegistration = ensureCentralBrokerRegistration({ appUrl: tenantBaseUrl })
  await identityRegistration
  const storedIdentity = await getAppConfig(CENTRAL_BROKER_CONFIG_KEYS.identity)
  assert.ok(storedIdentity)

  const response = await fetch(`${tenantBaseUrl}/api/central-broker/registration-proof`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 'ristak-broker-registration-v1',
      challenge: crypto.randomBytes(32).toString('base64url'),
      app_url: `http://localhost:${tenantServer.address().port}`,
      public_key: 'not-needed-for-origin-rejection'
    })
  })
  const body = await response.json()
  assert.equal(response.status, 403)
  assert.equal(body.code, 'central_broker_origin_mismatch')
})
