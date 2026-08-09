import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'

const policySource = await readFile(
  new URL('../src/pages/PhoneChat/chatLiveFirstPolicy.ts', import.meta.url),
  'utf8'
)
const compiledPolicy = await transform(policySource, {
  loader: 'ts',
  format: 'esm',
  target: 'es2020'
})
const policyModuleUrl = `data:text/javascript;base64,${Buffer.from(compiledPolicy.code).toString('base64')}`
const {
  MOBILE_CHAT_CACHE_FALLBACK_GRACE_MS,
  shouldRevealMobileChatCacheFallback
} = await import(policyModuleUrl)

assert.equal(MOBILE_CHAT_CACHE_FALLBACK_GRACE_MS, 350)
assert.equal(shouldRevealMobileChatCacheFallback({
  freshResolved: false,
  hasCachedData: true,
  requestIsCurrent: true
}), true)
assert.equal(shouldRevealMobileChatCacheFallback({
  freshResolved: true,
  hasCachedData: true,
  requestIsCurrent: true
}), false)

const phoneChatSource = await readFile(
  new URL('../src/pages/PhoneChat/PhoneChat.tsx', import.meta.url),
  'utf8'
)

assert.match(
  phoneChatSource,
  /if \(!append && !silentRefresh && hasCachedChats\) \{[\s\S]{0,260}revealCachedChats\(\)/,
  'la bandeja web móvil debe pintar el snapshot en el primer frame'
)
assert.doesNotMatch(
  phoneChatSource,
  /window\.setTimeout\(revealCachedChats, MOBILE_CHAT_CACHE_FALLBACK_GRACE_MS\)/,
  'la bandeja no debe esperar una gracia que pueda dejarla en blanco'
)
assert.match(
  phoneChatSource,
  /window\.setTimeout\(revealCachedConversation, MOBILE_CHAT_CACHE_FALLBACK_GRACE_MS\)/,
  'la conversación sólo debe revelar su caché después de la gracia live-first'
)
assert.match(
  phoneChatSource,
  /freshPage\.length === 0 && cacheWasRevealed && chatsRef\.current\.length > 0/,
  'un vacío inicial contradictorio debe confirmarse antes de borrar la bandeja visible'
)
assert.match(
  phoneChatSource,
  /Mostrando información guardada/,
  'el fallback local debe identificarse claramente para el usuario'
)

console.log('Mobile web Chat inbox-first/thread-live-first paint contract OK')
