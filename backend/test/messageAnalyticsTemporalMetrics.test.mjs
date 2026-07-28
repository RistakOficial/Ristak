import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { db } from '../src/config/database.js'
import {
  queryMessageAnalyticsPopulation,
  queryMessageAnalyticsProjectionAggregateRows,
  runMessageAnalyticsProjectionBackfill
} from '../src/services/messageAnalyticsProjectionService.js'
import { invalidateTimezoneCache } from '../src/utils/dateUtils.js'

async function runUntilReady() {
  let result
  for (let attempt = 0; attempt < 100; attempt += 1) {
    result = await runMessageAnalyticsProjectionBackfill({
      batchSize: 2,
      maxBackfillBatches: 1,
      maxQueueBatches: 1
    })
    if (result.ready) return
  }
  assert.fail(`La proyección de mensajes no convergió: ${JSON.stringify(result)}`)
}

test('mensajería separa volumen, actividad y primera conversación histórica', {
  concurrency: false,
  timeout: 30_000
}, async () => {
  await db.exec(await readFile(
    new URL('../migrations/versioned/114_message_analytics_projection.sqlite.sql', import.meta.url),
    'utf8'
  ))
  await db.exec(await readFile(
    new URL('../migrations/versioned/115_message_analytics_range_rollup.sqlite.sql', import.meta.url),
    'utf8'
  ))
  await db.exec(await readFile(
    new URL('../migrations/versioned/118_message_analytics_phone_projection.sqlite.sql', import.meta.url),
    'utf8'
  ))
  const prefix = `temporal_${randomUUID().replaceAll('-', '')}`
  const returningContact = `${prefix}_returning`
  const directContact = `${prefix}_direct`
  const paidContact = `${prefix}_paid`
  const instagramContact = `${prefix}_instagram`
  const hiddenRankContact = `${prefix}_hidden_rank`
  const visibleRankContact = `${prefix}_visible_rank`
  const sharedRankIdentity = `${prefix}_shared_rank_identity`
  const dayOne = '2203-04-01T10:00:00.000Z'
  const dayTwo = '2203-04-02T10:00:00.000Z'
  const selectedRange = {
    startUtc: '2203-04-02T00:00:00.000Z',
    endUtc: '2203-04-02T23:59:59.999Z',
    appliedTimezone: 'UTC'
  }

  await db.run(`
    INSERT INTO app_config(config_key, config_value, created_at, updated_at)
    VALUES ('account_timezone', 'UTC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO UPDATE SET
      config_value = excluded.config_value,
      updated_at = CURRENT_TIMESTAMP
  `)
  invalidateTimezoneCache()

  try {
    for (const contactId of [
      returningContact,
      directContact,
      paidContact,
      instagramContact,
      hiddenRankContact,
      visibleRankContact
    ]) {
      await db.run(`
        INSERT INTO contacts(id, full_name, source, created_at, updated_at)
        VALUES (?, 'Temporal metrics', NULL, ?, ?)
      `, [contactId, dayOne, dayOne])
    }

    await db.run(`
      INSERT INTO whatsapp_api_messages(
        id, contact_id, direction, message_type, message_timestamp,
        detected_source_url, detected_ctwa_clid, created_at, updated_at
      ) VALUES
        (?, ?, 'inbound', 'text', ?, NULL, NULL, ?, ?),
        (?, ?, 'inbound', 'text', ?, NULL, NULL, ?, ?),
        (?, ?, 'inbound', 'text', ?, 'https://facebook.com/profile', NULL, ?, ?),
        (?, ?, 'inbound', 'text', ?, NULL, 'ctwa-confirmed', ?, ?)
    `, [
      `${prefix}_returning_old`, returningContact, dayOne, dayOne, dayOne,
      `${prefix}_returning_active`, returningContact, dayTwo, dayTwo, dayTwo,
      `${prefix}_direct_url`, directContact, dayTwo, dayTwo, dayTwo,
      `${prefix}_paid_ctwa`, paidContact, dayTwo, dayTwo, dayTwo
    ])
    await db.run(`
      INSERT INTO meta_social_messages(
        id, platform, contact_id, sender_id, direction, message_type,
        message_timestamp, referral_json, created_at, updated_at
      ) VALUES (
        ?, 'instagram', ?, ?, 'inbound', 'text', ?,
        '{"headline":"Oferta","source_url":"https://instagram.com/p/demo"}', ?, ?
      )
    `, [
      `${prefix}_instagram_headline`,
      instagramContact,
      `${prefix}_sender`,
      dayTwo,
      dayTwo,
      dayTwo
    ])

    await runUntilReady()

    const aggregate = await queryMessageAnalyticsProjectionAggregateRows(selectedRange)
    assert.deepEqual(aggregate.metrics, {
      messages: 4,
      conversations: 4,
      newConversations: 3,
      attributedConversations: 1,
      allMessages: 4
    })
    assert.deepEqual(aggregate.trend, [{
      label: '2203-04-02',
      messages: 4,
      conversations: 4,
      newConversations: 3,
      attributedConversations: 1
    }])

    const whatsappOnly = await queryMessageAnalyticsProjectionAggregateRows(selectedRange, {
      filters: { channels: ['whatsapp'] }
    })
    assert.equal(whatsappOnly.metrics.messages, 3)
    assert.equal(whatsappOnly.metrics.conversations, 3)
    assert.equal(whatsappOnly.metrics.newConversations, 2)

    const population = await queryMessageAnalyticsPopulation(selectedRange, {
      population: 'conversations',
      dimension: 'entry'
    })
    assert.equal(population.total, 4)
    assert.equal(
      population.distribution.reduce((sum, item) => sum + item.value, 0),
      population.total
    )
    assert.deepEqual(
      Object.fromEntries(population.distribution.map(item => [item.key, item.value])),
      {
      'instagram.unattributed': 1,
      'whatsapp.paid_ad': 1,
      'whatsapp.unattributed': 2
      }
    )

    const newWhatsapp = await queryMessageAnalyticsPopulation(selectedRange, {
      population: 'newConversations',
      dimension: 'source',
      filters: { channels: ['whatsapp'] }
    })
    assert.equal(newWhatsapp.total, 2)
    assert.deepEqual(
      newWhatsapp.availableChannels,
      ['instagram', 'whatsapp'],
      'el catálogo de canales se calcula antes del filtro de canal'
    )

    const sourceScopedChannels = await queryMessageAnalyticsPopulation(selectedRange, {
      population: 'newConversations',
      dimension: 'channel',
      filters: {
        channels: ['whatsapp'],
        sources: ['Instagram']
      }
    })
    assert.equal(sourceScopedChannels.total, 0)
    assert.deepEqual(
      sourceScopedChannels.availableChannels,
      ['instagram'],
      'el catálogo conserva el filtro de fuente aunque quite temporalmente el canal'
    )

    const visibleChannels = await queryMessageAnalyticsPopulation(selectedRange, {
      population: 'newConversations',
      dimension: 'channel',
      filters: { channels: ['whatsapp'] },
      hiddenFilters: [{ text: instagramContact, type: 'exact' }]
    })
    assert.deepEqual(
      visibleChannels.availableChannels,
      ['whatsapp'],
      'los contactos ocultos tampoco reaparecen como canales históricos'
    )

    const state = await db.get(`
      SELECT active_generation
      FROM message_analytics_projection_state
      WHERE singleton_id = 1
    `)
    await db.run(`
      INSERT INTO message_analytics_daily_identity(
        generation, business_date, channel, source, identity_key, contact_key,
        contact_id, channel_label, message_count, attributed_message_count,
        first_occurred_at, first_source_kind, first_source_message_id, updated_at
      ) VALUES
        (?, '2203-04-02', 'whatsapp', 'Rank fixture', ?, ?, ?,
         'WhatsApp', 1, 0, '2203-04-02T08:00:00.000Z', 'whatsapp', ?, CURRENT_TIMESTAMP),
        (?, '2203-04-02', 'email', 'Rank fixture', ?, ?, ?,
         'Email', 1, 0, '2203-04-02T09:00:00.000Z', 'email', ?, CURRENT_TIMESTAMP)
    `, [
      Number(state.active_generation),
      sharedRankIdentity,
      hiddenRankContact,
      hiddenRankContact,
      `${prefix}_hidden_rank_message`,
      Number(state.active_generation),
      sharedRankIdentity,
      visibleRankContact,
      visibleRankContact,
      `${prefix}_visible_rank_message`
    ])
    const hiddenBeforeRanking = await queryMessageAnalyticsPopulation(selectedRange, {
      population: 'conversations',
      dimension: 'channel',
      filters: { sources: ['Rank fixture'] },
      hiddenFilters: [{ text: hiddenRankContact, type: 'exact' }]
    })
    assert.equal(hiddenBeforeRanking.total, 1)
    assert.deepEqual(
      hiddenBeforeRanking.distribution.map(item => [item.key, item.value]),
      [['email', 1]],
      'la fila oculta se excluye antes de elegir la primera fila visible de la identidad'
    )
    assert.deepEqual(hiddenBeforeRanking.trend, [{ label: '2203-04-02', value: 1 }])
    assert.equal(
      hiddenBeforeRanking.trend.reduce((sum, item) => sum + item.value, 0),
      hiddenBeforeRanking.total,
      'la corrección hidden no debe restar del trend una identidad que aún tiene fila visible'
    )

    const evidenceRows = await db.all(`
      SELECT source_message_id, attributed
      FROM message_analytics_fact
      WHERE generation = ? AND source_message_id LIKE ?
    `, [Number(state.active_generation), `${prefix}%`])
    const evidence = Object.fromEntries(evidenceRows.map(row => [
      row.source_message_id,
      row.attributed === true || Number(row.attributed) === 1
    ]))
    assert.equal(evidence[`${prefix}_direct_url`], false)
    assert.equal(evidence[`${prefix}_instagram_headline`], false)
    assert.equal(evidence[`${prefix}_paid_ctwa`], true)
  } finally {
    await db.run(
      'DELETE FROM message_analytics_daily_identity WHERE identity_key = ?',
      [sharedRankIdentity]
    ).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
    await db.run('DELETE FROM meta_social_messages WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  }
})
