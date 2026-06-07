import { useEffect, useMemo, useState } from 'react'
import { useTheme } from '@/contexts/ThemeContext'
import { mobileAppService } from '@/services/mobileAppService'
import { useAppConfig } from './useAppConfig'

const SYSTEM_DARK_MODE_QUERY = '(prefers-color-scheme: dark)'
const DAY_START_HOUR = 6
const NIGHT_START_HOUR = 19
const PHONE_THEME_CONFIG_KEY = 'mobile_chat_theme_preference'
const PHONE_THEME_LIGHT_COLOR = '#fbfaf6'
const PHONE_THEME_DARK_COLOR = '#0b0f14'
const PHONE_THEME_ISOLATED_DESIGN_PRESET = 'classic'

export type PhoneThemePreference = 'system' | 'light' | 'dark' | 'auto'
export type PhoneThemeTone = 'light' | 'dark'

interface UsePhoneThemeOptions {
  active?: boolean
}

export function isPhoneThemePreference(value: unknown): value is PhoneThemePreference {
  return value === 'system' || value === 'light' || value === 'dark' || value === 'auto'
}

function getTimeBasedPhoneTheme(now: Date = new Date()): PhoneThemeTone {
  const hour = now.getHours()
  return hour >= NIGHT_START_HOUR || hour < DAY_START_HOUR ? 'dark' : 'light'
}

function msUntilNextPhoneThemeSwitch(now: Date = new Date()): number {
  const currentHour = now.getHours()
  const nextSwitch = new Date(now)

  if (currentHour >= DAY_START_HOUR && currentHour < NIGHT_START_HOUR) {
    nextSwitch.setHours(NIGHT_START_HOUR, 0, 0, 0)
  } else if (currentHour >= NIGHT_START_HOUR) {
    nextSwitch.setDate(now.getDate() + 1)
    nextSwitch.setHours(DAY_START_HOUR, 0, 0, 0)
  } else {
    nextSwitch.setHours(DAY_START_HOUR, 0, 0, 0)
  }

  return Math.max(1000, nextSwitch.getTime() - now.getTime())
}

function getSystemDarkModeMedia() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(SYSTEM_DARK_MODE_QUERY)
}

function canReadSystemTheme() {
  return Boolean(getSystemDarkModeMedia())
}

function getSystemPhoneTheme(): PhoneThemeTone {
  const media = getSystemDarkModeMedia()
  return media?.matches ? 'dark' : 'light'
}

function resolvePhoneTheme(preference: PhoneThemePreference): PhoneThemeTone {
  if (preference === 'light' || preference === 'dark') return preference
  if (preference === 'auto') return getTimeBasedPhoneTheme()
  return canReadSystemTheme() ? getSystemPhoneTheme() : getTimeBasedPhoneTheme()
}

function getPhoneThemeDeviceLabel() {
  if (mobileAppService.getPlatform() === 'ios') return 'iPhone'
  if (mobileAppService.getPlatform() === 'android') return 'Android'
  if (typeof navigator === 'undefined') return 'este celular'

  const userAgent = navigator.userAgent || ''
  if (/iPad/i.test(userAgent)) return 'iPad'
  if (/iPhone|iPod/i.test(userAgent)) return 'iPhone'
  if (/Android/i.test(userAgent)) return 'Android'
  return 'este equipo'
}

export function usePhoneTheme({ active = true }: UsePhoneThemeOptions = {}) {
  const { theme: webTheme, designPreset: webDesignPreset } = useTheme()
  const [preference, setPreference] = useAppConfig<PhoneThemePreference>(PHONE_THEME_CONFIG_KEY, 'system')
  const safePreference = isPhoneThemePreference(preference) ? preference : 'system'
  const [resolvedTheme, setResolvedTheme] = useState<PhoneThemeTone>(() => resolvePhoneTheme(safePreference))
  const [systemThemeAvailable, setSystemThemeAvailable] = useState(canReadSystemTheme)
  const deviceLabel = useMemo(getPhoneThemeDeviceLabel, [])

  useEffect(() => {
    if (preference === safePreference) return
    setPreference(safePreference).catch(() => undefined)
  }, [preference, safePreference, setPreference])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const systemMedia = getSystemDarkModeMedia()
    let timeoutId: number | null = null

    const updateTheme = () => {
      setSystemThemeAvailable(Boolean(systemMedia))
      setResolvedTheme(resolvePhoneTheme(safePreference))
    }

    const runAutoThemeLoop = () => {
      updateTheme()
      timeoutId = window.setTimeout(runAutoThemeLoop, msUntilNextPhoneThemeSwitch())
    }

    if (safePreference === 'auto') {
      runAutoThemeLoop()
    } else {
      updateTheme()
    }

    if (safePreference === 'system' && systemMedia) {
      systemMedia.addEventListener('change', updateTheme)
    }

    return () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
      if (systemMedia) {
        systemMedia.removeEventListener('change', updateTheme)
      }
    }
  }, [safePreference])

  useEffect(() => {
    if (!active) return

    const root = document.documentElement
    const body = document.body
    const previousRootTheme = root.dataset.phoneChatTheme
    const previousBodyTheme = body.dataset.phoneChatTheme
    const previousRootTone = root.dataset.phoneChatTone
    const previousBodyTone = body.dataset.phoneChatTone
    const previousRootMode = root.dataset.phoneChatMode
    const previousBodyMode = body.dataset.phoneChatMode
    let restoring = false

    const applyPhoneThemeClass = () => {
      body.classList.toggle('light', resolvedTheme === 'light')
      body.classList.toggle('dark', resolvedTheme === 'dark')
    }

    const isolateTheme = (target: HTMLElement) => {
      const currentTheme = target.dataset.theme
      if (currentTheme !== resolvedTheme) {
        target.dataset.theme = resolvedTheme
      }
    }

    const isolateDesignPreset = (target: HTMLElement) => {
      const currentPreset = target.dataset.designPreset
      if (currentPreset !== PHONE_THEME_ISOLATED_DESIGN_PRESET) {
        target.dataset.designPreset = PHONE_THEME_ISOLATED_DESIGN_PRESET
      }
    }

    const applyWebThemeIsolation = () => {
      root.dataset.phoneThemeIsolated = 'true'
      body.dataset.phoneThemeIsolated = 'true'
      isolateTheme(root)
      isolateTheme(body)
      isolateDesignPreset(root)
      isolateDesignPreset(body)
      applyPhoneThemeClass()
    }

    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver((mutations) => {
        if (restoring) return

        let shouldReapplyPhoneClass = false
        mutations.forEach((mutation) => {
          if (mutation.attributeName === 'data-theme') {
            if (mutation.target === root) isolateTheme(root)
            if (mutation.target === body) isolateTheme(body)
          }

          if (mutation.attributeName === 'data-design-preset') {
            if (mutation.target === root) isolateDesignPreset(root)
            if (mutation.target === body) isolateDesignPreset(body)
          }

          if (mutation.attributeName === 'class' && mutation.target === body) {
            shouldReapplyPhoneClass = true
          }
        })

        if (shouldReapplyPhoneClass) applyPhoneThemeClass()
      })

    applyWebThemeIsolation()

    mutationObserver?.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-design-preset'] })
    mutationObserver?.observe(body, { attributes: true, attributeFilter: ['data-theme', 'data-design-preset', 'class'] })

    root.dataset.phoneChatTheme = 'active'
    body.dataset.phoneChatTheme = 'active'
    root.dataset.phoneChatTone = resolvedTheme
    body.dataset.phoneChatTone = resolvedTheme
    root.dataset.phoneChatMode = safePreference
    body.dataset.phoneChatMode = safePreference

    return () => {
      restoring = true
      mutationObserver?.disconnect()

      if (previousRootTheme !== undefined) root.dataset.phoneChatTheme = previousRootTheme
      else delete root.dataset.phoneChatTheme

      if (previousBodyTheme !== undefined) body.dataset.phoneChatTheme = previousBodyTheme
      else delete body.dataset.phoneChatTheme

      if (previousRootTone !== undefined) root.dataset.phoneChatTone = previousRootTone
      else delete root.dataset.phoneChatTone

      if (previousBodyTone !== undefined) body.dataset.phoneChatTone = previousBodyTone
      else delete body.dataset.phoneChatTone

      if (previousRootMode !== undefined) root.dataset.phoneChatMode = previousRootMode
      else delete root.dataset.phoneChatMode

      if (previousBodyMode !== undefined) body.dataset.phoneChatMode = previousBodyMode
      else delete body.dataset.phoneChatMode

      root.dataset.theme = webTheme
      body.dataset.theme = webTheme
      root.dataset.designPreset = webDesignPreset
      body.dataset.designPreset = webDesignPreset

      delete root.dataset.phoneThemeIsolated
      delete body.dataset.phoneThemeIsolated

      body.classList.toggle('light', webTheme === 'light')
      body.classList.toggle('dark', webTheme === 'dark')
    }
  }, [active, resolvedTheme, safePreference, webDesignPreset, webTheme])

  useEffect(() => {
    if (!active) return

    const metaThemeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    const meta = metaThemeColor || document.createElement('meta')
    const previousThemeColor = metaThemeColor?.getAttribute('content') ?? null
    const createdMeta = !metaThemeColor

    if (createdMeta) {
      meta.setAttribute('name', 'theme-color')
      document.head.appendChild(meta)
    }

    meta.setAttribute('content', resolvedTheme === 'dark' ? PHONE_THEME_DARK_COLOR : PHONE_THEME_LIGHT_COLOR)

    return () => {
      if (createdMeta) {
        meta.remove()
      } else if (previousThemeColor !== null) {
        meta.setAttribute('content', previousThemeColor)
      } else {
        meta.removeAttribute('content')
      }
    }
  }, [active, resolvedTheme])

  useEffect(() => {
    if (!active) return

    mobileAppService.setShellTheme(resolvedTheme).catch(() => undefined)

    return () => {
      mobileAppService.setShellTheme('light').catch(() => undefined)
    }
  }, [active, resolvedTheme])

  const resolvedThemeLabel = resolvedTheme === 'dark' ? 'Noche' : 'Claro'
  const preferenceLabel = safePreference === 'system'
    ? 'Sistema'
    : safePreference === 'light'
      ? 'Claro'
      : safePreference === 'dark'
        ? 'Noche'
        : 'Horario'
  const themeMeta = safePreference === 'light' || safePreference === 'dark'
    ? preferenceLabel
    : `${preferenceLabel}: ${resolvedThemeLabel}`

  return {
    preference,
    safePreference,
    setPreference,
    resolvedTheme,
    resolvedThemeLabel,
    preferenceLabel,
    themeMeta,
    systemThemeAvailable,
    deviceLabel
  }
}
