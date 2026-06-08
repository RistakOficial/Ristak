import React, { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Card, Button, NumberInput, CustomSelect } from '@/components/common'
import { Plus, X, Pencil, DollarSign, Loader2, TrendingDown, Info } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { costsService, type Cost, type CreateCostDto } from '@/services/costsService'
import { useAppConfig } from '@/hooks'
import styles from './Costs.module.css'

const MANUAL_BUSINESS_EXPENSES_CONFIG_KEY = 'report_manual_business_expenses_enabled'
const MANUAL_BUSINESS_EXPENSES_COLUMN_KEY = 'businessExpenses'
const REPORT_TYPES = ['cashflow', 'attribution', 'campaigns']
const REPORT_VIEW_TYPES = ['day', 'month', 'year']
const REPORT_TABLE_CONFIG_KEYS = REPORT_TYPES.flatMap((reportType) => (
  REPORT_VIEW_TYPES.map((viewType) => `table_reports_metrics_${reportType}_${viewType}`)
))

type TableColumnConfig = { id: string; visible?: boolean; order?: number }

const parseConfigFlag = (value: unknown) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === '1' || normalized === 'true' || normalized === 'yes'
  }

  if (typeof value === 'number') return value === 1

  return Boolean(value)
}

const parseTableConfig = (value: unknown): TableColumnConfig[] => {
  if (Array.isArray(value)) return value

  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  return []
}

const normalizeTableConfigOrder = (config: TableColumnConfig[]) => (
  config.map((column, index) => ({
    ...column,
    visible: column.visible !== false,
    order: index
  }))
)

const setManualExpenseColumnVisibilityInConfig = (
  config: TableColumnConfig[],
  visible: boolean
) => {
  const currentConfig = normalizeTableConfigOrder(config)
  const existingIndex = currentConfig.findIndex((column) => column.id === MANUAL_BUSINESS_EXPENSES_COLUMN_KEY)

  if (existingIndex >= 0) {
    currentConfig[existingIndex] = {
      ...currentConfig[existingIndex],
      visible
    }
    return normalizeTableConfigOrder(currentConfig)
  }

  const manualColumn = {
    id: MANUAL_BUSINESS_EXPENSES_COLUMN_KEY,
    visible,
    order: 1
  }
  const dateIndex = currentConfig.findIndex((column) => column.id === 'date')
  const spendIndex = currentConfig.findIndex((column) => column.id === 'spend')
  const insertIndex = dateIndex >= 0
    ? dateIndex + 1
    : spendIndex >= 0
      ? spendIndex
      : Math.min(1, currentConfig.length)

  const nextConfig = [...currentConfig]
  nextConfig.splice(insertIndex, 0, manualColumn)
  return normalizeTableConfigOrder(nextConfig)
}

export const Costs: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const navigate = useNavigate()

  const [costs, setCosts] = useState<Cost[]>([])
  const [loading, setLoading] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editingCost, setEditingCost] = useState<Cost | null>(null)
  const [manualBusinessExpensesEnabled, setManualBusinessExpensesEnabled, syncingManualBusinessExpenses] =
    useAppConfig<string | number | boolean>(MANUAL_BUSINESS_EXPENSES_CONFIG_KEY, '0')
  const [manualExpenseColumnVisible, setManualExpenseColumnVisible] = useState(false)
  const [savingManualExpenseToggle, setSavingManualExpenseToggle] = useState(false)

  // Form state
  const [name, setName] = useState('')
  const [type, setType] = useState<CreateCostDto['type']>('tax')
  const [calculationType, setCalculationType] = useState<'percentage' | 'fixed'>('percentage')
  const [value, setValue] = useState('')
  const [appliesTo, setAppliesTo] = useState<'revenue' | 'profit' | ''>('revenue')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    loadCosts()
    loadManualExpenseColumnVisibility()
  }, [])

  const loadManualExpenseColumnVisibility = useCallback(async () => {
    try {
      const keysParam = REPORT_TABLE_CONFIG_KEYS.join(',')
      const response = await fetch(`/api/config?keys=${keysParam}`)
      if (!response.ok) return

      const data = await response.json()
      const config = data.config || {}
      const hasVisibleManualExpenseColumn = REPORT_TABLE_CONFIG_KEYS.some((key) => (
        parseTableConfig(config[key]).some((column) => (
          column.id === MANUAL_BUSINESS_EXPENSES_COLUMN_KEY && column.visible === true
        ))
      ))

      setManualExpenseColumnVisible(hasVisibleManualExpenseColumn)
    } catch {
      setManualExpenseColumnVisible(false)
    }
  }, [])

  const updateManualExpenseColumnVisibility = async (visible: boolean) => {
    const keysParam = REPORT_TABLE_CONFIG_KEYS.join(',')
    const response = await fetch(`/api/config?keys=${keysParam}`)
    if (!response.ok) throw new Error('No se pudo leer la configuración de columnas')

    const data = await response.json()
    const currentConfig = data.config || {}
    const updates: Record<string, string> = {}
    const nextConfigs: Record<string, TableColumnConfig[]> = {}

    REPORT_TABLE_CONFIG_KEYS.forEach((key) => {
      const nextConfig = setManualExpenseColumnVisibilityInConfig(parseTableConfig(currentConfig[key]), visible)
      nextConfigs[key] = nextConfig
      updates[key] = JSON.stringify(nextConfig)
    })

    const saveResponse = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: updates })
    })

    if (!saveResponse.ok) throw new Error('No se pudo guardar la configuración de columnas')

    Object.entries(nextConfigs).forEach(([key, nextConfig]) => {
      try {
        localStorage.setItem(`rstk_config_${key}`, JSON.stringify(nextConfig))
        window.dispatchEvent(new CustomEvent('config-sync', {
          detail: { key, value: nextConfig }
        }))
      } catch {
        // localStorage puede fallar en modos privados; la DB sigue siendo la fuente de verdad.
      }
    })
  }

  const handleManualBusinessExpensesToggle = async (checked: boolean) => {
    setSavingManualExpenseToggle(true)
    try {
      await updateManualExpenseColumnVisibility(checked)
      await setManualBusinessExpensesEnabled(checked ? '1' : '0')
      setManualExpenseColumnVisible(checked)
      return true
    } catch (error: any) {
      showToast('error', 'No se pudo guardar la configuración', error?.message || 'Intenta nuevamente')
      return false
    } finally {
      setSavingManualExpenseToggle(false)
    }
  }

  const manualReportCostsActive = parseConfigFlag(manualBusinessExpensesEnabled) && manualExpenseColumnVisible
  const manualReportCostsBusy = syncingManualBusinessExpenses || savingManualExpenseToggle

  const handleOpenVariableCostsReport = async () => {
    if (!manualReportCostsActive) {
      const activated = await handleManualBusinessExpensesToggle(true)
      if (!activated) return
    }

    navigate('/reports/table/month/cashflow')
  }

  const loadCosts = async () => {
    setLoading(true)
    try {
      const data = await costsService.getAllCosts()
      setCosts(data)
    } catch (error: any) {
      showToast('error', 'Error al cargar costos', error.message)
    } finally {
      setLoading(false)
    }
  }

  const openCreateModal = () => {
    // Resetear form
    setEditingCost(null)
    setName('')
    setType('tax')
    setCalculationType('percentage')
    setValue('')
    setAppliesTo('revenue')
    setShowModal(true)
  }

  const openEditModal = (cost: Cost) => {
    setEditingCost(cost)
    setName(cost.name)
    setType(cost.type)
    setCalculationType(cost.calculation_type)
    setValue(cost.value.toString())
    setAppliesTo(cost.applies_to || '')
    setShowModal(true)
  }

  const handleSave = async () => {
    // Validaciones
    if (!name.trim()) {
      showToast('warning', 'Nombre requerido', 'Ingresa un nombre para el costo')
      return
    }

    const numValue = parseFloat(value)
    if (isNaN(numValue) || numValue < 0) {
      showToast('warning', 'Valor inválido', 'Ingresa un valor numérico positivo')
      return
    }

    if (calculationType === 'percentage' && numValue > 100) {
      showToast('warning', 'Valor inválido', 'El porcentaje debe estar entre 0 y 100')
      return
    }

    setSaving(true)
    try {
      const data: CreateCostDto = {
        name: name.trim(),
        type,
        calculation_type: calculationType,
        value: numValue,
        applies_to: appliesTo || null
      }

      if (editingCost) {
        // Actualizar
        await costsService.updateCost(editingCost.id, data)
        showToast('success', 'Costo actualizado', 'El costo se actualizó correctamente')
      } else {
        // Crear
        await costsService.createCost(data)
        showToast('success', 'Costo creado', 'El costo se agregó correctamente')
      }

      setShowModal(false)
      await loadCosts()
    } catch (error: any) {
      showToast('error', 'Error al guardar', error.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = (cost: Cost) => {
    showConfirm(
      'Eliminar costo',
      `¿Estás seguro de eliminar "${cost.name}"?`,
      async () => {
        try {
          await costsService.deleteCost(cost.id)
          showToast('success', 'Costo eliminado', 'El costo se eliminó correctamente')
          await loadCosts()
        } catch (error: any) {
          showToast('error', 'Error al eliminar', error.message)
        }
      },
      'Eliminar',
      'Cancelar'
    )
  }

  const getCostTypeColor = (type: Cost['type']) => {
    const colors: Record<Cost['type'], string> = {
      tax: '#3b82f6',
      commission: '#8b5cf6',
      rent: '#ec4899',
      service: '#10b981',
      other: '#6b7280'
    }
    return colors[type] || colors.other
  }

  return (
    <div className={styles.container}>
      <Card className={styles.card}>
        <div className={styles.header}>
          <div className={styles.titleSection}>
            <div className={styles.iconWrapper}>
              <TrendingDown size={24} />
            </div>
            <div>
              <h2 className={styles.title}>Gestión de Costos (fijos)</h2>
              <p className={styles.subtitle}>
                Configura impuestos, comisiones y gastos fijos. Los montos ingresados se consideran valores <strong>mensuales</strong> y se reflejan en el reporte mensual.
              </p>
            </div>
          </div>

          <Button
            onClick={openCreateModal}
            variant="primary"
            disabled={loading}
          >
            <Plus size={18} />
            Agregar costo
          </Button>
        </div>

        <div className={styles.infoNote}>
          <Info size={15} />
          <span>
            Cada costo que agregues aquí se interpreta como un <strong>gasto mensual fijo</strong>. En el reporte mensual verás el monto exacto; en reportes de días o años el valor se prorratea automáticamente.
          </span>
        </div>

        {loading ? (
          <div className={styles.loadingContainer}>
            <Loader2 size={32} className={styles.spinner} />
            <p>Cargando costos...</p>
          </div>
        ) : costs.length === 0 ? (
          <div className={styles.emptyState}>
            <DollarSign size={48} strokeWidth={1.5} />
            <h3>No hay costos configurados</h3>
            <p>Agrega impuestos, comisiones o gastos para calcular tu ganancia neta</p>
            <Button onClick={openCreateModal} variant="primary">
              <Plus size={18} />
              Agregar primer costo
            </Button>
          </div>
        ) : (
          <div className={styles.costsGrid}>
            {costs.map((cost) => (
              <div
                key={cost.id}
                className={styles.costChip}
                style={{ borderColor: getCostTypeColor(cost.type) }}
              >
                <div className={styles.costHeader}>
                  <div
                    className={styles.costTypeIndicator}
                    style={{ backgroundColor: getCostTypeColor(cost.type) }}
                  />
                  <span className={styles.costType}>
                    {costsService.translateType(cost.type)}
                  </span>
                </div>

                <div className={styles.costBody}>
                  <h4 className={styles.costName}>{cost.name}</h4>
                  <div className={styles.costValue}>
                    {costsService.formatValue(cost)}
                  </div>
                  {cost.calculation_type === 'percentage' && cost.applies_to && (
                    <div className={styles.appliesTo}>
                      sobre {cost.applies_to === 'revenue' ? 'ingresos' : 'ganancias'}
                    </div>
                  )}
                </div>

                <div className={styles.costActions}>
                  <button
                    className={styles.actionButton}
                    onClick={() => openEditModal(cost)}
                    title="Editar"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className={styles.actionButton}
                    onClick={() => handleDelete(cost)}
                    title="Eliminar"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className={`${styles.card} ${styles.variablesCard}`}>
        <div className={styles.header}>
          <div className={styles.titleSection}>
            <div className={styles.iconWrapper}>
              <DollarSign size={24} />
            </div>
            <div>
              <h2 className={styles.title}>Gestión de Costos variables</h2>
              <p className={styles.subtitle}>
                Activa la columna de reportes para capturar manualmente los costos variables por día, mes o año
              </p>
            </div>
          </div>

          <Button
            onClick={handleOpenVariableCostsReport}
            variant={manualReportCostsActive ? 'secondary' : 'primary'}
            disabled={manualReportCostsBusy}
          >
            <Plus size={18} />
            {manualReportCostsActive ? 'Abrir Reportes' : 'Activar y abrir Reportes'}
          </Button>
        </div>

        <div className={styles.manualReportToggle}>
          <div className={styles.manualReportToggleText}>
            <span className={styles.manualReportToggleTitle}>Costos manuales en reporte</span>
            <span className={styles.manualReportToggleState}>
              {manualReportCostsActive ? 'Activo' : 'Inactivo'}
            </span>
          </div>
          <label className={styles.switchControl}>
            <input
              type="checkbox"
              checked={manualReportCostsActive}
              disabled={manualReportCostsBusy}
              onChange={(event) => handleManualBusinessExpensesToggle(event.target.checked)}
            />
            <span className={styles.switchTrack} />
          </label>
        </div>
      </Card>

      {/* Modal para crear/editar costo */}
      {showModal && createPortal(
        <div className={styles.modalOverlay} onClick={() => setShowModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>{editingCost ? 'Editar costo' : 'Nuevo costo'}</h3>
              <button className={styles.closeButton} onClick={() => setShowModal(false)}>
                <X size={20} />
              </button>
            </div>

            <div className={styles.modalBody}>
              {/* Nombre */}
              <div className={styles.formGroup}>
                <label>Nombre *</label>
                <input
                  type="text"
                  className={styles.input}
                  placeholder="Ej: IVA 16%, Renta de oficina, Comisión de ventas"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              {/* Tipo */}
              <div className={styles.formGroup}>
                <label>Tipo *</label>
                <CustomSelect
                  value={type}
                  onChange={(e) => setType(e.target.value as CreateCostDto['type'])}
                >
                  <option value="tax">Impuesto</option>
                  <option value="commission">Comisión</option>
                  <option value="rent">Renta</option>
                  <option value="service">Servicio</option>
                  <option value="other">Otro</option>
                </CustomSelect>
              </div>

              {/* Tipo de cálculo */}
              <div className={styles.formGroup}>
                <label>Cálculo *</label>
                <div className={styles.radioGroup}>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      name="calculation_type"
                      value="percentage"
                      checked={calculationType === 'percentage'}
                      onChange={() => setCalculationType('percentage')}
                    />
                    Porcentaje (%)
                  </label>
                  <label className={styles.radioLabel}>
                    <input
                      type="radio"
                      name="calculation_type"
                      value="fixed"
                      checked={calculationType === 'fixed'}
                      onChange={() => setCalculationType('fixed')}
                    />
                    Monto fijo ($)
                  </label>
                </div>
              </div>

              {/* Valor */}
              <div className={styles.formGroup}>
                <label>
                  {calculationType === 'percentage' ? 'Porcentaje *' : 'Monto *'}
                </label>
                <div className={styles.inputWithPrefix}>
                  <span className={styles.prefix}>
                    {calculationType === 'percentage' ? '%' : '$'}
                  </span>
                  <NumberInput
                    className={styles.input}
                    placeholder={calculationType === 'percentage' ? '0-100' : '0.00'}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    min="0"
                    max={calculationType === 'percentage' ? '100' : undefined}
                    step={calculationType === 'percentage' ? '0.1' : '0.01'}
                  />
                </div>
              </div>

              {/* Aplica sobre (solo para porcentajes) */}
              {calculationType === 'percentage' && (
                <div className={styles.formGroup}>
                  <label>Aplica sobre</label>
                  <CustomSelect
                    value={appliesTo}
                    onChange={(e) => setAppliesTo(e.target.value as any)}
                  >
                    <option value="revenue">Ingresos totales</option>
                    <option value="profit">Ganancias netas</option>
                    <option value="">No aplica</option>
                  </CustomSelect>
                </div>
              )}
            </div>

            <div className={styles.modalFooter}>
              <Button
                variant="ghost"
                onClick={() => setShowModal(false)}
                disabled={saving}
              >
                Cancelar
              </Button>
              <Button
                variant="primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <>
                    <Loader2 size={16} className={styles.spinner} />
                    Guardando...
                  </>
                ) : (
                  editingCost ? 'Actualizar' : 'Crear'
                )}
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
