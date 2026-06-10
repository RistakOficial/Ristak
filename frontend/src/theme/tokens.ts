// Tokens TS (gráficas y temas). La fuente de verdad del sistema visual son las
// variables CSS de src/styles/index.css y la guía docs/DESIGN_SYSTEM.md —
// mantener ambos en sincronía si se cambia un color o radio aquí.
export const themes = {
  light: {
    colors: {
      background: {
        primary: '#ffffff',
        secondary: '#ffffff',
        tertiary: '#fafafa',
        glass: 'rgba(255, 255, 255, 0.6)',
        glassBorder: 'rgba(0, 0, 0, 0.06)'
      },
      text: {
        primary: '#000000',
        secondary: '#374151',
        tertiary: '#6b7280',
        muted: '#9ca3af',
        onAccent: '#ffffff'
      },
      accent: {
        blue: '#64748b',
        purple: '#8b5cf6',
        pink: '#ec4899',
        green: '#10b981',
        orange: '#f97316',
        red: '#dc2626'
      },
      chart: {
        income: '#64748b',
        outcome: '#f97316',
        metricLine: '#374151',
        grid: 'rgba(17, 24, 39, 0.06)',
        gradients: {
          income: {
            start: 'rgba(100, 116, 139, 0.25)',
            middle: 'rgba(100, 116, 139, 0.15)',
            end: 'rgba(100, 116, 139, 0.05)'
          },
          outcome: {
            start: 'rgba(249, 115, 22, 0.25)',
            middle: 'rgba(249, 115, 22, 0.15)',
            end: 'rgba(249, 115, 22, 0.05)'
          }
        }
      },
      status: {
        success: '#10b981',
        warning: '#f59e0b',
        error: '#dc2626',
        info: '#64748b'
      },
      gradients: {
        subtle: {
          blue: 'linear-gradient(135deg, rgba(100, 116, 139, 0.05) 0%, rgba(30, 41, 59, 0.05) 100%)',
          purple: 'linear-gradient(135deg, rgba(30, 41, 59, 0.05) 0%, rgba(100, 116, 139, 0.05) 100%)',
          green: 'linear-gradient(135deg, rgba(16, 185, 129, 0.05) 0%, rgba(100, 116, 139, 0.05) 100%)',
          orange: 'linear-gradient(135deg, rgba(249, 115, 22, 0.05) 0%, rgba(239, 68, 68, 0.05) 100%)'
        },
        card: {
          default: 'linear-gradient(135deg, rgba(100, 116, 139, 0.03) 0%, rgba(30, 41, 59, 0.03) 100%)',
          hover: 'linear-gradient(135deg, rgba(100, 116, 139, 0.06) 0%, rgba(30, 41, 59, 0.06) 100%)'
        },
        background: {
          main: 'linear-gradient(135deg, #ffffff 0%, #f9fbff 100%)',
          image: 'none',
          overlay: 'linear-gradient(180deg, rgba(255, 255, 255, 0.4) 0%, rgba(255, 255, 255, 0) 100%)'
        }
      }
    },
    effects: {
      glassMorphism: {
        background: 'rgba(255, 255, 255, 0.95)',
        backdropFilter: 'none',
        border: '1px solid rgba(0, 0, 0, 0.06)'
      },
      shadow: {
        sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
        md: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
        lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
        xl: '0 20px 25px -5px rgba(0, 0, 0, 0.1)'
      }
    }
  },
  dark: {
    colors: {
      background: {
        primary: '#0a0b0d',
        secondary: '#141518',
        tertiary: '#1a1b1f',
        glass: 'rgba(255, 255, 255, 0.03)',
        glassBorder: 'rgba(255, 255, 255, 0.08)'
      },
      text: {
        primary: '#ffffff',
        secondary: '#e5e7eb',
        tertiary: '#9ca3af',
        muted: '#6b7280',
        onAccent: '#ffffff'
      },
      accent: {
        blue: '#64748b',
        purple: '#8b5cf6',
        pink: '#ec4899',
        green: '#10b981',
        orange: '#f97316',
        red: '#dc2626'
      },
      chart: {
        income: '#64748b',
        outcome: '#f97316',
        metricLine: '#f3f4f6',
        grid: 'rgba(255, 255, 255, 0.08)',
        gradients: {
          income: {
            start: 'rgba(100, 116, 139, 0.35)',
            middle: 'rgba(100, 116, 139, 0.2)',
            end: 'rgba(100, 116, 139, 0.08)'
          },
          outcome: {
            start: 'rgba(249, 115, 22, 0.35)',
            middle: 'rgba(249, 115, 22, 0.2)',
            end: 'rgba(249, 115, 22, 0.08)'
          }
        }
      },
      status: {
        success: '#10b981',
        warning: '#f59e0b',
        error: '#dc2626',
        info: '#64748b'
      },
      gradients: {
        subtle: {
          blue: 'linear-gradient(135deg, rgba(100, 116, 139, 0.08) 0%, rgba(30, 41, 59, 0.08) 100%)',
          purple: 'linear-gradient(135deg, rgba(30, 41, 59, 0.08) 0%, rgba(100, 116, 139, 0.08) 100%)',
          green: 'linear-gradient(135deg, rgba(16, 185, 129, 0.08) 0%, rgba(100, 116, 139, 0.08) 100%)',
          orange: 'linear-gradient(135deg, rgba(249, 115, 22, 0.08) 0%, rgba(239, 68, 68, 0.08) 100%)'
        },
        card: {
          default: 'linear-gradient(135deg, rgba(100, 116, 139, 0.05) 0%, rgba(30, 41, 59, 0.05) 100%)',
          hover: 'linear-gradient(135deg, rgba(100, 116, 139, 0.08) 0%, rgba(30, 41, 59, 0.08) 100%)'
        },
        background: {
          main: 'url("https://images.unsplash.com/photo-1518709268805-4e9042af2176?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D&auto=format&fit=crop&w=2025&q=80")',
          overlay: 'linear-gradient(135deg, rgba(10, 11, 13, 0.35) 0%, rgba(20, 21, 24, 0.4) 50%, rgba(10, 11, 13, 0.48) 100%)'
        }
      }
    },
    effects: {
      glassMorphism: {
        background: 'rgba(255, 255, 255, 0.04)',
        backdropFilter: 'blur(18px) saturate(1.1)',
        border: '1px solid rgba(255, 255, 255, 0.12)'
      },
      shadow: {
        sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
        md: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
        lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
        xl: '0 20px 25px -5px rgba(0, 0, 0, 0.1)'
      }
    }
  }
}

export const sharedTokens = {
  spacing: {
    xs: '0.25rem',
    sm: '0.5rem',
    md: '1rem',
    lg: '1.5rem',
    xl: '2rem',
    '2xl': '3rem',
    '3xl': '4rem'
  },
  borderRadius: {
    sm: '0.5rem',
    md: '0.75rem',
    lg: '1rem',
    xl: '1.25rem',
    '2xl': '1.5rem',
    full: '9999px'
  },
  fontSize: {
    xs: '0.75rem',
    sm: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    '2xl': '1.5rem',
    '3xl': '1.875rem',
    '4xl': '2.25rem'
  },
  fontWeight: {
    normal: '400',
    medium: '500',
    semibold: '600',
    bold: '700'
  },
  animation: {
    quick: '150ms cubic-bezier(0.4, 0, 0.2, 1)',
    base: '200ms cubic-bezier(0.4, 0, 0.2, 1)',
    slow: '300ms cubic-bezier(0.4, 0, 0.2, 1)'
  }
}
