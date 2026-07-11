import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { saveMetaConfig } from '../src/services/metaAdsService.js'
import { createLocalCalendar, updateLocalCalendar, upsertLocalCalendar } from '../src/services/localCalendarService.js'
import { createBlock, createSite, updateSite } from '../src/services/sitesService.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'

const EVENT_CONFIG_KEYS = [
  'meta_whatsapp_schedule_enabled',
  'meta_whatsapp_purchase_enabled',
  'meta_payment_purchase_event_config'
]

const SOCIAL_CHANNEL_CONFIG_KEYS = [
  'meta_messenger_messaging_enabled',
  'meta_instagram_messaging_enabled',
  'meta_facebook_comments_enabled',
  'meta_instagram_comments_enabled'
]

const PAGE_SOCIAL_CHANNEL_CONFIG_KEYS = [
  'meta_messenger_messaging_enabled',
  'meta_facebook_comments_enabled'
]

async function snapshotAppConfig(keys = [], callback) {
  const uniqueKeys = [...new Set(keys)]
  const placeholders = uniqueKeys.map(() => '?').join(', ')
  const previousRows = placeholders
    ? await db.all(
        `SELECT config_key, config_value FROM app_config WHERE config_key IN (${placeholders})`,
        uniqueKeys
      )
    : []

  try {
    if (placeholders) {
      await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    }
    return await callback()
  } finally {
    if (placeholders) {
      await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    }
    for (const row of previousRows) {
      await setAppConfig(row.config_key, row.config_value)
    }
  }
}

async function snapshotMetaConfig(callback) {
  const previousRows = await db.all('SELECT * FROM meta_config')

  try {
    await db.run('DELETE FROM meta_config')
    return await callback()
  } finally {
    await db.run('DELETE FROM meta_config')
    for (const row of previousRows) {
      const columns = Object.keys(row)
      const placeholders = columns.map(() => '?').join(', ')
      await db.run(
        `INSERT INTO meta_config (${columns.join(', ')}) VALUES (${placeholders})`,
        columns.map(column => row[column])
      )
    }
  }
}

async function cleanupCreatedSite(siteId) {
  if (!siteId) return
  await db.run('DELETE FROM public_site_blocks WHERE site_id = ?', [siteId])
  await db.run('DELETE FROM public_site_submissions WHERE site_id = ? OR form_site_id = ?', [siteId, siteId])
  await db.run('DELETE FROM public_sites WHERE id = ?', [siteId])
}

async function cleanupCreatedCalendar(calendarId) {
  if (!calendarId) return
  await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId])
  await db.run('DELETE FROM calendars WHERE id = ?', [calendarId])
}

test('saving Meta token with pixel enables calendar and payment conversion events', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(EVENT_CONFIG_KEYS, async () => {
        await setAppConfig('meta_whatsapp_schedule_enabled', '0')
        await setAppConfig('meta_whatsapp_purchase_enabled', '0')
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: false,
          channel: 'smart',
          eventName: 'Lead',
          parameters: {
            sendValue: false,
            value: '99',
            predictedLtv: '250',
            custom: [{ id: 'keep-me', key: 'campaign', value: 'retargeting' }]
          }
        }))

        metaServer = http.createServer((req, res) => {
          if (req.method === 'GET' && req.url.startsWith('/act_123456')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              timezone_id: 90,
              timezone_name: 'America/Mexico_City',
              timezone_offset_hours_utc: -6
            }))
            return
          }

          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'unexpected request' } }))
        })
        await new Promise(resolve => metaServer.listen(0, '127.0.0.1', resolve))
        Object.defineProperty(API_URLS, 'META_GRAPH', {
          value: `http://127.0.0.1:${metaServer.address().port}`,
          configurable: true
        })

        await saveMetaConfig(
          '123456',
          'meta-access-token',
          'pixel-123'
        )

        assert.equal(await getAppConfig('meta_whatsapp_schedule_enabled'), '1')
        assert.equal(await getAppConfig('meta_whatsapp_purchase_enabled'), '1')

        const paymentConfig = JSON.parse(await getAppConfig('meta_payment_purchase_event_config'))
        assert.equal(paymentConfig.enabled, true)
        assert.equal(paymentConfig.channel, 'smart')
        assert.equal(paymentConfig.eventName, 'Lead')
        assert.equal(paymentConfig.parameters.sendValue, false)
        assert.equal(paymentConfig.parameters.value, '99')
        assert.equal(paymentConfig.parameters.predictedLtv, '250')
        assert.deepEqual(paymentConfig.parameters.custom, [
          { id: 'keep-me', key: 'campaign', value: 'retargeting' }
        ])
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
  }
})

test('saving new Meta social profiles enables Page switches and page-backed Instagram DM', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(SOCIAL_CHANNEL_CONFIG_KEYS, async () => {
        metaServer = http.createServer((req, res) => {
          if (req.method === 'GET' && req.url.startsWith('/act_123456')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              timezone_id: 90,
              timezone_name: 'America/Mexico_City',
              timezone_offset_hours_utc: -6
            }))
            return
          }

          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'unexpected request' } }))
        })
        await new Promise(resolve => metaServer.listen(0, '127.0.0.1', resolve))
        Object.defineProperty(API_URLS, 'META_GRAPH', {
          value: `http://127.0.0.1:${metaServer.address().port}`,
          configurable: true
        })

        for (const key of SOCIAL_CHANNEL_CONFIG_KEYS) {
          await setAppConfig(key, '0')
        }

        await saveMetaConfig(
          '123456',
          'meta-access-token',
          null,
          'page-1',
          'ig-1'
        )

        for (const key of PAGE_SOCIAL_CHANNEL_CONFIG_KEYS) {
          assert.equal(await getAppConfig(key), '1', `${key} should default on for new Page profiles`)
        }
        assert.equal(await getAppConfig('meta_instagram_messaging_enabled'), '1')
        assert.equal(await getAppConfig('meta_instagram_comments_enabled'), '1')

        const messengerTokenForPageOne = encrypt('messenger-user-token-for-page-one')
        await db.run('UPDATE meta_config SET messenger_user_token = ?', [messengerTokenForPageOne])

        for (const key of SOCIAL_CHANNEL_CONFIG_KEYS) {
          await setAppConfig(key, '0')
        }

        await saveMetaConfig(
          '123456',
          'meta-access-token',
          null,
          'page-1',
          'ig-1'
        )

        const samePageConfig = await db.get('SELECT messenger_user_token FROM meta_config LIMIT 1')
        assert.equal(samePageConfig?.messenger_user_token, messengerTokenForPageOne, 'same Page should keep its validated Messenger User Token')

        for (const key of SOCIAL_CHANNEL_CONFIG_KEYS) {
          assert.equal(await getAppConfig(key), '0', `${key} should respect manual off for the same profiles`)
        }

        await saveMetaConfig(
          '123456',
          'meta-access-token',
          null,
          'page-2',
          'ig-2'
        )

        const changedPageConfig = await db.get('SELECT messenger_user_token FROM meta_config LIMIT 1')
        assert.equal(changedPageConfig?.messenger_user_token, null, 'new Page must request a new validated Messenger User Token')

        for (const key of PAGE_SOCIAL_CHANNEL_CONFIG_KEYS) {
          assert.equal(await getAppConfig(key), '1', `${key} should turn back on for changed Page profiles`)
        }
        assert.equal(await getAppConfig('meta_instagram_messaging_enabled'), '1')
        assert.equal(await getAppConfig('meta_instagram_comments_enabled'), '1')

        for (const key of SOCIAL_CHANNEL_CONFIG_KEYS) {
          await setAppConfig(key, '0')
        }

        await saveMetaConfig(
          '123456',
          'meta-access-token',
          null,
          'page-3',
          'ig-3'
        )

        for (const key of PAGE_SOCIAL_CHANNEL_CONFIG_KEYS) {
          assert.equal(await getAppConfig(key), '1', `${key} should turn on for changed Page profiles`)
        }
        assert.equal(await getAppConfig('meta_instagram_messaging_enabled'), '1')
        assert.equal(await getAppConfig('meta_instagram_comments_enabled'), '1')
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
  }
})

test('creating Sites, forms and calendars defaults Meta events on when dataset is connected', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  let metaServer
  const createdSiteIds = []
  const createdCalendarIds = []

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(EVENT_CONFIG_KEYS, async () => {
        metaServer = http.createServer((req, res) => {
          if (req.method === 'GET' && req.url.startsWith('/act_123456')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              timezone_id: 90,
              timezone_name: 'America/Mexico_City',
              timezone_offset_hours_utc: -6
            }))
            return
          }

          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'unexpected request' } }))
        })
        await new Promise(resolve => metaServer.listen(0, '127.0.0.1', resolve))
        Object.defineProperty(API_URLS, 'META_GRAPH', {
          value: `http://127.0.0.1:${metaServer.address().port}`,
          configurable: true
        })

        await saveMetaConfig(
          '123456',
          'meta-access-token',
          'dataset-123',
          'legacy-pixel-capi-token'
        )

        const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
        const formSite = await createSite({
          name: `Meta default form ${suffix}`,
          slug: `meta-default-form-${suffix}`,
          siteType: 'standard_form',
          metaCapiEnabled: false,
          metaEventName: 'none'
        })
        createdSiteIds.push(formSite.id)
        assert.equal(formSite.metaCapiEnabled, true)
        assert.equal(formSite.metaEventName, 'Lead')

        const landingSite = await createSite({
          name: `Meta default landing ${suffix}`,
          slug: `meta-default-landing-${suffix}`,
          siteType: 'landing_page',
          metaCapiEnabled: false,
          metaEventName: 'none',
          theme: {
            pages: [
              { id: 'page-1', title: 'Inicio', sortOrder: 0 }
            ]
          }
        })
        createdSiteIds.push(landingSite.id)
        assert.equal(landingSite.metaCapiEnabled, true)
        assert.equal(landingSite.metaEventName, 'none')
        assert.equal(landingSite.theme.pages[0].metaCapiEnabled, true)
        assert.equal(landingSite.theme.pages[0].metaEventName, 'none')
        assert.equal(landingSite.theme.pages[0].metaTrigger, 'page_view')

        const landingSiteWithNewPage = await updateSite(landingSite.id, {
          theme: {
            ...landingSite.theme,
            pages: [
              ...landingSite.theme.pages,
              {
                id: 'page-added-after-create',
                title: 'Nueva pagina',
                sortOrder: landingSite.theme.pages.length,
                metaCapiEnabled: false,
                metaEventName: 'none',
                metaTrigger: 'page_view'
              }
            ]
          },
          metaCapiEnabled: landingSite.metaCapiEnabled
        })
        const addedPage = landingSiteWithNewPage.theme.pages.find(page => page.id === 'page-added-after-create')
        assert.equal(addedPage.metaCapiEnabled, true)
        assert.equal(addedPage.metaEventName, 'none')
        assert.equal(addedPage.metaTrigger, 'page_view')

        const landingSiteWithCalendarBlock = await createBlock(landingSite.id, {
          blockType: 'calendar_embed',
          label: 'Agenda',
          settings: {}
        })
        const calendarBlock = landingSiteWithCalendarBlock.blocks.find(block => block.blockType === 'calendar_embed')
        assert.ok(calendarBlock)
        assert.equal(landingSiteWithCalendarBlock.theme.metaCalendarEvents[calendarBlock.id].enabled, true)
        assert.equal(landingSiteWithCalendarBlock.theme.metaCalendarEvents[calendarBlock.id].eventName, 'Schedule')

        const calendar = await createLocalCalendar({
          name: `Meta default calendar ${suffix}`,
          customEvents: {
            enabled: false,
            channel: 'site',
            parameters: {
              value: '150',
              custom: [{ id: 'param-1', key: 'source', value: 'calendar' }]
            }
          }
        })
        createdCalendarIds.push(calendar.id)
        assert.equal(calendar.customEvents.enabled, true)
        assert.equal(calendar.customEvents.channel, 'site')
        assert.equal(calendar.customEvents.eventName, 'Schedule')
        assert.equal(calendar.customEvents.parameters.value, '150')
        assert.deepEqual(calendar.customEvents.parameters.custom, [
          { id: 'param-1', key: 'source', value: 'calendar' }
        ])

        const remoteCalendar = await upsertLocalCalendar({
          id: `ghl_meta_default_${suffix}`,
          name: `Remote Meta default calendar ${suffix}`,
          slug: `remote-meta-default-${suffix}`,
          widgetSlug: `remote-meta-default-${suffix}`
        }, {
          source: 'ghl',
          ghlCalendarId: `ghl_meta_default_${suffix}`,
          syncStatus: 'synced',
          rawJson: {
            id: `ghl_meta_default_${suffix}`,
            name: `Remote Meta default calendar ${suffix}`
          }
        })
        createdCalendarIds.push(remoteCalendar.id)
        assert.equal(remoteCalendar.customEvents.enabled, true)
        assert.equal(remoteCalendar.customEvents.channel, 'site')
        assert.equal(remoteCalendar.customEvents.eventName, 'Schedule')

        const disabledRemoteCalendar = await updateLocalCalendar(remoteCalendar.id, {
          customEvents: {
            enabled: false,
            channel: 'site',
            eventName: 'Schedule'
          }
        })
        assert.equal(disabledRemoteCalendar.customEvents.enabled, false)

        const resyncedRemoteCalendar = await upsertLocalCalendar({
          id: `ghl_meta_default_${suffix}`,
          name: `Remote Meta default calendar resynced ${suffix}`,
          slug: `remote-meta-default-${suffix}`,
          widgetSlug: `remote-meta-default-${suffix}`
        }, {
          source: 'ghl',
          ghlCalendarId: `ghl_meta_default_${suffix}`,
          syncStatus: 'synced',
          rawJson: {
            id: `ghl_meta_default_${suffix}`,
            name: `Remote Meta default calendar resynced ${suffix}`
          }
        })
        assert.equal(resyncedRemoteCalendar.customEvents.enabled, false)
      })
    })
  } finally {
    for (const siteId of createdSiteIds) {
      await cleanupCreatedSite(siteId)
    }
    for (const calendarId of createdCalendarIds) {
      await cleanupCreatedCalendar(calendarId)
    }
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
  }
})

test('saving Meta token creates smart payment conversion defaults when none exist', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(EVENT_CONFIG_KEYS, async () => {
        metaServer = http.createServer((req, res) => {
          if (req.method === 'GET' && req.url.startsWith('/act_123456')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              timezone_id: 90,
              timezone_name: 'America/Mexico_City',
              timezone_offset_hours_utc: -6
            }))
            return
          }

          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'unexpected request' } }))
        })
        await new Promise(resolve => metaServer.listen(0, '127.0.0.1', resolve))
        Object.defineProperty(API_URLS, 'META_GRAPH', {
          value: `http://127.0.0.1:${metaServer.address().port}`,
          configurable: true
        })

        await saveMetaConfig(
          '123456',
          'meta-access-token',
          'pixel-123'
        )

        const paymentConfig = JSON.parse(await getAppConfig('meta_payment_purchase_event_config'))
        assert.equal(paymentConfig.enabled, true)
        assert.equal(paymentConfig.channel, 'smart')
        assert.equal(paymentConfig.eventName, 'Purchase')
        assert.equal(paymentConfig.parameters.sendValue, true)
        assert.equal(paymentConfig.parameters.value, '')
        assert.equal(paymentConfig.parameters.predictedLtv, '')
        assert.deepEqual(paymentConfig.parameters.custom, [])
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
  }
})
