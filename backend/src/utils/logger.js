// Sistema de logging con colores para consola
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
}

function timestamp() {
  return new Date().toISOString()
}

export const logger = {
  info: (...args) => {
    console.log(`${colors.cyan}[INFO]${colors.reset} ${timestamp()}:`, ...args)
  },

  success: (...args) => {
    console.log(`${colors.green}[SUCCESS]${colors.reset} ${timestamp()}:`, ...args)
  },

  warn: (...args) => {
    console.log(`${colors.yellow}[WARN]${colors.reset} ${timestamp()}:`, ...args)
  },

  error: (...args) => {
    console.error(`${colors.red}[ERROR]${colors.reset} ${timestamp()}:`, ...args)
  },

  debug: (...args) => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`${colors.magenta}[DEBUG]${colors.reset} ${timestamp()}:`, ...args)
    }
  }
}
