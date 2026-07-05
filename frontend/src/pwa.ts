export function registerPwa() {
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator)) return

  if (import.meta.env.DEV) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.getRegistrations()
        .then(registrations => registrations.forEach(registration => registration.unregister()))
        .catch(() => {
          // La app sigue funcionando aunque el navegador no permita limpiar el registro.
        })
    })
    return
  }

  window.addEventListener('load', () => {
    const hadController = Boolean(navigator.serviceWorker.controller)
    let reloadingForUpdate = false

    if (hadController) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloadingForUpdate) return
        reloadingForUpdate = true
        window.location.reload()
      })
    }

    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        void registration.update()
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          if (!installing || !hadController) return
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed') {
              installing.postMessage({ type: 'RISTAK_SKIP_WAITING' })
            }
          })
        })
      })
      .catch(() => {
        // La app sigue funcionando aunque el navegador no acepte service workers.
      })
  })
}
