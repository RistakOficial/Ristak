import React, { createContext, useContext, useState, useEffect } from 'react'
import { themes, sharedTokens } from '@/theme/tokens'

type ThemeMode = 'light' | 'dark'
type ThemeSource = 'system' | 'manual'

interface ThemeContextType {
  theme: ThemeMode
  themeData: typeof themes.dark & typeof sharedTokens
  toggleTheme: () => void
  setTheme: (theme: ThemeMode) => void
  themeSource: ThemeSource
  resetToSystem: () => void
  isSystemTheme: boolean
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

const getSystemPreference = (): ThemeMode => {
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
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

  const setTheme = (newTheme: ThemeMode) => {
    setThemeState(newTheme)
    setThemeSource('manual')
    sessionStorage.setItem('manualTheme', newTheme)
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
        isSystemTheme
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
