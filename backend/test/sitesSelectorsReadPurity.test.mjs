import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { db } from '../src/config/database.js'
import { listSites, listSiteSelectors } from '../src/services/sitesService.js'

test('GET de selectores y listado de Sites ejecutan cero escrituras', async () => {
  const originalRun = db.run
  const writes = []
  db.run = async (...args) => {
    writes.push(String(args[0] || ''))
    return originalRun.apply(db, args)
  }
  try {
    await listSiteSelectors({ kind: 'forms', limit: 10 })
    await listSites({ limit: 10, paginated: true })
  } finally {
    db.run = originalRun
  }
  assert.deepEqual(writes, [])
})

test('la semilla de calendario es single-flight aunque startup la invoque concurrentemente', async () => {
  const serviceUrl = new URL('../src/services/sitesService.js', import.meta.url)
  serviceUrl.searchParams.set('single-flight', randomUUID())
  const isolatedService = await import(serviceUrl.href)
  const originalRun = db.run
  const seedWrites = []
  db.run = async (...args) => {
    const sql = String(args[0] || '')
    if (/INSERT INTO\s+public_site(?:s|_blocks)/i.test(sql)) seedWrites.push(sql)
    return originalRun.apply(db, args)
  }
  try {
    await Promise.all(Array.from({ length: 12 }, () => (
      isolatedService.ensureCalendarBookingSystemFormOnce()
    )))
  } finally {
    db.run = originalRun
  }
  assert.equal(seedWrites.length, 4, 'una semilla de site y tres bloques, no doce lotes')
})

test('la inicializacion vive en startup y no dentro de funciones de lectura', async () => {
  const [sitesSource, serverSource] = await Promise.all([
    readFile(new URL('../src/services/sitesService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  ])
  const selectorsRead = sitesSource.slice(
    sitesSource.indexOf('export async function listSiteSelectors'),
    sitesSource.indexOf('export async function listSites')
  )
  const listRead = sitesSource.slice(
    sitesSource.indexOf('export async function listSites'),
    sitesSource.indexOf('export async function getSite')
  )

  assert.doesNotMatch(selectorsRead, /ensureCalendarBookingSystemFormOnce|\b(?:INSERT|UPDATE|DELETE)\b/i)
  assert.doesNotMatch(listRead, /ensureCalendarBookingSystemFormOnce/)
  assert.match(serverSource, /await ensureCalendarBookingSystemFormOnce\(\)/)
})
