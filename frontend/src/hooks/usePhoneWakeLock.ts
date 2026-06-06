import { useEffect } from 'react'

const PHONE_WAKE_LOCK_IDLE_MS = 8 * 60 * 1000
const PHONE_WAKE_LOCK_RETRY_MS = 2500

interface WakeLockSentinelLike extends EventTarget {
  readonly released: boolean
  release: () => Promise<void>
}

interface WakeLockControllerLike {
  request: (type: 'screen') => Promise<WakeLockSentinelLike>
}

interface NavigatorWithWakeLock {
  wakeLock?: WakeLockControllerLike
}

interface UsePhoneWakeLockOptions {
  active?: boolean
}

function getWakeLockController() {
  if (typeof navigator === 'undefined') return null

  const wakeLock = (navigator as unknown as NavigatorWithWakeLock).wakeLock
  return wakeLock && typeof wakeLock.request === 'function' ? wakeLock : null
}

export function usePhoneWakeLock({ active = true }: UsePhoneWakeLockOptions = {}) {
  useEffect(() => {
    if (!active || typeof window === 'undefined' || typeof document === 'undefined') return

    const wakeLockController = getWakeLockController()
    if (!wakeLockController) return
    const requestScreenWakeLock = wakeLockController.request.bind(wakeLockController)

    let sentinel: WakeLockSentinelLike | null = null
    let cancelled = false
    let retryTimer: number | null = null
    let idleTimer: number | null = null

    const clearRetryTimer = () => {
      if (retryTimer === null) return
      window.clearTimeout(retryTimer)
      retryTimer = null
    }

    const clearIdleTimer = () => {
      if (idleTimer === null) return
      window.clearTimeout(idleTimer)
      idleTimer = null
    }

    const releaseWakeLock = async () => {
      const currentSentinel = sentinel
      sentinel = null

      if (!currentSentinel || currentSentinel.released) return

      try {
        currentSentinel.removeEventListener('release', handleWakeLockRelease)
        await currentSentinel.release()
      } catch {
        // The browser can release the lock by itself; nothing to recover here.
      }
    }

    const scheduleRetry = () => {
      if (cancelled || document.visibilityState !== 'visible' || retryTimer !== null) return

      retryTimer = window.setTimeout(() => {
        retryTimer = null
        void requestWakeLock()
      }, PHONE_WAKE_LOCK_RETRY_MS)
    }

    const scheduleIdleRelease = () => {
      clearIdleTimer()

      idleTimer = window.setTimeout(() => {
        void releaseWakeLock()
      }, PHONE_WAKE_LOCK_IDLE_MS)
    }

    async function requestWakeLock() {
      if (cancelled || document.visibilityState !== 'visible') return
      if (sentinel && !sentinel.released) {
        scheduleIdleRelease()
        return
      }

      clearRetryTimer()

      try {
        sentinel = await requestScreenWakeLock('screen')
        sentinel.addEventListener('release', handleWakeLockRelease)
        scheduleIdleRelease()
      } catch {
        scheduleRetry()
      }
    }

    function handleWakeLockRelease() {
      sentinel?.removeEventListener('release', handleWakeLockRelease)
      sentinel = null

      if (!cancelled && document.visibilityState === 'visible') {
        scheduleRetry()
      }
    }

    const refreshWakeLock = () => {
      if (document.visibilityState !== 'visible') return
      scheduleIdleRelease()
      void requestWakeLock()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshWakeLock()
      } else {
        clearRetryTimer()
        clearIdleTimer()
      }
    }

    void requestWakeLock()

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', refreshWakeLock)
    window.addEventListener('pageshow', refreshWakeLock)
    window.addEventListener('pointerdown', refreshWakeLock, { passive: true })
    window.addEventListener('touchend', refreshWakeLock, { passive: true })
    window.addEventListener('keydown', refreshWakeLock)

    return () => {
      cancelled = true
      clearRetryTimer()
      clearIdleTimer()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', refreshWakeLock)
      window.removeEventListener('pageshow', refreshWakeLock)
      window.removeEventListener('pointerdown', refreshWakeLock)
      window.removeEventListener('touchend', refreshWakeLock)
      window.removeEventListener('keydown', refreshWakeLock)
      void releaseWakeLock()
    }
  }, [active])
}
