import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import {
  createAutomation,
  getAutomation,
  listAttributionAdsets,
  listAttributionAds,
  listAttributionCampaigns,
  updateAutomation
} from '../src/services/automationsService.js'

function makeFlow(label = 'Mensaje publicado', viewport = { x: 0, y: 0, zoom: 1 }) {
  return {
    nodes: [
      {
        id: 'start',
        type: 'start',
        category: 'trigger',
        label: 'Cuando...',
        position: { x: 120, y: 220 },
        config: {
          triggers: [{ id: 'trig_test', type: 'trigger-contact-created', config: {} }]
        }
      },
      {
        id: 'node_message',
        type: 'action-send-message',
        label: 'Mensaje',
        position: { x: 520, y: 220 },
        config: { customTitle: label }
      }
    ],
    edges: [
      {
        id: 'edge_test',
        sourceNodeId: 'start',
        sourceHandle: 'out',
        targetNodeId: 'node_message',
        targetHandle: 'in',
        animated: true
      }
    ],
    viewport,
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }
}

test('updateAutomation separa borrador guardado de flujo publicado', async () => {
  const automation = await createAutomation({
    name: `Publicación con borrador ${Date.now()}`,
    flow: makeFlow('Versión viva')
  })

  try {
    const published = await updateAutomation(automation.id, { status: 'published' })
    assert.equal(published.status, 'published')
    assert.equal(published.hasUnpublishedChanges, false)

    const movedViewport = await updateAutomation(automation.id, {
      flow: makeFlow('Versión viva', { x: 200, y: -40, zoom: 0.8 })
    })
    assert.equal(movedViewport.hasUnpublishedChanges, false)

    const draftSaved = await updateAutomation(automation.id, {
      flow: makeFlow('Cambio pendiente')
    })
    assert.equal(draftSaved.status, 'published')
    assert.equal(draftSaved.hasUnpublishedChanges, true)

    const rowWithDraft = await db.get('SELECT flow, published_flow FROM automations WHERE id = ?', [automation.id])
    assert.match(String(rowWithDraft.flow), /Cambio pendiente/)
    assert.match(String(rowWithDraft.published_flow), /Versión viva/)

    const republished = await updateAutomation(automation.id, { status: 'published' })
    assert.equal(republished.hasUnpublishedChanges, false)

    const fresh = await getAutomation(automation.id)
    assert.equal(fresh.hasUnpublishedChanges, false)
    assert.equal(fresh.flow.nodes[1].config.customTitle, 'Cambio pendiente')
  } finally {
    await db.run('DELETE FROM automations WHERE id = ?', [automation.id])
  }
})

test('catálogos de Meta Ads devuelven campañas, conjuntos y anuncios reales', async () => {
  const suffix = Date.now()
  const accountId = `act_catalog_${suffix}`
  const campaignId = `cmp_${suffix}`
  const adsetId = `adset_${suffix}`
  const adId = `ad_${suffix}`

  await db.run(
    `INSERT INTO meta_ads (
       date,
       ad_account_id,
       campaign_id,
       campaign_name,
       adset_id,
       adset_name,
       ad_id,
       ad_name,
       spend,
       clicks
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      '2099-01-01',
      accountId,
      campaignId,
      'Campaña de prueba',
      adsetId,
      'Conjunto de prueba',
      adId,
      'Anuncio de prueba',
      10,
      3
    ]
  )

  try {
    const [campaigns, adsets, ads] = await Promise.all([
      listAttributionCampaigns(),
      listAttributionAdsets(),
      listAttributionAds()
    ])

    assert.ok(campaigns.some((campaign) => (
      campaign.id === campaignId &&
      campaign.name === 'Campaña de prueba' &&
      campaign.lastDate === '2099-01-01'
    )))
    assert.ok(adsets.some((adset) => (
      adset.id === adsetId &&
      adset.name === 'Conjunto de prueba' &&
      adset.campaignId === campaignId &&
      adset.campaignName === 'Campaña de prueba'
    )))
    assert.ok(ads.some((ad) => (
      ad.id === adId &&
      ad.name === 'Anuncio de prueba' &&
      ad.adsetId === adsetId &&
      ad.adsetName === 'Conjunto de prueba' &&
      ad.campaignId === campaignId
    )))
  } finally {
    await db.run('DELETE FROM meta_ads WHERE ad_account_id = ?', [accountId])
  }
})
