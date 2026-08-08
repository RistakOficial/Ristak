export type ChatComposerIntegrationRoute = 'highlevel' | 'messenger' | 'instagram' | 'email'

export interface ChatComposerConnectionState {
  highLevelConnected: boolean
  metaMessengerConnected: boolean
  metaInstagramConnected: boolean
  emailConnected?: boolean
}

export interface NativeWhatsAppComposerRouteState {
  businessPhoneValue: string
  apiAvailable: boolean
  qrReady: boolean
}

/**
 * A route belongs in the composer only when at least one provider that can
 * actually deliver it is connected. Contact-specific limitations are handled
 * separately so a connected route can still explain why this contact cannot
 * use it.
 */
export function isChatComposerIntegrationRouteConnected(
  route: ChatComposerIntegrationRoute,
  state: ChatComposerConnectionState
) {
  if (route === 'highlevel') return state.highLevelConnected
  if (route === 'messenger') return state.metaMessengerConnected || state.highLevelConnected
  if (route === 'instagram') return state.metaInstagramConnected || state.highLevelConnected
  return Boolean(state.emailConnected || state.highLevelConnected)
}

export function isNativeWhatsAppComposerRouteConnected(
  state: NativeWhatsAppComposerRouteState
) {
  return Boolean(state.businessPhoneValue && (state.apiAvailable || state.qrReady))
}
