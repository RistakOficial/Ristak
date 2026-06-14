import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  getEffectiveAccessConfig,
  hasUserAccess,
  normalizeAccessConfig,
  serializeAccessConfig
} from '../src/utils/userAccess.js'

describe('user access config', () => {
  it('gives administrators write access to every module', () => {
    const access = getEffectiveAccessConfig({ role: 'admin' })

    assert.equal(access.dashboard, 'write')
    assert.equal(access.settings_media, 'write')
    assert.equal(access.settings_users, 'write')
    assert.equal(hasUserAccess({ role: 'admin' }, 'settings_users', 'write'), true)
  })

  it('keeps account access available for employees', () => {
    const access = normalizeAccessConfig({}, 'employee')

    assert.equal(access.settings_account, 'write')
    assert.equal(hasUserAccess({ role: 'employee', access_config: access }, 'settings_account', 'write'), true)
  })

  it('does not allow employees to manage users even if the payload asks for it', () => {
    const access = normalizeAccessConfig({ settings_users: 'write', contacts: 'read' }, 'employee')

    assert.equal(access.contacts, 'read')
    assert.equal(access.settings_users, 'none')
    assert.equal(hasUserAccess({ role: 'employee', access_config: access }, 'settings_users', 'read'), false)
  })

  it('serializes unknown or invalid levels as none', () => {
    const serialized = serializeAccessConfig({ contacts: 'delete', reports: 'write', settings_media: 'read' }, 'employee')
    const parsed = JSON.parse(serialized)

    assert.equal(parsed.contacts, 'none')
    assert.equal(parsed.reports, 'write')
    assert.equal(parsed.settings_media, 'read')
  })
})
