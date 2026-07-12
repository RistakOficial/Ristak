// Tipos para Facebook SDK
interface Window {
  FB?: {
    init: (params: {
      appId: string
      autoLogAppEvents?: boolean
      cookie?: boolean
      xfbml?: boolean
      version: string
    }) => void
    login: (
      callback: (response: {
        authResponse?: {
          code?: string
          accessToken?: string
          userID?: string
          expiresIn?: string
          signedRequest?: string
        }
        status?: string
      }) => void,
      params?: any
    ) => void
  }
  fbAsyncInit?: () => void
}
