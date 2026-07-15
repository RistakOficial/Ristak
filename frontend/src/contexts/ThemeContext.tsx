import React, { createContext, useContext, useState, useEffect } from 'react'
import { apiUrl } from '@/services/apiBaseUrl'
import { AUTH_PRINCIPAL_CHANGED_EVENT } from '@/services/authPrincipalCache'
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
const THEME_DIR_CONFIG_KEY = 'theme_dir'
// El sistema de presets antiguo (atelier/editorial) queda sustituido por las 4
// familias visuales (data-dir). Forzamos 'classic' para neutralizar las reglas
// de preset y dejar que el sistema nuevo gobierne la estética.
const DEFAULT_DESIGN_PRESET: DesignPreset = 'classic'
const DEFAULT_THEME_DIR: ThemeDir = 'en'
const LEGACY_THEME_STORAGE_KEY = 'manualTheme'
const LEGACY_DESIGN_PRESET_STORAGE_KEY = 'ristak-design-preset'

// ===== Familias visuales (data-dir) =====
export type ThemeDir =
  | 'a' | 'av' | 'ab' | 'am'
  | 'c' | 'cb' | 'cv' | 'ca'
  | 'd' | 'db' | 'dl' | 'dm'
  | 'e' | 'en' | 'eb' | 'em'

export interface ThemeVariant {
  dir: ThemeDir
  label: string
}

export interface ThemeFamily {
  id: string
  label: string
  description: string
  variants: ThemeVariant[]
}

export const THEME_FAMILIES: ThemeFamily[] = [
  {
    id: 'aurora',
    label: 'Aurora',
    description: 'Glass, profundidad y degradados suaves',
    variants: [
      { dir: 'en', label: 'Neutral' },
      { dir: 'e', label: 'Violeta' },
      { dir: 'eb', label: 'Azul' },
      { dir: 'em', label: 'Sobria' }
    ]
  },
  {
    id: 'onyx',
    label: 'Onyx',
    description: 'Alto contraste, panel lateral oscuro',
    variants: [
      { dir: 'c', label: 'Esmeralda' },
      { dir: 'cb', label: 'Azul' },
      { dir: 'cv', label: 'Violeta' },
      { dir: 'ca', label: 'Ámbar' }
    ]
  },
  {
    id: 'brut',
    label: 'Brut',
    description: 'Neobrutalismo: bordes duros, tipografía mono',
    variants: [
      { dir: 'd', label: 'Rojo' },
      { dir: 'db', label: 'Azul' },
      { dir: 'dl', label: 'Lima' },
      { dir: 'dm', label: 'Magenta' }
    ]
  },
  {
    id: 'nimbus',
    label: 'Nimbus',
    description: 'Limpio, profesional, neutro frío',
    variants: [
      { dir: 'a', label: 'Clásico' },
      { dir: 'av', label: 'Violeta' },
      { dir: 'ab', label: 'Azul' },
      { dir: 'am', label: 'Sobria' }
    ]
  }
]

const ALL_THEME_DIRS = THEME_FAMILIES.flatMap((family) => family.variants.map((variant) => variant.dir))

const isThemeDir = (value: unknown): value is ThemeDir =>
  typeof value === 'string' && (ALL_THEME_DIRS as string[]).includes(value)

const getConfigThemeDir = (value: unknown): ThemeDir | null => {
  const parsed = parseConfigValue(value)
  return isThemeDir(parsed) ? parsed : null
}
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
  themeDir: ThemeDir
  setThemeDir: (dir: ThemeDir) => void
  themeFamilies: ThemeFamily[]
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
  const response = await fetch(apiUrl('/api/config'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value })
  })

  if (!response.ok) {
    throw new Error(`Failed to save ${key}`)
  }
}

const deleteAppConfig = async (key: string) => {
  const response = await fetch(apiUrl(`/api/config?keys=${encodeURIComponent(key)}`), {
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
  const [themeDir, setThemeDirState] = useState<ThemeDir>(DEFAULT_THEME_DIR)

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

  const setThemeDir = (dir: ThemeDir) => {
    setThemeDirState(dir)
    void saveAppConfig(THEME_DIR_CONFIG_KEY, dir).catch((error) => {
      console.error('Error saving theme dir config:', error)
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
    let syncRequestVersion = 0

    const syncThemeConfig = async () => {
      const requestVersion = ++syncRequestVersion
      let hasAuthenticatedSession = false
      try {
        hasAuthenticatedSession = Boolean(window.localStorage.getItem('auth_token'))
      } catch {
        // Storage restringido: conservar el tema local sin hacer una lectura privada.
      }

      if (!hasAuthenticatedSession) {
        return
      }

      try {
        const response = await fetch(apiUrl(`/api/config?keys=${THEME_COLOR_CONFIG_KEY},${THEME_DIR_CONFIG_KEY}`))

        if (!response.ok) {
          // La sesión pudo cerrarse mientras la petición estaba en vuelo. No es
          // un error de tema ni debe ensuciar la consola de login.
          if (response.status === 401) return
          throw new Error('Failed to fetch theme config')
        }

        const data = await response.json()
        const config = data.config ?? {}
        const configuredTheme = getConfigTheme(config[THEME_COLOR_CONFIG_KEY])
        const configuredDir = getConfigThemeDir(config[THEME_DIR_CONFIG_KEY])
        const legacyTheme = getLegacyTheme()
        const migrations: Array<Promise<void>> = []

        if (!isMounted || requestVersion !== syncRequestVersion) {
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

        // El preset antiguo queda neutralizado en 'classic'; la familia visual
        // se gobierna con theme_dir.
        setDesignPresetState(DEFAULT_DESIGN_PRESET)
        // ThemeProvider sobrevive logout/login. Una cuenta sin theme_dir no
        // debe heredar en memoria la familia visual de la cuenta anterior.
        setThemeDirState(configuredDir || DEFAULT_THEME_DIR)

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

    const handleAuthPrincipalChanged = (event: Event) => {
      // El provider no se desmonta entre cuentas. Borramos primero cualquier
      // apariencia privada anterior; si la nueva lectura falla, jamás queda
      // visible el tema de otro negocio.
      syncRequestVersion += 1
      setThemeState(getTimeBasedTheme())
      setThemeSource('system')
      setDesignPresetState(DEFAULT_DESIGN_PRESET)
      setThemeDirState(DEFAULT_THEME_DIR)
      const authenticated = Boolean(
        (event as CustomEvent<{ authenticated?: boolean }>).detail?.authenticated
      )
      if (authenticated) void syncThemeConfig()
    }
    window.addEventListener(AUTH_PRINCIPAL_CHANGED_EVENT, handleAuthPrincipalChanged)

    return () => {
      isMounted = false
      syncRequestVersion += 1
      window.removeEventListener(AUTH_PRINCIPAL_CHANGED_EVENT, handleAuthPrincipalChanged)
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
    // El color ya no se inyecta como variables inline en <html>: el sistema de
    // diseño global (familias + modo) lo resuelve por CSS. Aquí solo marcamos el
    // modo (clase + data-theme/data-mode) que sirve de gancho a los selectores.
    const root = document.documentElement
    document.body.classList.remove('light', 'dark')
    document.body.classList.add(theme)
    root.dataset.theme = theme
    document.body.dataset.theme = theme
    root.dataset.mode = theme
    document.body.dataset.mode = theme
  }, [theme])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.designPreset = designPreset
    document.body.dataset.designPreset = designPreset
  }, [designPreset])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.dir = themeDir
    document.body.dataset.dir = themeDir
  }, [themeDir])

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
        designPresets: DESIGN_PRESETS,
        themeDir,
        setThemeDir,
        themeFamilies: THEME_FAMILIES
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
