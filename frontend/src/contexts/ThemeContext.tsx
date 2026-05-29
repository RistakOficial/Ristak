import React, { createContext, useContext, useState, useEffect } from 'react'
import { themes, sharedTokens } from '@/theme/tokens'

type ThemeMode = 'light' | 'dark'
type ThemeSource = 'system' | 'manual'
export type DesignPreset = 'classic' | 'atelier' | 'editorial'

export const DESIGN_PRESETS: Array<{
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

const DESIGN_PRESET_STORAGE_KEY = 'ristak-design-preset'

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

const getSystemPreference = (): ThemeMode => {
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
}

const isDesignPreset = (value: string | null): value is DesignPreset => {
  return Boolean(value && DESIGN_PRESETS.some((preset) => preset.id === value))
}

const getStoredDesignPreset = (): DesignPreset => {
  if (typeof window === 'undefined') {
    return 'classic'
  }

  try {
    const storedPreset = window.localStorage.getItem(DESIGN_PRESET_STORAGE_KEY)
    return isDesignPreset(storedPreset) ? storedPreset : 'classic'
  } catch {
    return 'classic'
  }
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const savedTheme = sessionStorage.getItem('manualTheme') as ThemeMode | null
    if (savedTheme) {
      return savedTheme
    }
    return getSystemPreference()
  })

  const [themeSource, setThemeSource] = useState<ThemeSource>(() => {
    return sessionStorage.getItem('manualTheme') ? 'manual' : 'system'
  })
  const [designPreset, setDesignPresetState] = useState<DesignPreset>(getStoredDesignPreset)

  const setTheme = (newTheme: ThemeMode) => {
    setThemeState(newTheme)
    setThemeSource('manual')
    sessionStorage.setItem('manualTheme', newTheme)
  }

  const setDesignPreset = (preset: DesignPreset) => {
    setDesignPresetState(preset)
    try {
      window.localStorage.setItem(DESIGN_PRESET_STORAGE_KEY, preset)
    } catch {
      // Keep the selected preset in memory when localStorage is unavailable.
    }
  }

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light'
    setTheme(newTheme)
  }

  const resetToSystem = () => {
    sessionStorage.removeItem('manualTheme')
    setThemeSource('system')
    setThemeState(getSystemPreference())
  }

  useEffect(() => {
    if (themeSource !== 'system') {
      return
    }

    if (!window.matchMedia) {
      return
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const handleChange = (event: MediaQueryListEvent) => {
      if (themeSource === 'system') {
        setThemeState(event.matches ? 'dark' : 'light')
      }
    }

    mediaQuery.addEventListener('change', handleChange)

    return () => {
      mediaQuery.removeEventListener('change', handleChange)
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
