import React, { useEffect } from 'react'

/**
 * Página intermedia que recibe el callback de Meta OAuth
 * Esta página extrae el token de la URL y lo envía al opener (ventana padre)
 */
export const MetaOAuthCallback: React.FC = () => {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)

    const oauth = params.get('oauth')
    const token = params.get('token')
    const error = params.get('message')

    if (oauth === 'success' && token) {
      // Enviar mensaje al opener (ventana padre)
      if (window.opener) {
        window.opener.postMessage(
          {
            type: 'meta-oauth-success',
            token
          },
          window.location.origin
        )
      }

      // Cerrar el popup
      setTimeout(() => {
        window.close()
      }, 500)
    } else if (oauth === 'error') {
      // Enviar error al opener
      if (window.opener) {
        window.opener.postMessage(
          {
            type: 'meta-oauth-error',
            error: error || 'Error desconocido'
          },
          window.location.origin
        )
      }

      // Cerrar el popup
      setTimeout(() => {
        window.close()
      }, 2000)
    }
  }, [])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      padding: '40px',
      textAlign: 'center'
    }}>
      <div style={{
        width: '48px',
        height: '48px',
        border: '4px solid #E5E7EB',
        borderTopColor: '#0866FF',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite'
      }} />
      <p style={{ marginTop: '24px', color: '#6B7280', fontSize: '15px' }}>
        Finalizando conexión con Meta...
      </p>
      <style>
        {`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}
      </style>
    </div>
  )
}
