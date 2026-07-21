import test from 'node:test'
import assert from 'node:assert/strict'
import { iterateHighLevelContactPages } from '../src/services/highlevelContactSearchService.js'

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name] ?? headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body)
  }
}

async function collectPages(options) {
  const pages = []
  for await (const page of iterateHighLevelContactPages(options)) pages.push(page)
  return pages
}

test('contact sync uses POST search pagination and retries HighLevel request timeouts', async () => {
  const requests = []
  const waits = []
  let pageTwoAttempts = 0

  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body)
    requests.push({ url, options, body })
    if (body.page === 1) {
      return response(200, {
        contacts: [{ id: 'c1' }, { id: 'c2' }],
        total: 4
      })
    }
    pageTwoAttempts += 1
    if (pageTwoAttempts === 1) {
      return response(400, { message: 'Request Timeout after 30000ms' })
    }
    return response(200, {
      contacts: [{ id: 'c3' }, { id: 'c4' }],
      total: 4
    })
  }

  const pages = await collectPages({
    locationId: 'loc_test',
    apiToken: 'token_test',
    pageLimit: 2,
    fetchImpl,
    sleepImpl: async ms => waits.push(ms)
  })

  assert.deepEqual(pages.map(page => page.contacts.map(contact => contact.id)), [
    ['c1', 'c2'],
    ['c3', 'c4']
  ])
  assert.equal(requests.length, 3)
  assert.deepEqual(requests.map(request => request.body.page), [1, 2, 2])
  assert.ok(requests.every(request => request.url.endsWith('/contacts/search')))
  assert.ok(requests.every(request => request.options.method === 'POST'))
  assert.ok(requests.every(request => request.options.headers.Version === '2021-07-28'))
  assert.deepEqual(waits, [1000])
})

test('contact sync does not retry a permanent 400 response', async () => {
  let attempts = 0
  await assert.rejects(
    collectPages({
      locationId: 'loc_test',
      apiToken: 'token_test',
      fetchImpl: async () => {
        attempts += 1
        return response(400, { message: 'Invalid filter' })
      },
      sleepImpl: async () => {}
    }),
    error => error.status === 400 && error.retryable === false
  )
  assert.equal(attempts, 1)
})

test('contact sync stops when HighLevel repeats the same page', async () => {
  await assert.rejects(
    collectPages({
      locationId: 'loc_test',
      apiToken: 'token_test',
      pageLimit: 2,
      fetchImpl: async () => response(200, {
        contacts: [{ id: 'same-1' }, { id: 'same-2' }],
        total: 10
      }),
      sleepImpl: async () => {}
    }),
    error => error.code === 'GHL_CONTACT_SEARCH_REPEATED_PAGE'
  )
})
