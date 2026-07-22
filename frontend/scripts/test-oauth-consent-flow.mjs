import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const [appSource, loginSource, redirectSource, consentSource] = await Promise.all([
  readFile(`${root}/src/App.tsx`, 'utf8'),
  readFile(`${root}/src/pages/Login/Login.tsx`, 'utf8'),
  readFile(`${root}/src/utils/phoneAccess.ts`, 'utf8'),
  readFile(`${root}/src/pages/OAuth/OAuthAuthorize.tsx`, 'utf8')
])

assert.match(
  appSource,
  /path="\/oauth\/authorize"[\s\S]{0,120}<ProtectedRoute>[\s\S]{0,80}<LazyOAuthAuthorize\s*\/>/
)
assert.match(appSource, /state=\{\{ from: location \}\}/)
assert.match(loginSource, /getPostAuthRedirectPath\(fromLocation/)
assert.match(redirectSource, /from\?\.search\s*\|\|\s*''/)

assert.match(consentSource, /\/api\/oauth\/authorize\/context/)
assert.match(consentSource, /\/api\/oauth\/authorize\/consent/)
assert.match(consentSource, /'request_id'/)
assert.doesNotMatch(consentSource, /localStorage\.getItem\(['"]auth_token['"]\)/)
assert.doesNotMatch(consentSource, /apiToken|API token/)

console.log('OAuth consent flow contract: OK')
