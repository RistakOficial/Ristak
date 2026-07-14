import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import {
  claimInboundChatMessage,
  markChatContactReadForUser,
  recordInboundChatUnread
} from '../src/services/chatReadStateService.js'

test('recordInboundChatUnread actualiza todos los lectores activos en una sola operación atómica', async () => {
  const marker = randomUUID()
  const contactId = `chat_unread_${marker}`
  const activeUsername = `chat_active_${marker}`
  const inactiveUsername = `chat_inactive_${marker}`
  let activeUserId = null
  let inactiveUserId = null

  try {
    await db.run(`
      INSERT INTO users (username, password_hash, is_active)
      VALUES (?, ?, 1)
    `, [activeUsername, 'test-only-hash'])
    await db.run(`
      INSERT INTO users (username, password_hash, is_active)
      VALUES (?, ?, 0)
    `, [inactiveUsername, 'test-only-hash'])

    activeUserId = String((await db.get('SELECT id FROM users WHERE username = ?', [activeUsername])).id)
    inactiveUserId = String((await db.get('SELECT id FROM users WHERE username = ?', [inactiveUsername])).id)

    const first = await recordInboundChatUnread({
      contactId,
      messageTimestamp: '2099-07-10T10:00:00.000Z'
    })
    assert.ok(first.updated >= 1)

    await recordInboundChatUnread({
      contactId,
      messageTimestamp: '2099-07-10T10:01:00.000Z'
    })

    const activeAfterTwo = await db.get(`
      SELECT unread_count, last_unread_at
      FROM chat_read_states
      WHERE user_id = ? AND contact_id = ?
    `, [activeUserId, contactId])
    assert.equal(Number(activeAfterTwo?.unread_count), 2)
    assert.equal(new Date(activeAfterTwo?.last_unread_at).toISOString(), '2099-07-10T10:01:00.000Z')

    const inactiveState = await db.get(`
      SELECT unread_count
      FROM chat_read_states
      WHERE user_id = ? AND contact_id = ?
    `, [inactiveUserId, contactId])
    assert.equal(inactiveState, null)

    await markChatContactReadForUser({
      userId: activeUserId,
      contactId,
      readAt: '2099-07-10T10:02:00.000Z'
    })
    await recordInboundChatUnread({
      contactId,
      messageTimestamp: '2099-07-10T10:01:30.000Z'
    })

    const afterOlderMessage = await db.get(`
      SELECT unread_count
      FROM chat_read_states
      WHERE user_id = ? AND contact_id = ?
    `, [activeUserId, contactId])
    assert.equal(Number(afterOlderMessage?.unread_count), 0)

    const concurrentMessages = Array.from({ length: 8 }, (_, index) => (
      recordInboundChatUnread({
        contactId,
        messageTimestamp: `2099-07-10T10:03:${String(index).padStart(2, '0')}.000Z`
      })
    ))
    await Promise.all(concurrentMessages)

    const afterConcurrentMessages = await db.get(`
      SELECT unread_count, last_unread_at
      FROM chat_read_states
      WHERE user_id = ? AND contact_id = ?
    `, [activeUserId, contactId])
    assert.equal(Number(afterConcurrentMessages?.unread_count), 8)
    assert.equal(new Date(afterConcurrentMessages?.last_unread_at).toISOString(), '2099-07-10T10:03:07.000Z')
  } finally {
    await db.run('DELETE FROM chat_read_states WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM users WHERE username IN (?, ?)', [activeUsername, inactiveUsername]).catch(() => undefined)
  }
})

test('un mismo mensaje inbound concurrente reclama e incrementa unread una sola vez', async () => {
  const marker = randomUUID()
  const contactId = `chat_claim_${marker}`
  const liveMessageId = `wa_live_${marker}`
  const historyMessageId = `wa_history_${marker}`
  const username = `chat_claim_user_${marker}`
  let userId = null

  try {
    await db.run(`
      INSERT INTO users (username, password_hash, is_active)
      VALUES (?, ?, 1)
    `, [username, 'test-only-hash'])
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username])).id)

    const attempts = await Promise.all(Array.from({ length: 8 }, () => (
      claimInboundChatMessage({
        channel: 'whatsapp',
        messageId: liveMessageId,
        contactId,
        messageTimestamp: '2099-07-10T11:00:00.000Z'
      })
    )))

    assert.equal(attempts.filter(result => result.claimed).length, 1)
    const afterLive = await db.get(`
      SELECT unread_count
      FROM chat_read_states
      WHERE user_id = ? AND contact_id = ?
    `, [userId, contactId])
    assert.equal(Number(afterLive?.unread_count), 1)

    const historyClaim = await claimInboundChatMessage({
      channel: 'whatsapp',
      messageId: historyMessageId,
      contactId,
      messageTimestamp: '2099-07-10T10:00:00.000Z',
      incrementUnread: false
    })
    const repeatedAsLive = await claimInboundChatMessage({
      channel: 'whatsapp',
      messageId: historyMessageId,
      contactId,
      messageTimestamp: '2099-07-10T10:00:00.000Z'
    })

    assert.equal(historyClaim.claimed, true)
    assert.equal(repeatedAsLive.claimed, false)
    const afterHistory = await db.get(`
      SELECT unread_count
      FROM chat_read_states
      WHERE user_id = ? AND contact_id = ?
    `, [userId, contactId])
    assert.equal(Number(afterHistory?.unread_count), 1)
  } finally {
    await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM chat_read_states WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM users WHERE username = ?', [username]).catch(() => undefined)
  }
})

test('claimInboundChatMessage reutiliza la transacción inbound y rompe el ciclo de espera de la cola SQLite', async () => {
  const marker = randomUUID()
  const contactId = `chat_claim_tx_${marker}`
  const transactionMessageId = `wa_claim_tx_${marker}`
  const queuedMessageId = `wa_claim_queued_${marker}`
  const username = `chat_claim_tx_user_${marker}`
  let userId = null
  let transactionPromise = null
  let queuedClaimPromise = null

  const deferred = () => {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  }
  const transactionReady = deferred()
  const startTransactionClaim = deferred()
  const transactionClaimFinished = deferred()
  const releaseTransaction = deferred()

  const within = async (promise, timeoutMs) => {
    let timeout
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('el claim transaccional quedó atrapado detrás de la cola SQLite')), timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timeout)
    }
  }

  try {
    await db.run(`
      INSERT INTO users (username, password_hash, is_active)
      VALUES (?, ?, 1)
    `, [username, 'test-only-hash'])
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username])).id)

    transactionPromise = db.transaction(async (transactionDatabase) => {
      transactionReady.resolve()
      await startTransactionClaim.promise
      try {
        const claim = await claimInboundChatMessage({
          channel: 'whatsapp',
          messageId: transactionMessageId,
          contactId,
          messageTimestamp: '2099-07-10T12:00:00.000Z',
          database: transactionDatabase
        })
        transactionClaimFinished.resolve(claim)
        await releaseTransaction.promise
        return claim
      } catch (error) {
        transactionClaimFinished.reject(error)
        throw error
      }
    })

    await transactionReady.promise
    // Nace fuera del contexto de la transacción anterior: encabeza la cola
    // global y queda bloqueada por su BEGIN IMMEDIATE.
    queuedClaimPromise = claimInboundChatMessage({
      channel: 'whatsapp',
      messageId: queuedMessageId,
      contactId,
      messageTimestamp: '2099-07-10T12:01:00.000Z'
    })

    startTransactionClaim.resolve()
    const transactionClaim = await within(transactionClaimFinished.promise, 500)
    assert.equal(transactionClaim.claimed, true)

    releaseTransaction.resolve()
    const [committedTransactionClaim, queuedClaim] = await Promise.all([
      transactionPromise,
      queuedClaimPromise
    ])
    assert.equal(committedTransactionClaim.claimed, true)
    assert.equal(queuedClaim.claimed, true)
    assert.equal(
      await db.get(`
        SELECT unread_count
        FROM chat_read_states
        WHERE user_id = ? AND contact_id = ?
      `, [userId, contactId]).then(row => Number(row?.unread_count || 0)),
      2
    )
    assert.equal(
      await db.get(`
        SELECT COUNT(*) AS total
        FROM chat_inbound_message_claims
        WHERE channel = 'whatsapp' AND message_id IN (?, ?)
      `, [transactionMessageId, queuedMessageId]).then(row => Number(row?.total || 0)),
      2
    )
  } finally {
    startTransactionClaim.resolve()
    releaseTransaction.resolve()
    await transactionPromise?.catch(() => undefined)
    await queuedClaimPromise?.catch(() => undefined)
    await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM chat_read_states WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM users WHERE username = ?', [username]).catch(() => undefined)
  }
})
