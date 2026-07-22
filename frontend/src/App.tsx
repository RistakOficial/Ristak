import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { DateRangeProvider } from '@/contexts/DateRangeContext'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { NotificationProvider, useNotification } from '@/contexts/NotificationContext'
import { TimezoneProvider } from '@/contexts/TimezoneContext'
import { LabelsProvider } from '@/contexts/LabelsContext'
import { usePhoneTheme, usePhoneWakeLock } from '@/hooks'
import { AppShell } from '@/components/layout/AppShell'
import { useInitialization } from '@/contexts/InitializationContext'
import {
  LazyAIAgent,
  LazyAPIDocumentation,
  LazyAnalytics,
  LazyAppointments,
  LazyAutomations,
  LazyCampaigns,
  LazyContacts,
  LazyDashboard,
  LazyDesktopChat,
  LazyInitialization,
  LazyLicenseBlocked,
  LazyLogin,
  LazyMDPProgram,
  LazyMobileTenantSetup,
  LazyPaymentProducts,
  LazyPaymentSubscriptions,
  LazyPhoneAgentChat,
  LazyPhoneAnalytics,
  LazyPhoneApp,
  LazyPhoneCalendar,
  LazyPhoneChat,
  LazyPhonePayments,
  LazyPhoneSettings,
  LazyPublicPayment,
  LazyPublicPaymentGatewayReturn,
  LazyReports,
  LazyResetPassword,
  LazySettings,
  LazySetup,
  LazySites,
  LazySso,
  LazyTransactions,
  prefetchRouteModule
} from '@/routing/routeModules'
import { ToastContainer } from '@/components/common/Toast'
import { Modal } from '@/components/common/Modal'
import { StorageAlert } from '@/components/common/StorageAlert'
import { AppStartupLoader } from '@/components/common/AppStartupLoader'
import { MobileNotificationOnboarding } from '@/components/phone/MobileNotificationOnboarding'
import { PhoneStartupLoader } from '@/components/phone/PhoneStartupLoader'
import { mobileAppService } from '@/services/mobileAppService'
import {
  DESKTOP_LOGIN_PATH,
  PHONE_APP_HOME_PATH,
  PHONE_APP_LOGIN_PATH,
  PHONE_APP_PREFIX,
  PHONE_APP_TENANT_PATH,
  SETUP_PATH,
  TABLET_VIEW_PREFERENCE_EVENT,
  getLoginPathForRoute,
  getPostAuthRedirectPath,
  isCellphoneDevice,
  isPhoneAppPath,
  isPublicCustomerExperiencePath,
  isTabletDevice,
  readTabletViewPreference,
  toCanonicalPhoneAppPath,
  writeTabletViewPreference,
  type RedirectLocation,
  type TabletViewPreference
} from '@/utils/phoneAccess'
import {
  getFirstAllowedAppPath,
  hasLicenseFeature,
  hasModuleAccess,
  type PermissionKey
} from '@/utils/accessControl'
import { installKeyboardFocusScroll } from '@/utils/keyboardFocusScroll'
import { isNativeAppRuntime } from '@/services/apiBaseUrl'

const LazyOAuthAuthorize = React.lazy(() => import('@/pages/OAuth/OAuthAuthorize'))

type RouteLocationState = {
  from?: RedirectLocation
} | null

type AppBranding = {
  title: string
  favicon: string
  faviconType: string
  manifest: string
  appleTouchIcon: string
  themeColor: string
}

const ROUTE_BRANDING: Record<'ristak' | 'phone' | 'phoneChat', AppBranding> = {
  ristak: {
    title: 'Ristak',
    favicon: '/ristak-icon-192.png',
    faviconType: 'image/png',
    manifest: '/manifest.webmanifest',
    appleTouchIcon: '/apple-touch-icon.png',
    themeColor: '#ffffff'
  },
  phone: {
    title: 'Ristak',
    favicon: '/ristak-chat-icon-192.png',
    faviconType: 'image/png',
    manifest: '/manifest.phone.webmanifest',
    appleTouchIcon: '/ristak-chat-apple-touch-icon.png',
    themeColor: '#050505'
  },
  phoneChat: {
    title: 'Ristak',
    favicon: '/ristak-chat-home-icon-192.png',
    faviconType: 'image/png',
    manifest: '/manifest.phone-chat.webmanifest',
    appleTouchIcon: '/ristak-chat-home-apple-touch-icon.png',
    themeColor: '#050505'
  }
}

const PHONE_LOCKED_VIEWPORT_CONTENT = [
  'width=device-width',
  'initial-scale=1',
  'minimum-scale=1',
  'maximum-scale=1',
  'user-scalable=no',
  'viewport-fit=cover'
].join(', ')

function getRouteBranding(pathname: string) {
  const canonicalPathname = toCanonicalPhoneAppPath(pathname)

  if (canonicalPathname === PHONE_APP_HOME_PATH) {
    return ROUTE_BRANDING.phoneChat
  }

  if (isPhoneAppPath(pathname)) {
    return ROUTE_BRANDING.phone
  }

  return ROUTE_BRANDING.ristak
}

function setHeadLink(selector: string, attributes: Record<string, string>) {
  let link = document.head.querySelector<HTMLLinkElement>(selector)

  if (!link) {
    link = document.createElement('link')
    document.head.appendChild(link)
  }

  Object.entries(attributes).forEach(([name, value]) => {
    link?.setAttribute(name, value)
  })
}

function setHeadMeta(selector: string, attributes: Record<string, string>) {
  let meta = document.head.querySelector<HTMLMetaElement>(selector)

  if (!meta) {
    meta = document.createElement('meta')
    document.head.appendChild(meta)
  }

  Object.entries(attributes).forEach(([name, value]) => {
    meta?.setAttribute(name, value)
  })
}

function applyRouteBranding(pathname: string) {
  const branding = getRouteBranding(pathname)
  const isPhoneRoute = isPhoneAppPath(pathname)

  document.title = branding.title
  document.documentElement.dataset.appBrand = isPhoneRoute ? 'ristak-chat' : 'ristak'

  setHeadLink('link[rel="icon"]', {
    rel: 'icon',
    type: branding.faviconType,
    href: branding.favicon
  })
  setHeadLink('link[rel="manifest"]', {
    rel: 'manifest',
    href: branding.manifest
  })
  setHeadLink('link[rel="apple-touch-icon"]', {
    rel: 'apple-touch-icon',
    href: branding.appleTouchIcon
  })
  setHeadMeta('meta[name="theme-color"]', {
    name: 'theme-color',
    content: branding.themeColor
  })
  setHeadMeta('meta[name="apple-mobile-web-app-title"]', {
    name: 'apple-mobile-web-app-title',
    content: branding.title
  })
}

const PhoneThemeRouteEffects: React.FC = () => {
  usePhoneTheme({ active: true })
  usePhoneWakeLock({ active: true })
  return null
}

function isStandalonePhoneShell() {
  if (typeof window === 'undefined') return false

  const standaloneMedia = window.matchMedia?.('(display-mode: standalone)').matches
  const navigatorStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  if (!standaloneMedia && !navigatorStandalone) return false

  const portableViewport = window.matchMedia?.('(max-width: 760px), (pointer: coarse)').matches
  const portableUserAgent = /Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent)
  return Boolean(portableViewport || portableUserAgent)
}

function getStandalonePhoneRedirect(pathname: string) {
  if (!isStandalonePhoneShell()) return ''

  if (pathname === '/' || pathname === '/dashboard') return PHONE_APP_HOME_PATH
  if (pathname === '/login') return PHONE_APP_LOGIN_PATH
  return ''
}

const RouteStartupLoader: React.FC<{ pathname: string; message?: string }> = ({ pathname, message }) => (
  isPhoneAppPath(pathname)
    ? <PhoneStartupLoader message={message || 'Cargando'} />
    : <AppStartupLoader message={message || 'Cargando'} />
)

const RouteModuleSuspense: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation()

  return (
    <React.Suspense fallback={<RouteStartupLoader pathname={location.pathname} message="Abriendo módulo" />}>
      {children}
    </React.Suspense>
  )
}

// Componente para la ruta de setup (primera vez)
const SetupRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, needsSetup, isLoading } = useAuth()
  const location = useLocation()
  const redirectPath = getPostAuthRedirectPath((location.state as RouteLocationState)?.from)

  if (isLoading) {
    return <RouteStartupLoader pathname={location.pathname} />
  }

  if (!needsSetup) {
    return isAuthenticated
      ? <Navigate to={redirectPath} replace />
      : <Navigate to={getLoginPathForRoute(location.pathname)} state={{ from: location }} replace />
  }

  return <>{children}</>
}

// Componente para proteger rutas que requieren autenticación
const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading, needsSetup } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return <RouteStartupLoader pathname={location.pathname} />
  }

  if (needsSetup) {
    return <Navigate to={SETUP_PATH} state={{ from: location }} replace />
  }

  if (!isAuthenticated) {
    return <Navigate to={getLoginPathForRoute(location.pathname)} state={{ from: location }} replace />
  }

  return <>{children}</>
}

const AccessRoute: React.FC<{ moduleKey: PermissionKey; featureKeys?: readonly string[]; children: React.ReactNode }> = ({ moduleKey, featureKeys, children }) => {
  const { user } = useAuth()

  if (!hasModuleAccess(user, moduleKey, 'read')) {
    return <Navigate to={getFirstAllowedAppPath(user)} replace />
  }

  if (featureKeys?.length && !hasLicenseFeature(user, featureKeys)) {
    return <Navigate to={getFirstAllowedAppPath(user)} replace />
  }

  return <>{children}</>
}

const MdpProgramRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth()

  if (user?.licenseFeatures?.mdp_program !== true) {
    return <Navigate to={getFirstAllowedAppPath(user)} replace />
  }

  return <>{children}</>
}

// Redirección de la raíz (/): mientras el onboarding de integraciones no esté
// completo (ni oculto), se lleva al usuario a /initialization; si ya está dado
// de alta, va al dashboard. Se monta dentro del AppShell (InitializationProvider).
const HomeRedirect: React.FC = () => {
  const { loading, isInitialized } = useInitialization()
  const { user } = useAuth()
  const destination = !isInitialized && user?.role === 'admin'
    ? '/initialization'
    : hasModuleAccess(user, 'dashboard', 'read')
      ? '/dashboard'
      : getFirstAllowedAppPath(user)

  React.useEffect(() => {
    if (loading) return
    void prefetchRouteModule(destination).catch(() => undefined)
  }, [destination, loading])

  if (loading) {
    return <AppStartupLoader compact />
  }

  return <Navigate to={destination} replace />
}

const PhoneRouteEffects: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const isPhoneRoute = isPhoneAppPath(location.pathname)

  React.useEffect(() => {
    const redirectPath = getStandalonePhoneRedirect(location.pathname)
    if (!redirectPath || redirectPath === location.pathname) return
    navigate(redirectPath, { replace: true })
  }, [location.pathname, navigate])

  React.useEffect(() => {
    applyRouteBranding(location.pathname)
  }, [location.pathname])

  React.useLayoutEffect(() => {
    if (!isPhoneRoute) return

    const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    if (!viewportMeta) return

    const previousViewportContent = viewportMeta.getAttribute('content') || ''
    viewportMeta.setAttribute('content', PHONE_LOCKED_VIEWPORT_CONTENT)

    return () => {
      viewportMeta.setAttribute('content', previousViewportContent)
    }
  }, [isPhoneRoute])

  React.useEffect(() => {
    if (!isPhoneRoute) return

    const nonPassiveOptions: AddEventListenerOptions = { passive: false }
    const preventDefault = (event: Event) => event.preventDefault()
    const preventMultiTouchZoom = (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault()
    }
    const preventTrackpadZoom = (event: WheelEvent) => {
      if (event.ctrlKey) event.preventDefault()
    }

    document.addEventListener('gesturestart', preventDefault, nonPassiveOptions)
    document.addEventListener('gesturechange', preventDefault, nonPassiveOptions)
    document.addEventListener('gestureend', preventDefault, nonPassiveOptions)
    document.addEventListener('touchmove', preventMultiTouchZoom, nonPassiveOptions)
    document.addEventListener('wheel', preventTrackpadZoom, nonPassiveOptions)
    document.addEventListener('dblclick', preventDefault, nonPassiveOptions)

    return () => {
      document.removeEventListener('gesturestart', preventDefault)
      document.removeEventListener('gesturechange', preventDefault)
      document.removeEventListener('gestureend', preventDefault)
      document.removeEventListener('touchmove', preventMultiTouchZoom)
      document.removeEventListener('wheel', preventTrackpadZoom)
      document.removeEventListener('dblclick', preventDefault)
    }
  }, [isPhoneRoute])

  React.useEffect(() => {
    if (!isPhoneRoute) return

    const lockTarget = isCellphoneDevice()
      ? 'portrait'
      : isTabletDevice()
        ? 'landscape'
        : ''

    if (!lockTarget) return

    const orientation = window.screen?.orientation as (ScreenOrientation & {
      lock?: (orientation: string) => Promise<void>
      unlock?: () => void
    }) | undefined

    void orientation?.lock?.(lockTarget).catch(() => undefined)

    return () => {
      orientation?.unlock?.()
    }
  }, [isPhoneRoute])

  React.useLayoutEffect(() => {
    const body = document.body
    const root = document.documentElement
    const previousBodyPhoneApp = body.dataset.phoneApp
    const previousRootPhoneApp = root.dataset.phoneApp

    if (isPhoneRoute) {
      body.dataset.phoneApp = 'active'
      root.dataset.phoneApp = 'active'
    } else {
      delete body.dataset.phoneApp
      delete root.dataset.phoneApp
    }

    let viewportFrame = 0
    let lastVisualViewportHeight = ''
    let lastVisualViewportTop = ''
    let lastKeyboardInset = ''
    let lastKeyboardLiveInset = ''
    let keyboardLiveActive = false
    // visualViewport alimenta payments/sheets/modales. En el chat de iOS,
    // MainViewController es la unica fuente para la altura real del teclado.
    const setPhoneViewportVars = (visibleHeight: number, viewportTop: number, inset: number, liveInset: number) => {
      const nextVisualViewportHeight = `${Math.round(visibleHeight)}px`
      const nextVisualViewportTop = `${Math.round(viewportTop)}px`
      const nextKeyboardInset = `${Math.round(inset)}px`
      const nextKeyboardLiveInset = `${Math.round(liveInset)}px`
      if (lastVisualViewportHeight !== nextVisualViewportHeight) {
        root.style.setProperty('--phone-visual-viewport-height', nextVisualViewportHeight)
        lastVisualViewportHeight = nextVisualViewportHeight
      }
      if (lastVisualViewportTop !== nextVisualViewportTop) {
        root.style.setProperty('--phone-visual-viewport-top', nextVisualViewportTop)
        lastVisualViewportTop = nextVisualViewportTop
      }
      if (lastKeyboardInset !== nextKeyboardInset) {
        root.style.setProperty('--phone-keyboard-inset', nextKeyboardInset)
        lastKeyboardInset = nextKeyboardInset
      }
      if (lastKeyboardLiveInset !== nextKeyboardLiveInset) {
        root.style.setProperty('--phone-keyboard-live-inset', nextKeyboardLiveInset)
        lastKeyboardLiveInset = nextKeyboardLiveInset
      }
      const nextKeyboardLiveActive = liveInset > 0
      if (keyboardLiveActive !== nextKeyboardLiveActive) {
        keyboardLiveActive = nextKeyboardLiveActive
        if (nextKeyboardLiveActive) {
          root.dataset.phoneKeyboardLive = 'true'
        } else {
          delete root.dataset.phoneKeyboardLive
        }
      }
    }
    const syncPhoneViewport = () => {
      const visualViewport = window.visualViewport
      const layoutHeight = Math.max(root.clientHeight, window.innerHeight)
      const visibleHeight = visualViewport?.height ?? window.innerHeight
      const viewportTop = visualViewport?.offsetTop ?? 0
      const keyboardInset = Math.max(0, layoutHeight - visibleHeight - viewportTop)
      const liveKeyboardInset = keyboardInset > 2 ? Math.round(keyboardInset) : 0
      const roundedInset = keyboardInset > 48 ? Math.round(keyboardInset) : 0
      setPhoneViewportVars(visibleHeight, viewportTop, roundedInset, liveKeyboardInset)
    }
    const schedulePhoneViewportSync = () => {
      if (viewportFrame) window.cancelAnimationFrame(viewportFrame)
      viewportFrame = window.requestAnimationFrame(syncPhoneViewport)
    }

    if (isPhoneRoute) {
      syncPhoneViewport()
      window.visualViewport?.addEventListener('resize', schedulePhoneViewportSync)
      window.visualViewport?.addEventListener('scroll', schedulePhoneViewportSync)
      window.addEventListener('resize', schedulePhoneViewportSync)
    } else {
      root.style.removeProperty('--phone-visual-viewport-height')
      root.style.removeProperty('--phone-visual-viewport-top')
      root.style.removeProperty('--phone-keyboard-inset')
      root.style.removeProperty('--phone-keyboard-live-inset')
      root.style.removeProperty('--phone-kb')
      root.style.removeProperty('--phone-kb-dur')
      root.style.removeProperty('--phone-kb-ease')
      delete root.dataset.phoneKeyboardLive
    }

    return () => {
      if (viewportFrame) window.cancelAnimationFrame(viewportFrame)
      window.visualViewport?.removeEventListener('resize', schedulePhoneViewportSync)
      window.visualViewport?.removeEventListener('scroll', schedulePhoneViewportSync)
      window.removeEventListener('resize', schedulePhoneViewportSync)
      root.style.removeProperty('--phone-visual-viewport-height')
      root.style.removeProperty('--phone-visual-viewport-top')
      root.style.removeProperty('--phone-keyboard-inset')
      root.style.removeProperty('--phone-keyboard-live-inset')
      root.style.removeProperty('--phone-kb')
      root.style.removeProperty('--phone-kb-dur')
      root.style.removeProperty('--phone-kb-ease')
      delete root.dataset.phoneKeyboardLive

      if (previousBodyPhoneApp !== undefined) {
        body.dataset.phoneApp = previousBodyPhoneApp
      } else {
        delete body.dataset.phoneApp
      }

      if (previousRootPhoneApp !== undefined) {
        root.dataset.phoneApp = previousRootPhoneApp
      } else {
        delete root.dataset.phoneApp
      }
    }
  }, [isPhoneRoute])

  return isPhoneRoute ? <PhoneThemeRouteEffects /> : null
}

function useCellphoneAccessState() {
  const [isCellphone, setIsCellphone] = React.useState(isCellphoneDevice)

  React.useEffect(() => {
    const updateAccessState = () => setIsCellphone(isCellphoneDevice())
    const pointerMedia = window.matchMedia?.('(pointer: coarse)')

    updateAccessState()
    pointerMedia?.addEventListener('change', updateAccessState)
    window.addEventListener('resize', updateAccessState)
    window.addEventListener('orientationchange', updateAccessState)
    window.visualViewport?.addEventListener('resize', updateAccessState)

    return () => {
      pointerMedia?.removeEventListener('change', updateAccessState)
      window.removeEventListener('resize', updateAccessState)
      window.removeEventListener('orientationchange', updateAccessState)
      window.visualViewport?.removeEventListener('resize', updateAccessState)
    }
  }, [])

  return isCellphone
}

const CellphoneRouteGate: React.FC = () => {
  const location = useLocation()
  const isCellphone = useCellphoneAccessState()

  if (!isCellphone || isPhoneAppPath(location.pathname) || isPublicCustomerExperiencePath(location.pathname) || location.pathname === SETUP_PATH) {
    return null
  }

  const redirectPath = location.pathname === DESKTOP_LOGIN_PATH ? PHONE_APP_LOGIN_PATH : PHONE_APP_HOME_PATH

  return <Navigate to={redirectPath} replace state={{ from: location }} />
}

function useTabletViewPreferenceState() {
  const [isTablet, setIsTablet] = React.useState(isTabletDevice)
  const [preference, setPreference] = React.useState<TabletViewPreference | null>(readTabletViewPreference)

  React.useEffect(() => {
    const pointerMedia = window.matchMedia?.('(pointer: coarse)')
    const updateDeviceState = () => {
      setIsTablet(isTabletDevice())
      setPreference(readTabletViewPreference())
    }
    const updatePreference = () => setPreference(readTabletViewPreference())

    updateDeviceState()
    pointerMedia?.addEventListener('change', updateDeviceState)
    window.addEventListener('resize', updateDeviceState)
    window.addEventListener('orientationchange', updateDeviceState)
    window.visualViewport?.addEventListener('resize', updateDeviceState)
    window.addEventListener('storage', updatePreference)
    window.addEventListener(TABLET_VIEW_PREFERENCE_EVENT, updatePreference)

    return () => {
      pointerMedia?.removeEventListener('change', updateDeviceState)
      window.removeEventListener('resize', updateDeviceState)
      window.removeEventListener('orientationchange', updateDeviceState)
      window.visualViewport?.removeEventListener('resize', updateDeviceState)
      window.removeEventListener('storage', updatePreference)
      window.removeEventListener(TABLET_VIEW_PREFERENCE_EVENT, updatePreference)
    }
  }, [])

  return { isTablet, preference, setPreference }
}

const TabletViewPreferenceGate: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const { isTablet, preference, setPreference } = useTabletViewPreferenceState()
  const isPhoneRoute = isPhoneAppPath(location.pathname)
  const isPublicCustomerRoute = isPublicCustomerExperiencePath(location.pathname)
  // En la app nativa iOS el shell siempre es la vista de teléfono/tablet: ofrecer
  // "Versión para computadora" no aplica y provoca un loop con el gate nativo,
  // además de tapar el login con un overlay. No mostramos el modal ahí.
  // Las experiencias publicas de cliente tampoco deben heredar decisiones del
  // shell interno: un checkout o sitio publicado tiene que abrir limpio.
  const canApplyTabletPreference =
    isTablet && location.pathname !== SETUP_PATH && !isPublicCustomerRoute && !mobileAppService.isIosMobileShell()

  React.useEffect(() => {
    if (!canApplyTabletPreference || !preference) return

    if (preference === 'tablet' && !isPhoneRoute) {
      navigate(PHONE_APP_HOME_PATH, { replace: true })
      return
    }

    if (preference === 'web' && isPhoneRoute) {
      navigate('/dashboard', { replace: true })
    }
  }, [canApplyTabletPreference, isPhoneRoute, location.pathname, navigate, preference])

  const chooseTabletView = (nextPreference: TabletViewPreference) => {
    writeTabletViewPreference(nextPreference)
    setPreference(nextPreference)

    if (nextPreference === 'tablet' && !isPhoneRoute) {
      navigate(PHONE_APP_HOME_PATH, { replace: true })
      return
    }

    if (nextPreference === 'web' && isPhoneRoute) {
      navigate('/dashboard', { replace: true })
    }
  }

  if (!canApplyTabletPreference || preference) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tablet-view-choice-title"
      data-overlay=""
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: 'var(--modal-backdrop-bg)',
        backdropFilter: 'var(--modal-backdrop-filter)',
        WebkitBackdropFilter: 'var(--modal-backdrop-filter)'
      }}
    >
      <div
        data-modal=""
        style={{
          width: 'min(100%, 480px)',
          borderRadius: 'var(--radius-card)',
          border: '1px solid var(--border-strong)',
          background: 'var(--modal-surface-bg)',
          color: 'var(--color-text-primary)',
          boxShadow: 'var(--modal-shadow)',
          padding: '24px'
        }}
      >
        <p
          style={{
            margin: '0 0 8px',
            color: 'var(--color-text-tertiary)',
            fontSize: '12px',
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase'
          }}
        >
          Tablet detectada
        </p>
        <h1 id="tablet-view-choice-title" style={{ margin: 0, fontSize: '24px', lineHeight: 1.15 }}>
          ¿Cómo quieres usar Ristak en esta tablet?
        </h1>
        <p style={{ margin: '12px 0 22px', color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
          Puedes abrir el panel completo como computadora o usar la vista de tableta para chats.
        </p>
        <div style={{ display: 'grid', gap: '10px' }}>
          <button
            type="button"
            onClick={() => chooseTabletView('web')}
            style={{
              minHeight: '48px',
              borderRadius: '12px',
              border: '1px solid rgba(148, 163, 184, 0.24)',
              background: 'transparent',
              color: 'var(--color-text-primary)',
              fontWeight: 800,
              cursor: 'pointer'
            }}
          >
            Versión para computadora
          </button>
          <button
            type="button"
            onClick={() => chooseTabletView('tablet')}
            style={{
              minHeight: '48px',
              borderRadius: '12px',
              border: '1px solid rgba(var(--color-primary-rgb), 0.35)',
              background: 'rgb(var(--color-primary-rgb))',
              color: '#fff',
              fontWeight: 800,
              cursor: 'pointer'
            }}
          >
            Versión para tableta
          </button>
        </div>
      </div>
    </div>
  )
}

const NativeIosMobileRouteGate: React.FC = () => {
  const location = useLocation()

  if (!mobileAppService.isIosMobileShell()) return null

  const redirectPath = mobileAppService.getIosMobileRedirectPath(location.pathname)
  if (!redirectPath) return null

  const state = redirectPath === PHONE_APP_LOGIN_PATH
    ? { from: { pathname: PHONE_APP_HOME_PATH, search: '', hash: '' } }
    : undefined

  return <Navigate to={redirectPath} replace state={state} />
}

const LegacyPhoneRouteRedirect: React.FC = () => {
  const location = useLocation()
  const canonicalPath = toCanonicalPhoneAppPath(location.pathname)
  return <Navigate to={`${canonicalPath}${location.search}${location.hash}`} replace />
}

const PhoneHomeRouteRedirect: React.FC = () => {
  const location = useLocation()
  return <Navigate to={`${PHONE_APP_HOME_PATH}${location.search}${location.hash}`} replace />
}

function syncNativeKeyboardThemeForTarget(target: HTMLElement) {
  if (!isNativeAppRuntime()) return

  const surface = target.closest('[data-phone-keyboard-theme-surface="true"]')
  if (!surface) return

  mobileAppService.syncShellBackgroundFromElement(surface, 'light')
}

/**
 * Instala una sola vez el guardián de teclado (keyboardFocusScroll) que mantiene
 * cualquier campo de texto enfocado por encima del teclado en pantallas táctiles.
 * Solo se activa en la app nativa o en dispositivos de puntero grueso (móvil /
 * tablet). En escritorio ni se instala, y aunque se instalara sería un no-op
 * porque el teclado físico no encoge el visual viewport.
 */
const KeyboardFocusScrollEffect: React.FC = () => {
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return

    const coarsePointer = window.matchMedia?.('(pointer: coarse)')
    let dispose: (() => void) | null = null

    const sync = () => {
      const shouldInstall = isNativeAppRuntime() || !!coarsePointer?.matches
      if (shouldInstall && !dispose) {
        dispose = installKeyboardFocusScroll({
          onEditableFocus: syncNativeKeyboardThemeForTarget
        })
      } else if (!shouldInstall && dispose) {
        dispose()
        dispose = null
      }
    }

    sync()
    coarsePointer?.addEventListener('change', sync)

    return () => {
      coarsePointer?.removeEventListener('change', sync)
      dispose?.()
      dispose = null
    }
  }, [])

  return null
}

const AppWithNotifications: React.FC = () => {
  const { toasts, removeToast, modal, closeModal } = useNotification()

  return (
    <>
      <BrowserRouter>
        <PhoneRouteEffects />
        <KeyboardFocusScrollEffect />
        <NativeIosMobileRouteGate />
        <CellphoneRouteGate />
        <TabletViewPreferenceGate />
        <RouteModuleSuspense>
          <Routes>
          <Route path="/setup" element={<SetupRoute><LazySetup /></SetupRoute>} />
          <Route path="/license-blocked" element={<LazyLicenseBlocked />} />
          <Route path="/sso" element={<LazySso />} />
          <Route path="/login" element={<LazyLogin />} />
          <Route path="/reset-password" element={<LazyResetPassword />} />
          <Route path="/oauth/authorize" element={<ProtectedRoute><LazyOAuthAuthorize /></ProtectedRoute>} />
          <Route path="/pay/success" element={<LazyPublicPaymentGatewayReturn />} />
          <Route path="/pay/:publicPaymentId" element={<LazyPublicPayment />} />
          <Route path={PHONE_APP_TENANT_PATH} element={<LazyMobileTenantSetup />} />
          <Route path={PHONE_APP_LOGIN_PATH} element={<LazyLogin />} />
          <Route path="/phone/*" element={<LegacyPhoneRouteRedirect />} />
          <Route
            path={PHONE_APP_HOME_PATH}
            element={
              <ProtectedRoute>
                <AccessRoute moduleKey="chat">
                  <LazyPhoneChat />
                </AccessRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path={`${PHONE_APP_PREFIX}/chat`}
            element={
              <ProtectedRoute>
                <PhoneHomeRouteRedirect />
              </ProtectedRoute>
            }
          />
          <Route
            path={`${PHONE_APP_PREFIX}/agent-chat/*`}
            element={
              <ProtectedRoute>
                <AccessRoute moduleKey="ai_agent">
                  <LazyPhoneAgentChat />
                </AccessRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path={`${PHONE_APP_PREFIX}/agent-ai/*`}
            element={
              <ProtectedRoute>
                <AccessRoute moduleKey="ai_agent">
                  <LazyPhoneAgentChat />
                </AccessRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path={`${PHONE_APP_PREFIX}/ai-agent/*`}
            element={
              <ProtectedRoute>
                <AccessRoute moduleKey="ai_agent">
                  <LazyPhoneAgentChat />
                </AccessRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path={`${PHONE_APP_PREFIX}/app`}
            element={
              <ProtectedRoute>
                <Navigate to={PHONE_APP_HOME_PATH} replace />
              </ProtectedRoute>
            }
          />
          <Route
            path={`${PHONE_APP_PREFIX}/payments`}
            element={
              <ProtectedRoute>
                <AccessRoute moduleKey="payments">
                  <LazyPhonePayments />
                </AccessRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path={`${PHONE_APP_PREFIX}/analytics`}
            element={
              <ProtectedRoute>
                <AccessRoute moduleKey="dashboard">
                  <LazyPhoneAnalytics />
                </AccessRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path={`${PHONE_APP_PREFIX}/settings`}
            element={
              <ProtectedRoute>
                <AccessRoute moduleKey="settings_mobile">
                  <LazyPhoneSettings />
                </AccessRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path={`${PHONE_APP_PREFIX}/calendar`}
            element={
              <ProtectedRoute>
                <AccessRoute moduleKey="appointments">
                  <LazyPhoneCalendar />
                </AccessRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path={`${PHONE_APP_PREFIX}/appointments`}
            element={
              <ProtectedRoute>
                <AccessRoute moduleKey="appointments">
                  <LazyPhoneCalendar />
                </AccessRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path={`${PHONE_APP_PREFIX}/:section`}
            element={
              <ProtectedRoute>
                <LazyPhoneApp />
              </ProtectedRoute>
            }
          />
          <Route
            path="/api-docs"
            element={
              <ProtectedRoute>
                <AccessRoute moduleKey="settings_api_access">
                  <LazyAPIDocumentation />
                </AccessRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <AppShell />
              </ProtectedRoute>
            }
          >
            <Route index element={<HomeRedirect />} />
            <Route path="initialization/*" element={<AccessRoute moduleKey="settings_integrations"><LazyInitialization /></AccessRoute>} />
            <Route path="dashboard/*" element={<AccessRoute moduleKey="dashboard"><LazyDashboard /></AccessRoute>} />
            <Route path="chat/*" element={<AccessRoute moduleKey="chat"><LazyDesktopChat /></AccessRoute>} />
            <Route path="reports/*" element={<AccessRoute moduleKey="reports"><LazyReports /></AccessRoute>} />
            <Route path="campaigns/*" element={<AccessRoute moduleKey="campaigns"><LazyCampaigns /></AccessRoute>} />
            <Route path="transactions/payment-plans/*" element={<AccessRoute moduleKey="payments" featureKeys={['payment_plans']}><LazyTransactions /></AccessRoute>} />
            <Route path="transactions/subscriptions/*" element={<AccessRoute moduleKey="payments" featureKeys={['subscriptions']}><LazyPaymentSubscriptions /></AccessRoute>} />
            <Route path="transactions/products/*" element={<AccessRoute moduleKey="payments"><LazyPaymentProducts /></AccessRoute>} />
            <Route path="transactions/*" element={<AccessRoute moduleKey="payments"><LazyTransactions /></AccessRoute>} />
            <Route path="contacts/*" element={<AccessRoute moduleKey="contacts"><LazyContacts /></AccessRoute>} />
            <Route path="appointments/*" element={<AccessRoute moduleKey="appointments"><LazyAppointments /></AccessRoute>} />
            <Route path="sites/*" element={<AccessRoute moduleKey="sites"><LazySites /></AccessRoute>} />
            <Route path="automations/*" element={<AccessRoute moduleKey="automations"><LazyAutomations /></AccessRoute>} />
            <Route path="analytics/*" element={<AccessRoute moduleKey="analytics"><LazyAnalytics /></AccessRoute>} />
            <Route path="ai-agent/*" element={<AccessRoute moduleKey="ai_agent"><LazyAIAgent /></AccessRoute>} />
            <Route path="mdp-program/*" element={<MdpProgramRoute><LazyMDPProgram /></MdpProgramRoute>} />
            <Route path="settings/*" element={<LazySettings />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
          </Routes>
        </RouteModuleSuspense>
        <MobileNotificationOnboarding />
      </BrowserRouter>
      <StorageAlert />
      <ToastContainer toasts={toasts} onClose={removeToast} />
      <Modal
        isOpen={modal.isOpen}
        onClose={closeModal}
        title={modal.title}
        message={modal.message}
        type={modal.type}
        confirmText={modal.confirmText}
        cancelText={modal.cancelText}
        secondaryActionText={modal.secondaryActionText}
        secondaryActionVariant={modal.secondaryActionVariant}
        onConfirm={modal.onConfirm}
        onSecondaryAction={modal.onSecondaryAction}
        onCancel={modal.onCancel}
        typeToConfirm={modal.typeToConfirm}
      />
    </>
  )
}

export const App: React.FC = () => {
  return (
    <ThemeProvider>
      <TimezoneProvider>
        <NotificationProvider>
          <LabelsProvider>
            <AuthProvider>
              <DateRangeProvider>
                <AppWithNotifications />
              </DateRangeProvider>
            </AuthProvider>
          </LabelsProvider>
        </NotificationProvider>
      </TimezoneProvider>
    </ThemeProvider>
  )
}
