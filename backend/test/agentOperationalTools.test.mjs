import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { searchAds } from '../src/agents/tools/adsTools.js'
import { addContactPhoneNumber } from '../src/agents/tools/contactTools.js'
import {
  applyManualBusinessExpenseAdjustment,
  listManualBusinessExpenseRecords
} from '../src/agents/tools/expenseTools.js'
import { listInboxMessages } from '../src/agents/tools/messageTools.js'

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function assertBusinessUserText(text) {
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 20)
  assert.doesNotMatch(text, /\b(mode|replace|add|clear|override|periodType|resetChildren|manualBusinessExpenses|payload|schema|query|tool)\b/i)
  assert.doesNotMatch(text, /gasto manual/i)
}

test('agente de anuncios busca campañas, conjuntos y anuncios por nombre o ID', async () => {
  const marker = uniqueId('agent_ads_search')
  const campaignId = `${marker}_campaign`
  const adsetId = `${marker}_adset`
  const adId = `${marker}_ad`

  try {
    await db.run(
      `INSERT INTO meta_ads (
        date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
        ad_id, ad_name, spend, reach, clicks, cpc, cpm, ctr
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        '2099-02-10',
        'act_agent_tools',
        campaignId,
        `Campaña ${marker}`,
        adsetId,
        `Conjunto ${marker}`,
        adId,
        `Anuncio ${marker}`,
        345.67,
        1200,
        42,
        8.23,
        15.5,
        3.5
      ]
    )

    const result = await searchAds({
      query: marker,
      startDate: '2099-02-01',
      endDate: '2099-02-28',
      entity: 'all',
      limit: 10
    })

    assert.equal(result.ok, true)
    assert.deepEqual(
      result.results.map((row) => row.entityType).sort(),
      ['ad', 'adset', 'campaign']
    )
    assert.ok(result.results.every((row) => row.spend === 345.67))
    assert.ok(result.results.some((row) => row.adId === adId))
  } finally {
    await db.run('DELETE FROM meta_ads WHERE campaign_id = ?', [campaignId]).catch(() => undefined)
  }
})

test('agente de contactos agrega teléfonos sin reemplazar y puede promover uno a principal', async () => {
  const contactId = uniqueId('rstk_contact_agent_phone')
  const originalPhone = `+52155510${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`
  const extraPhone = `+52155520${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`
  const primaryPhone = `+52155530${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, full_name, email, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, originalPhone, 'Cliente Teléfono Agente', `${contactId}@example.test`, 'test']
    )

    const added = await addContactPhoneNumber({
      contactId,
      phone: extraPhone,
      label: 'WhatsApp alterno',
      isPrimary: false
    })

    assert.equal(added.ok, true)
    assert.equal(added.isPrimary, false)
    let contact = await db.get('SELECT phone FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.phone, originalPhone)

    const promoted = await addContactPhoneNumber({
      contactId,
      phone: primaryPhone,
      label: 'Principal nuevo',
      isPrimary: true
    })

    assert.equal(promoted.ok, true)
    assert.equal(promoted.isPrimary, true)
    contact = await db.get('SELECT phone FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.phone, promoted.phone)
    assert.ok(promoted.phones.some((row) => row.phone === promoted.phone && row.isPrimary))
    assert.ok(promoted.phones.some((row) => row.phone === added.phone && !row.isPrimary))
  } finally {
    await db.run('DELETE FROM contact_phone_numbers WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('agente de costos variables suma, reemplaza y borra gastos manuales mensuales con confirmación', async () => {
  const periodStart = '2099-08-01'

  try {
    await db.run(
      'DELETE FROM report_manual_business_expenses WHERE period_type = ? AND period_start = ?',
      ['month', periodStart]
    )

    const denied = await applyManualBusinessExpenseAdjustment({
      periodType: 'month',
      periodStart,
      amount: 1000,
      mode: 'replace',
      confirm: false
    })
    assert.equal(denied.ok, false)

    const replaced = await applyManualBusinessExpenseAdjustment({
      periodType: 'month',
      periodStart,
      amount: 1000,
      mode: 'replace',
      confirm: true
    })
    assert.equal(replaced.ok, true)
    assert.equal(replaced.previousAmount, 0)
    assert.equal(replaced.newAmount, 1000)
    assertBusinessUserText(replaced.userMessage)
    assert.match(replaced.userMessage, /gastos del negocio/i)
    assert.match(replaced.userMessage, /agosto de 2099/i)

    const added = await applyManualBusinessExpenseAdjustment({
      periodType: 'month',
      periodStart,
      amount: 250.75,
      mode: 'add',
      confirm: true
    })
    assert.equal(added.previousAmount, 1000)
    assert.equal(added.newAmount, 1250.75)
    assert.equal(added.amountDelta, 250.75)
    assertBusinessUserText(added.userMessage)

    const listed = await listManualBusinessExpenseRecords({
      periodType: 'month',
      startDate: '2099-08-01',
      endDate: '2099-08-31'
    })
    assert.equal(listed.ok, true)
    assert.equal(listed.total, 1)
    assert.equal(listed.expenses[0].amount, 1250.75)
    assert.equal(listed.effectiveTotal, 1250.75)
    assertBusinessUserText(listed.userSummary)

    const zeroed = await applyManualBusinessExpenseAdjustment({
      periodType: 'month',
      periodStart,
      amount: 0,
      mode: 'replace',
      confirm: true
    })
    assert.equal(zeroed.ok, true)
    assert.equal(zeroed.newAmount, 0)
    assertBusinessUserText(zeroed.userMessage)

    const zeroRow = await db.get(
      'SELECT amount FROM report_manual_business_expenses WHERE period_type = ? AND period_start = ?',
      ['month', periodStart]
    )
    assert.equal(Number(zeroRow?.amount), 0)

    const cleared = await applyManualBusinessExpenseAdjustment({
      periodType: 'month',
      periodStart,
      mode: 'clear',
      confirm: true
    })
    assert.equal(cleared.ok, true)
    assert.equal(cleared.newAmount, 0)
    assertBusinessUserText(cleared.userMessage)
  } finally {
    await db.run(
      'DELETE FROM report_manual_business_expenses WHERE period_type = ? AND period_start = ?',
      ['month', periodStart]
    ).catch(() => undefined)
  }
})

test('agente de mensajes lista bandeja multicanal y filtra por contacto o texto', async () => {
  const marker = uniqueId('agent_inbox')
  const contactId = uniqueId('rstk_contact_agent_inbox')
  const metaContactId = `${marker}_meta_contact`
  const whatsappContactId = `${marker}_whatsapp_contact`

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, full_name, email, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `+5215599${marker.slice(-6)}`, `Cliente Inbox ${marker}`, `${marker}@example.test`, 'test']
    )
    await db.run(
      `INSERT INTO whatsapp_api_contacts (id, contact_id, phone, profile_name, message_count)
       VALUES (?, ?, ?, ?, ?)`,
      [whatsappContactId, contactId, '+5215500000000', `WhatsApp ${marker}`, 1]
    )
    await db.run(
      `INSERT INTO whatsapp_api_messages (id, whatsapp_api_contact_id, contact_id, phone, direction, message_type, message_text, status, message_timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`${marker}_wa_msg`, whatsappContactId, contactId, '+5215500000000', 'inbound', 'text', `Hola desde WhatsApp ${marker}`, 'received', '2099-04-01T10:00:00Z']
    )
    await db.run(
      `INSERT INTO meta_social_contacts (id, contact_id, platform, sender_id, profile_name, username, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [metaContactId, contactId, 'instagram', `${marker}_sender`, `Instagram ${marker}`, `ig_${marker}`, 1]
    )
    await db.run(
      `INSERT INTO meta_social_messages (id, platform, meta_social_contact_id, contact_id, sender_id, direction, message_type, message_text, status, message_timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`${marker}_ig_msg`, 'instagram', metaContactId, contactId, `${marker}_sender`, 'inbound', 'text', `DM de Instagram ${marker}`, 'received', '2099-04-02T10:00:00Z']
    )
    await db.run(
      `INSERT INTO email_messages (id, contact_id, direction, status, from_email, to_email, subject, message_text, message_timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`${marker}_email_msg`, contactId, 'inbound', 'received', `${marker}@client.test`, 'ventas@example.test', `Asunto ${marker}`, `Correo entrante ${marker}`, '2099-04-03T10:00:00Z']
    )

    const all = await listInboxMessages({ query: marker, direction: 'inbound', limit: 10 })
    assert.equal(all.ok, true)
    assert.equal(all.total, 3)
    assert.deepEqual(all.messages.map((message) => message.channel), ['email', 'instagram', 'whatsapp'])
    assert.ok(all.messages.every((message) => message.contactId === contactId))

    const whatsappOnly = await listInboxMessages({ channel: 'whatsapp', contactId, direction: 'inbound', limit: 10 })
    assert.equal(whatsappOnly.total, 1)
    assert.equal(whatsappOnly.messages[0].text, `Hola desde WhatsApp ${marker}`)

    const unreadApproximation = await listInboxMessages({ query: marker, unreadOnly: true })
    assert.equal(unreadApproximation.unreadSupported, false)
    assert.match(unreadApproximation.note, /no guarda una marca universal/i)
  } finally {
    await db.run('DELETE FROM email_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM meta_social_contacts WHERE id = ?', [metaContactId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE id = ?', [whatsappContactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
