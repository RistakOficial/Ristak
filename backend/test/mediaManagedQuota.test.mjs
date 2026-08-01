import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  MANAGED_MEDIA_STORAGE_QUOTA_BYTES,
  MANAGED_MEDIA_STORAGE_WARNING_PERCENT,
  evaluateManagedMediaQuota
} from '../src/services/mediaStorageService.js'

test('la cuota Bunny administrada es 1 GB duro y avisa al entrar al último 10%', () => {
  assert.equal(MANAGED_MEDIA_STORAGE_QUOTA_BYTES, 1024 ** 3)
  assert.equal(MANAGED_MEDIA_STORAGE_WARNING_PERCENT, 90)

  const beforeWarning = evaluateManagedMediaQuota({
    usedBytes: Math.ceil(MANAGED_MEDIA_STORAGE_QUOTA_BYTES * 0.9) - 2,
    requestedBytes: 1
  })
  assert.equal(beforeWarning.allowed, true)
  assert.equal(beforeWarning.warningRequired, false)

  const entersWarning = evaluateManagedMediaQuota({
    usedBytes: Math.ceil(MANAGED_MEDIA_STORAGE_QUOTA_BYTES * 0.9) - 2,
    requestedBytes: 2
  })
  assert.equal(entersWarning.allowed, true)
  assert.equal(entersWarning.warningRequired, true)

  const exactLimit = evaluateManagedMediaQuota({
    usedBytes: MANAGED_MEDIA_STORAGE_QUOTA_BYTES - 1,
    requestedBytes: 1
  })
  assert.equal(exactLimit.allowed, true)

  const overLimit = evaluateManagedMediaQuota({
    usedBytes: MANAGED_MEDIA_STORAGE_QUOTA_BYTES - 1,
    requestedBytes: 2
  })
  assert.equal(overLimit.allowed, false)
  assert.equal(overLimit.availableBytes, 1)
})

test('las reservas simultáneas cuentan para el límite y Bunny propio queda sin techo interno', () => {
  const concurrent = evaluateManagedMediaQuota({
    usedBytes: 800 * 1024 ** 2,
    reservedBytes: 180 * 1024 ** 2,
    requestedBytes: 50 * 1024 ** 2
  })
  assert.equal(concurrent.warningRequired, true)
  assert.equal(concurrent.allowed, false)

  const customerOwned = evaluateManagedMediaQuota({
    usedBytes: 20 * 1024 ** 3,
    reservedBytes: 10 * 1024 ** 3,
    requestedBytes: 5 * 1024 ** 3,
    unlimited: true
  })
  assert.equal(customerOwned.allowed, true)
  assert.equal(customerOwned.warningRequired, false)
  assert.equal(customerOwned.quotaBytes, null)
})

test('todos los uploads web y nativos pasan por el guard antes de transmitir', async () => {
  const [apiClient, mediaService, app, prompt, nativeUpload, nativeRoot] = await Promise.all([
    readFile(new URL('../../frontend/src/services/apiClient.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/services/mediaService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/components/common/MediaStorageQuotaPrompt/MediaStorageQuotaPrompt.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../ios/app/Ristak/Core/Media/ChatMediaUploadService.swift', import.meta.url), 'utf8'),
    readFile(new URL('../../ios/app/Ristak/App/RootView.swift', import.meta.url), 'utf8')
  ])

  assert.match(apiClient, /estimateMediaUploadBytes\(body\)/)
  assert.match(apiClient, /requestMediaStorageUploadPermission\(uploadBytes\)/)
  assert.match(mediaService, /requestMediaStorageUploadPermission\(input\.file\.size\)/)
  assert.match(app, /<MediaStorageQuotaPrompt\s*\/>/)
  assert.match(prompt, /Este aviso aparecerá en cada intento de subida/)
  assert.match(prompt, /Conectar Bunny\.net/)
  assert.match(nativeUpload, /\/media\/upload-preflight/)
  assert.match(nativeUpload, /requestDecision\(for: preflight\)/)
  assert.match(nativeRoot, /Continuar subida/)
  assert.match(nativeRoot, /Conectar Bunny\.net/)
})
