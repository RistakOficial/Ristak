import React, { createContext, useContext, useState, useEffect } from 'react'
import { themes, sharedTokens } from '@/theme/tokens'

type ThemeMode = 'light' | 'dark'
type ThemeSource = 'system' | 'manual'
type DesignPreset = 'classic' | 'atelier' | 'editorial'

const DESIGN_PRESETS: Array<{
  id: DesignPreset
  label: string
  description: string
}> = [
  {
    id: 'classic',
    label: 'Actual',
    description: 'Diseño base de Ristak'
  },
  {
    id: 'atelier',
    label: 'Atelier',
    description: 'Suave, moderno y espacioso'
  },
  {
    id: 'editorial',
    label: 'Línea',
    description: 'Contenedores unidos con tipografía moderna'
  }
]

const THEME_COLOR_CONFIG_KEY = 'theme_color'
const THEME_STYLE_CONFIG_KEY = 'theme_style'
const DEFAULT_DESIGN_PRESET: DesignPreset = 'editorial'
const LEGACY_THEME_STORAGE_KEY = 'manualTheme'
const LEGACY_DESIGN_PRESET_STORAGE_KEY = 'ristak-design-preset'
const DAY_START_HOUR = 6
const NIGHT_START_HOUR = 19

interface ThemeContextType {
  theme: ThemeMode
  themeData: typeof themes.dark & typeof sharedTokens
  toggleTheme: () => void
  setTheme: (theme: ThemeMode) => void
  themeSource: ThemeSource
  resetToSystem: () => void
  isSystemTheme: boolean
  designPreset: DesignPreset
  setDesignPreset: (preset: DesignPreset) => void
  designPresets: typeof DESIGN_PRESETS
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

const getTimeBasedTheme = (now: Date = new Date()): ThemeMode => {
  const hour = now.getHours()
  return hour >= NIGHT_START_HOUR || hour < DAY_START_HOUR ? 'dark' : 'light'
}

const msUntilNextThemeSwitch = (now: Date = new Date()): number => {
  const currentHour = now.getHours()

  let nextSwitch: Date

  if (currentHour >= DAY_START_HOUR && currentHour < NIGHT_START_HOUR) {
    nextSwitch = new Date(now)
    nextSwitch.setHours(NIGHT_START_HOUR, 0, 0, 0)
  } else if (currentHour >= NIGHT_START_HOUR) {
    nextSwitch = new Date(now)
    nextSwitch.setDate(now.getDate() + 1)
    nextSwitch.setHours(DAY_START_HOUR, 0, 0, 0)
  } else {
    nextSwitch = new Date(now)
    nextSwitch.setHours(DAY_START_HOUR, 0, 0, 0)
  }

  const msUntilNextSwitch = nextSwitch.getTime() - now.getTime()
  return Math.max(1000, msUntilNextSwitch)
}

const parseConfigValue = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null
  }

  const trimmedValue = value.trim()

  if (!trimmedValue) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmedValue)
    return typeof parsed === 'string' ? parsed : trimmedValue
  } catch {
    return trimmedValue
  }
}

const isThemeMode = (value: unknown): value is ThemeMode => {
  return value === 'light' || value === 'dark'
}

const isDesignPreset = (value: unknown): value is DesignPreset => {
  return typeof value === 'string' && DESIGN_PRESETS.some((preset) => preset.id === value)
}

const getConfigTheme = (value: unknown): ThemeMode | null => {
  const parsedValue = parseConfigValue(value)
  return isThemeMode(parsedValue) ? parsedValue : null
}

const getConfigDesignPreset = (value: unknown): DesignPreset | null => {
  const parsedValue = parseConfigValue(value)
  return isDesignPreset(parsedValue) ? parsedValue : null
}

const getLegacyTheme = (): ThemeMode | null => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const savedTheme = window.sessionStorage.getItem(LEGACY_THEME_STORAGE_KEY)
    return isThemeMode(savedTheme) ? savedTheme : null
  } catch {
    return null
  }
}

const getLegacyDesignPreset = (): DesignPreset | null => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const storedPreset = window.localStorage.getItem(LEGACY_DESIGN_PRESET_STORAGE_KEY)
    return isDesignPreset(storedPreset) ? storedPreset : null
  } catch {
    return null
  }
}

const clearLegacyThemeStorage = () => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.sessionStorage.removeItem(LEGACY_THEME_STORAGE_KEY)
  } catch {
    // Ignore restricted storage contexts.
  }

  try {
    window.localStorage.removeItem(LEGACY_DESIGN_PRESET_STORAGE_KEY)
  } catch {
    // Ignore restricted storage contexts.
  }
}

const saveAppConfig = async (key: string, value: string) => {
  const response = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value })
  })

  if (!response.ok) {
    throw new Error(`Failed to save ${key}`)
  }
}

const deleteAppConfig = async (key: string) => {
  const response = await fetch(`/api/config?keys=${encodeURIComponent(key)}`, {
    method: 'DELETE'
  })

  if (!response.ok) {
    throw new Error(`Failed to delete ${key}`)
  }
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    return getLegacyTheme() ?? getTimeBasedTheme()
  })

  const [themeSource, setThemeSource] = useState<ThemeSource>(() => {
    return getLegacyTheme() ? 'manual' : 'system'
  })
  const [designPreset, setDesignPresetState] = useState<DesignPreset>(() => getLegacyDesignPreset() ?? DEFAULT_DESIGN_PRESET)

  const setTheme = (newTheme: ThemeMode) => {
    setThemeState(newTheme)
    setThemeSource('manual')
    void saveAppConfig(THEME_COLOR_CONFIG_KEY, newTheme).catch((error) => {
      console.error('Error saving theme color config:', error)
    })
  }

  const setDesignPreset = (preset: DesignPreset) => {
    setDesignPresetState(preset)
    void saveAppConfig(THEME_STYLE_CONFIG_KEY, preset).catch((error) => {
      console.error('Error saving theme style config:', error)
    })
  }

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light'
    setTheme(newTheme)
  }

  const resetToSystem = () => {
    setThemeSource('system')
    setThemeState(getTimeBasedTheme())
    void deleteAppConfig(THEME_COLOR_CONFIG_KEY).catch((error) => {
      console.error('Error deleting theme color config:', error)
    })
  }

  useEffect(() => {
    let isMounted = true

    const syncThemeConfig = async () => {
      try {
        const response = await fetch(`/api/config?keys=${THEME_COLOR_CONFIG_KEY},${THEME_STYLE_CONFIG_KEY}`)

        if (!response.ok) {
          throw new Error('Failed to fetch theme config')
        }

        const data = await response.json()
        const config = data.config ?? {}
        const configuredTheme = getConfigTheme(config[THEME_COLOR_CONFIG_KEY])
        const configuredPreset = getConfigDesignPreset(config[THEME_STYLE_CONFIG_KEY])
        const legacyTheme = getLegacyTheme()
        const legacyPreset = getLegacyDesignPreset()
        const migrations: Array<Promise<void>> = []

        if (!isMounted) {
          return
        }

        if (configuredTheme) {
          setThemeState(configuredTheme)
          setThemeSource('manual')
        } else if (legacyTheme) {
          setThemeState(legacyTheme)
          setThemeSource('manual')
          migrations.push(saveAppConfig(THEME_COLOR_CONFIG_KEY, legacyTheme))
        } else {
          setThemeState(getTimeBasedTheme())
          setThemeSource('system')
        }

        if (configuredPreset) {
          setDesignPresetState(configuredPreset)
        } else if (legacyPreset) {
          setDesignPresetState(legacyPreset)
          migrations.push(saveAppConfig(THEME_STYLE_CONFIG_KEY, legacyPreset))
        } else {
          setDesignPresetState(DEFAULT_DESIGN_PRESET)
        }

        void Promise.all(migrations)
          .then(() => {
            clearLegacyThemeStorage()
          })
          .catch((error) => {
            console.error('Error migrating legacy theme config:', error)
          })
      } catch (error) {
        console.error('Error loading theme config:', error)
      }
    }

    void syncThemeConfig()

    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (themeSource !== 'system' || typeof window === 'undefined') {
      return
    }

    let timeoutId: number | null = null

    const runAutoThemeLoop = () => {
      setThemeState(getTimeBasedTheme())
      timeoutId = window.setTimeout(runAutoThemeLoop, msUntilNextThemeSwitch())
    }

    runAutoThemeLoop()

    return () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [themeSource])

  useEffect(() => {
    const root = document.documentElement
    const themeColors = themes[theme]

    const setVars = (prefix: string, obj: Record<string, any>) => {
      Object.entries(obj).forEach(([key, value]) => {
        const variableName = `${prefix}-${key}`
        if (typeof value === 'string') {
          root.style.setProperty(`--${variableName}`, value)
        } else if (value && typeof value === 'object') {
          setVars(variableName, value)
        }
      })
    }

    setVars('color', themeColors.colors)
    setVars('effect', themeColors.effects)

    document.body.classList.remove('light', 'dark')
    document.body.classList.add(theme)
    root.dataset.theme = theme
    document.body.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.designPreset = designPreset
    document.body.dataset.designPreset = designPreset
  }, [designPreset])

  const themeData = { ...themes[theme], ...sharedTokens }
  const isSystemTheme = themeSource === 'system'

  return (
    <ThemeContext.Provider
      value={{
        theme,
        themeData,
        toggleTheme,
        setTheme,
        themeSource,
        resetToSystem,
        isSystemTheme,
        designPreset,
        setDesignPreset,
        designPresets: DESIGN_PRESETS
      }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
