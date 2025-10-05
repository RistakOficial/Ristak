// Sistema SIMPLE para guardar configuración de tablas en localStorage

interface ColumnConfig {
  id: string
  visible: boolean
  order: number
}

// Guardar config de una tabla
export function saveTableConfig(tableId: string, columns: ColumnConfig[]): void {
  try {
    const key = `rstk_config_${tableId}`
    const value = JSON.stringify(columns)
    localStorage.setItem(key, value)
  } catch (error) {
    // TODO: Implement proper logging service
  }
}

// Cargar config de una tabla
export function loadTableConfig(tableId: string): ColumnConfig[] {
  try {
    const key = `rstk_config_${tableId}`
    const value = localStorage.getItem(key)

    if (!value) {
      return []
    }

    return JSON.parse(value)
  } catch (error) {
    // TODO: Implement proper logging service
    return []
  }
}

// Limpiar config de una tabla
export function clearTableConfig(tableId: string): void {
  const key = `rstk_config_${tableId}`
  localStorage.removeItem(key)
}
