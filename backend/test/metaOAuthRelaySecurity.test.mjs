import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import { handleMetaInstallerRelayWebhook } from '../src/controllers/webhooksController.js'
import { processMetaSocialWebhook } from '../src/services/metaSocialMessagingService.js'

async function snapshotRows(table) {
  const rows = await db.all(`SELECT * FROM ${table}`).catch(() => [])
  return async () => {
    await db.run(`DELETE FROM ${table}`).catch(() => undefined)
    for (const row of rows) {
      const columns = Object.keys(row)
      await db.run(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map(column => row[column])
      )
    }
  }
}

function responseRecorder() {
  const state = { status: 200, body: null }
  return {
    status(code) { state.status = code; return this },
    json(body) { state.body = body; return this },
    get state() { return state }
  }
}

function signedRequest({ payload, nonce, deliveryId, secret, installationId }) {
  const rawBody = JSON.stringify(payload)
  const timestamp = String(Date.now())
  const signature = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${rawBody}`).digest('hex')
  const headers = {
    'x-ristak-signature': signature,
    'x-ristak-timestamp': timestamp,
    'x-ristak-nonce': nonce,
    'x-ristak-installation-id': installationId,
    'x-ristak-delivery-id': deliveryId
  }
  return {
    body: payload,
    rawBody,
    headers,
    get(name) { return headers[String(name).toLowerCase()] || '' }
  }
}

test('relay Meta exige HMAC, activo correcto e idempotencia; webhook directo forjado falla cerrado', async () => {
  await initializeMasterKey()
  const tables = [
    'meta_config', 'whatsapp_meta_direct_nonces', 'meta_installer_relay_deliveries',
    'meta_social_webhook_events'
  ]
  const restores = []
  for (const table of tables) restores.push(await snapshotRows(table))
  const appRows = await db.all(
    "SELECT * FROM app_config WHERE config_key IN ('license_key','installation_id','meta_oauth_relay_last_received_at')"
  )
  const secret = 'relay-license-secret'
  const installationId = 'installation-relay-test'
  try {
    for (const table of tables) await db.run(`DELETE FROM ${table}`)
    await setAppConfig('license_key', secret)
    await setAppConfig('installation_id', installationId)
    await db.run(`
      INSERT INTO meta_config (
        ad_account_id, access_token, connection_mode, page_id, instagram_account_id,
        oauth_connected, oauth_validated, oauth_relay_status
      ) VALUES (?, ?, 'oauth_bisu', 'page-1', 'ig-1', 1, 1, 'registered')
    `, ['123', encrypt('oauth-token')])

    const payload = { object: 'page', entry: [{ id: 'page-1', time: 1, messaging: [] }] }
    const firstReq = signedRequest({
      payload, nonce: 'nonce-first', deliveryId: 'delivery-1', secret, installationId
    })
    const firstRes = responseRecorder()
    await handleMetaInstallerRelayWebhook(firstReq, firstRes)
    assert.equal(firstRes.state.status, 200)
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM meta_social_webhook_events")).n, 1)

    const replayRes = responseRecorder()
    await handleMetaInstallerRelayWebhook(firstReq, replayRes)
    assert.equal(replayRes.state.status, 401)

    const duplicateReq = signedRequest({
      payload, nonce: 'nonce-retry', deliveryId: 'delivery-1', secret, installationId
    })
    const duplicateRes = responseRecorder()
    await handleMetaInstallerRelayWebhook(duplicateReq, duplicateRes)
    assert.equal(duplicateRes.state.status, 200)
    assert.equal(duplicateRes.state.body.duplicate, true)
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM meta_social_webhook_events")).n, 1)

    const mismatchPayload = { object: 'page', entry: [{ id: 'other-page', messaging: [] }] }
    const mismatchRes = responseRecorder()
    await handleMetaInstallerRelayWebhook(signedRequest({
      payload: mismatchPayload, nonce: 'nonce-mismatch', deliveryId: 'delivery-2', secret, installationId
    }), mismatchRes)
    assert.equal(mismatchRes.state.status, 403)
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM meta_social_webhook_events")).n, 1)

    const unsupportedRes = responseRecorder()
    await handleMetaInstallerRelayWebhook(signedRequest({
      payload: { object: 'whatsapp_business_account', entry: [{ id: 'page-1' }] },
      nonce: 'nonce-unsupported', deliveryId: 'delivery-unsupported', secret, installationId
    }), unsupportedRes)
    assert.equal(unsupportedRes.state.status, 400)

    await db.run(
      `INSERT INTO meta_installer_relay_deliveries (id, status, updated_at)
       VALUES ('delivery-stale', 'processing', datetime('now', '-3 minutes'))`
    )
    const staleRes = responseRecorder()
    await handleMetaInstallerRelayWebhook(signedRequest({
      payload, nonce: 'nonce-stale', deliveryId: 'delivery-stale', secret, installationId
    }), staleRes)
    assert.equal(staleRes.state.status, 200)
    assert.equal((await db.get("SELECT status FROM meta_installer_relay_deliveries WHERE id = 'delivery-stale'")).status, 'completed')

    await db.run(
      `INSERT INTO meta_installer_relay_deliveries (id, status)
       VALUES ('delivery-busy', 'processing')`
    )
    const busyRes = responseRecorder()
    await handleMetaInstallerRelayWebhook(signedRequest({
      payload, nonce: 'nonce-busy', deliveryId: 'delivery-busy', secret, installationId
    }), busyRes)
    assert.equal(busyRes.state.status, 409)
    assert.equal(busyRes.state.body.retryable, true)

    await assert.rejects(
      () => processMetaSocialWebhook({ payload, rawBody: JSON.stringify(payload), signatureHeader: '' }),
      error => error.statusCode === 401
    )

    await db.run('DELETE FROM meta_config')
    await db.run(
      `INSERT INTO meta_config (ad_account_id, access_token, connection_mode, page_id)
       VALUES ('123', ?, 'manual_system_user', 'page-1')`,
      [encrypt('manual-token')]
    )
    await assert.doesNotReject(
      () => processMetaSocialWebhook({ payload, rawBody: JSON.stringify(payload), signatureHeader: '' })
    )
    await db.run('UPDATE meta_config SET app_secret = ?', [encrypt('manual-app-secret')])
    await assert.rejects(
      () => processMetaSocialWebhook({ payload, rawBody: JSON.stringify(payload), signatureHeader: 'sha256=forged' }),
      error => error.statusCode === 401
    )
  } finally {
    await db.run("DELETE FROM app_config WHERE config_key IN ('license_key','installation_id','meta_oauth_relay_last_received_at')")
    for (const row of appRows) await setAppConfig(row.config_key, row.config_value)
    for (const restore of restores.reverse()) await restore()
  }
})
