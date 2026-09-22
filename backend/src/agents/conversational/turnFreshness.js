import { AsyncLocalStorage } from 'node:async_hooks'
import { findNewerSubstantiveConversationalInbound } from '../../services/conversationalInboundAuthorityService.js'
import { normalizeConversationalInboundCommitChannel } from '../../services/conversationalInboundCommitLockService.js'

const currentTurn = new AsyncLocalStorage()
const activeTurns = new Map()
const keyFor = (contactId, channel) => `${normalizeConversationalInboundCommitChannel(channel)}:${contactId}`

export function currentConversationalTurnSignal(timeoutMs = null) {
  const signal = currentTurn.getStore()?.controller.signal
  const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : null
  return signal && timeout ? AbortSignal.any([signal, timeout]) : signal || timeout || undefined
}

export async function assertCurrentConversationalTurn() {
  await currentTurn.getStore()?.check()
}

export function rememberConversationalTurnContext(ctx) {
  const turn = currentTurn.getStore()
  if (turn) turn.ctx = ctx
}

// Checking canonical rows also detects arrivals handled by another instance.
// Duplicate webhooks and reactions do not invalidate a real message.
export async function interruptSupersededConversationalTurn(contactId, channel) {
  await activeTurns.get(keyFor(contactId, channel))?.check().catch(() => {})
}

export async function withCurrentConversationalTurn({ contactId, messageId, channel }, callback, {
  findNewer = findNewerSubstantiveConversationalInbound,
  hasCommittedEffect = () => false,
  pollMs = 1000
} = {}) {
  const key = keyFor(contactId, channel)
  const controller = new AbortController()
  let checking = null
  const turn = {
    controller,
    ctx: null,
    async check() {
      if (hasCommittedEffect(turn.ctx)) return
      controller.signal.throwIfAborted()
      if (!checking) {
        checking = (async () => {
          try {
            const authority = await findNewer({ contactId, handledMessageId: messageId, channel })
            if (!hasCommittedEffect(turn.ctx) && (!authority.checked || authority.newerMessage)) {
              controller.abort(Object.assign(new Error('La conversación cambió mientras se preparaba la respuesta.'), {
                code: authority.newerMessage ? 'conversational_turn_superseded' : 'conversational_turn_authority_missing',
                newerMessage: authority.newerMessage || null
              }))
            }
          } catch (error) {
            controller.abort(error)
          }
        })().finally(() => { checking = null })
      }
      await checking
      if (hasCommittedEffect(turn.ctx)) return
      controller.signal.throwIfAborted()
    }
  }
  activeTurns.set(key, turn)
  const timer = setInterval(() => { void turn.check().catch(() => {}) }, pollMs)
  timer.unref?.()
  try {
    return await currentTurn.run(turn, async () => {
      await turn.check()
      const result = await callback()
      await turn.check()
      return result
    })
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error
    if (reason && typeof reason === 'object') reason.conversationalContext = turn.ctx
    throw reason
  } finally {
    clearInterval(timer)
    if (activeTurns.get(key) === turn) activeTurns.delete(key)
    // No detached authority query may outlive the run's claim.
    if (checking) await checking
  }
}
