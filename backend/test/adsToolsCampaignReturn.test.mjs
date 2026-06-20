import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { getCampaignReturn } from '../src/agents/tools/adsTools.js'

async function cleanup({ accountId, contactIds }) {
  for (const contactId of contactIds) {
    await db.run('DELETE FROM appointment_attendance_signals WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
  await db.run('DELETE FROM meta_ads WHERE ad_account_id = ?', [accountId]).catch(() => undefined)
}

test('get_campaign_return cruza campañas con atribución y total pagado del contacto', async () => {
  const suffix = randomUUID()
  const accountId = `act_return_${suffix}`
  const campaignId = `cmp_return_${suffix}`
  const adsetId = `adset_return_${suffix}`
  const adId = `ad_return_${suffix}`
  const attributedContactId = `contact_return_${suffix}`
  const outsideContactId = `contact_outside_${suffix}`
  const testPaymentContactId = `contact_test_payment_${suffix}`
  const staleContactId = `contact_stale_${suffix}`

  await cleanup({ accountId, contactIds: [attributedContactId, outsideContactId, testPaymentContactId, staleContactId] })

  try {
    await db.run(
      `INSERT INTO meta_ads (
        date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
        ad_id, ad_name, spend, clicks, reach
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        '2099-02-01',
        accountId,
        campaignId,
        'Campaña Retorno',
        adsetId,
        'Conjunto Retorno',
        adId,
        'Anuncio Retorno',
        100,
        20,
        500
      ]
    )

    await db.run(
      `INSERT INTO contacts (
        id, phone, email, full_name, source, attribution_ad_id,
        attribution_ad_name, total_paid, purchases_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        attributedContactId,
        `+52999${Date.now().toString().slice(-7)}`,
        `return_${suffix}@example.test`,
        'Cliente Atribuido',
        'facebook',
        adId,
        'Anuncio Retorno',
        350,
        1,
        '2099-02-01T16:00:00.000Z',
        '2099-02-01T16:00:00.000Z'
      ]
    )

    await db.run(
      `INSERT INTO contacts (
        id, phone, email, full_name, source, attribution_ad_id,
        attribution_ad_name, total_paid, purchases_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        testPaymentContactId,
        `+52777${Date.now().toString().slice(-7)}`,
        `test_payment_${suffix}@example.test`,
        'Cliente Pago Prueba',
        'facebook',
        adId,
        'Anuncio Retorno',
        800,
        1,
        '2099-02-01T18:00:00.000Z',
        '2099-02-01T18:00:00.000Z'
      ]
    )

    await db.run(
      `INSERT INTO contacts (
        id, phone, email, full_name, source, attribution_ad_id,
        attribution_ad_name, total_paid, purchases_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        staleContactId,
        `+52666${Date.now().toString().slice(-7)}`,
        `stale_${suffix}@example.test`,
        'Cliente Stale Sin Pago Real',
        'facebook',
        adId,
        'Anuncio Retorno',
        9999,
        2,
        '2099-02-01T19:00:00.000Z',
        '2099-02-01T19:00:00.000Z'
      ]
    )

    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode, date, created_at, updated_at
      ) VALUES (?, ?, ?, 'MXN', ?, 'card', ?, ?, ?, ?)`,
      [
        `payment_return_${suffix}`,
        attributedContactId,
        350,
        'succeeded',
        'live',
        '2099-02-05T16:00:00.000Z',
        '2099-02-05T16:00:00.000Z',
        '2099-02-05T16:00:00.000Z'
      ]
    )

    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode, date, created_at, updated_at
      ) VALUES (?, ?, ?, 'MXN', ?, 'card', ?, ?, ?, ?)`,
      [
        `payment_test_${suffix}`,
        testPaymentContactId,
        800,
        'succeeded',
        'test',
        '2099-02-05T17:00:00.000Z',
        '2099-02-05T17:00:00.000Z',
        '2099-02-05T17:00:00.000Z'
      ]
    )

    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode, date, created_at, updated_at
      ) VALUES (?, ?, ?, 'MXN', ?, 'card', ?, ?, ?, ?)`,
      [
        `payment_failed_${suffix}`,
        testPaymentContactId,
        900,
        'failed',
        'live',
        '2099-02-05T18:00:00.000Z',
        '2099-02-05T18:00:00.000Z',
        '2099-02-05T18:00:00.000Z'
      ]
    )

    await db.run(
      `INSERT INTO contacts (
        id, phone, email, full_name, source, attribution_ad_id,
        attribution_ad_name, total_paid, purchases_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outsideContactId,
        `+52888${Date.now().toString().slice(-7)}`,
        `outside_${suffix}@example.test`,
        'Cliente Fuera De Rango',
        'facebook',
        adId,
        'Anuncio Retorno',
        999,
        1,
        '2099-02-02T16:00:00.000Z',
        '2099-02-02T16:00:00.000Z'
      ]
    )

    await db.run(
      `INSERT INTO appointments (
        id, contact_id, title, status, appointment_status, start_time, date_added
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        `appt_${suffix}`,
        attributedContactId,
        'Cita atribuida',
        'confirmed',
        'showed',
        '2099-02-03T16:00:00.000Z',
        '2099-02-01T16:20:00.000Z'
      ]
    )

    const result = await getCampaignReturn({
      startDate: '2099-02-01',
      endDate: '2099-02-01',
      groupBy: 'campaign',
      limit: 10
    })

    assert.equal(result.ok, true)
    assert.equal(result.groupBy, 'campaign')

    const row = result.results.find((item) => item.campaignId === campaignId)
    assert.ok(row, 'no encontró la campaña de prueba')
    assert.equal(row.spend, 100)
    assert.equal(row.clicks, 20)
    assert.equal(row.reach, 500)
    assert.equal(row.leads, 3)
    assert.equal(row.appointments, 1)
    assert.equal(row.attendances, 1)
    assert.equal(row.sales, 1)
    assert.equal(row.paidPayments, 1)
    assert.equal(row.attributedRevenue, 350)
    assert.equal(row.profit, 250)
    assert.equal(row.roas, 3.5)
    assert.equal(row.costPerLead, 33.33)
    assert.equal(row.costPerSale, 100)
    assert.match(result.attributionModel, /payments exitosos en vivo/)
  } finally {
    await cleanup({ accountId, contactIds: [attributedContactId, outsideContactId, testPaymentContactId, staleContactId] })
  }
})
