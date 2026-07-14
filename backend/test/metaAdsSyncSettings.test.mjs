import test from 'node:test'
import assert from 'node:assert/strict'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import {
  DEFAULT_META_ADS_SYNC_INTERVAL_MINUTES,
  MAX_META_ADS_SYNC_INTERVAL_MINUTES,
  META_ADS_SYNC_INTERVAL_CONFIG_KEY,
  META_ADS_SYNC_INTERVAL_OPTIONS,
  MIN_META_ADS_SYNC_INTERVAL_MINUTES,
  formatMetaAdsSyncInterval,
  getMetaAdsSyncIntervalMinutes,
  normalizeMetaAdsSyncIntervalMinutes,
  saveMetaAdsSyncIntervalMinutes,
  validateMetaAdsSyncIntervalMinutes
} from '../src/services/metaAdsSyncSettingsService.js'

test('frecuencia de Meta Ads usa una hora por default y sólo acepta opciones entre 5 minutos y un día', async () => {
  const previousValue = await getAppConfig(META_ADS_SYNC_INTERVAL_CONFIG_KEY)

  try {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [META_ADS_SYNC_INTERVAL_CONFIG_KEY])

    assert.equal(await getMetaAdsSyncIntervalMinutes(), DEFAULT_META_ADS_SYNC_INTERVAL_MINUTES)
    assert.equal(META_ADS_SYNC_INTERVAL_OPTIONS[0], MIN_META_ADS_SYNC_INTERVAL_MINUTES)
    assert.equal(
      META_ADS_SYNC_INTERVAL_OPTIONS[META_ADS_SYNC_INTERVAL_OPTIONS.length - 1],
      MAX_META_ADS_SYNC_INTERVAL_MINUTES
    )

    assert.equal(await saveMetaAdsSyncIntervalMinutes(10), 10)
    assert.equal(await getMetaAdsSyncIntervalMinutes(), 10)
    assert.equal(await saveMetaAdsSyncIntervalMinutes(360), 360)
    assert.equal(await getMetaAdsSyncIntervalMinutes(), 360)
    assert.equal(await saveMetaAdsSyncIntervalMinutes(1440), 1440)
    assert.equal(await getMetaAdsSyncIntervalMinutes(), 1440)

    assert.equal(normalizeMetaAdsSyncIntervalMinutes('valor-inválido'), DEFAULT_META_ADS_SYNC_INTERVAL_MINUTES)
    assert.equal(normalizeMetaAdsSyncIntervalMinutes(7), DEFAULT_META_ADS_SYNC_INTERVAL_MINUTES)
    assert.equal(formatMetaAdsSyncInterval(10), 'cada 10 minutos')
    assert.equal(formatMetaAdsSyncInterval(60), 'cada hora')
    assert.equal(formatMetaAdsSyncInterval(360), 'cada 6 horas')
    assert.equal(formatMetaAdsSyncInterval(1440), 'cada día')

    assert.throws(() => validateMetaAdsSyncIntervalMinutes(4), { status: 400 })
    assert.throws(() => validateMetaAdsSyncIntervalMinutes(7), { status: 400 })
    assert.throws(() => validateMetaAdsSyncIntervalMinutes(1441), { status: 400 })
  } finally {
    if (previousValue === null) {
      await db.run('DELETE FROM app_config WHERE config_key = ?', [META_ADS_SYNC_INTERVAL_CONFIG_KEY])
    } else {
      await setAppConfig(META_ADS_SYNC_INTERVAL_CONFIG_KEY, previousValue)
    }
  }
})
