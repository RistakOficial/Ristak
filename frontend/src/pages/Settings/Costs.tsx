import React, { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Card, Button, NumberInput, CustomSelect, Switch, Badge } from '@/components/common'
import { Plus, X, Pencil, DollarSign, Loader2, TrendingDown, Info } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { costsService, type Cost, type CreateCostDto } from '@/services/costsService'
import { useAppConfig } from '@/hooks'
import styles from './Costs.module.css'

const MANUAL_BUSINESS_EXPENSES_CONFIG_KEY = 'report_manual_business_expenses_enabled'
const MANUAL_BUSINESS_EXPENSES_COLUMN_KEY = 'businessExpenses'
const FIXED_BUSINESS_EXPENSES_COLUMN_KEY = 'fixedBusinessExpenses'
const REPORT_TYPES = ['cashflow', 'attribution', 'campaigns']
const REPORT_VIEW_TYPES = ['day', 'month', 'year']
const REPORT_TABLE_CONFIG_KEYS = REPORT_TYPES.flatMap((reportType) => (
  REPORT_VIEW_TYPES.map((viewType) => `table_reports_metrics_${reportType}_${viewType}`)
))

type TableColumnConfig = { id: string; visible?: boolean; order?: number }
type CostTypeGroup = {
  label: string
  options: Array<{ value: string; label: string }>
}

const COST_TYPE_GROUPS: CostTypeGroup[] = [
  {
    label: 'Personal',
    options: [
      { value: 'payroll', label: 'Sueldos' },
      { value: 'payroll_taxes', label: 'Cargas sociales y nómina' },
      { value: 'bonuses', label: 'Bonos y comisiones internas' },
      { value: 'contractors', label: 'Honorarios y contratistas' }
    ]
  },
  {
    label: 'Operación',
    options: [
      { value: 'rent', label: 'Renta' },
      { value: 'utilities', label: 'Servicios básicos' },
      { value: 'internet_phone', label: 'Internet y telefonía' },
      { value: 'software', label: 'Software y suscripciones' },
      { value: 'equipment', label: 'Equipo y herramientas' },
      { value: 'maintenance', label: 'Mantenimiento' },
      { value: 'office_supplies', label: 'Papelería e insumos de oficina' },
      { value: 'cleaning', label: 'Limpieza' },
      { value: 'security', label: 'Seguridad' },
      { value: 'insurance', label: 'Seguros' }
    ]
  },
  {
    label: 'Ventas y marketing',
    options: [
      { value: 'marketing', label: 'Publicidad y marketing' },
      { value: 'sales_commission', label: 'Comisiones de venta' },
      { value: 'payment_processing', label: 'Comisiones de pasarela' },
      { value: 'customer_support', label: 'Atención al cliente' },
      { value: 'refunds', label: 'Reembolsos y garantías' }
    ]
  },
  {
    label: 'Producto e inventario',
    options: [
      { value: 'product_cost', label: 'Costo de producto' },
      { value: 'inventory', label: 'Inventario' },
      { value: 'raw_materials', label: 'Materia prima' },
      { value: 'packaging', label: 'Empaque' }
    ]
  },
  {
    label: 'Logística',
    options: [
      { value: 'shipping', label: 'Envíos y logística' },
      { value: 'storage', label: 'Almacenamiento' },
      { value: 'transport', label: 'Transporte y gasolina' }
    ]
  },
  {
    label: 'Administración y finanzas',
    options: [
      { value: 'tax', label: 'Impuestos' },
      { value: 'accounting', label: 'Contabilidad' },
      { value: 'legal', label: 'Legal' },
      { value: 'bank_fees', label: 'Comisiones bancarias' },
      { value: 'loan_interest', label: 'Intereses y financiamiento' },
      { value: 'licenses', label: 'Permisos y licencias' },
      { value: 'training', label: 'Capacitación' },
      { value: 'travel', label: 'Viajes y viáticos' },
      { value: 'other', label: 'Otro' }
    ]
  }
]

const COST_TYPE_TONES: Record<string, string> = {
  payroll: 'var(--accent)',
  payroll_taxes: 'var(--accent)',
  bonuses: 'var(--accent-2)',
  contractors: 'var(--accent-2)',
  rent: 'var(--warn)',
  utilities: 'var(--info)',
  internet_phone: 'var(--info)',
  software: 'var(--accent-2)',
  equipment: 'var(--text-dim)',
  maintenance: 'var(--warn)',
  office_supplies: 'var(--text-mute)',
  cleaning: 'var(--pos)',
  security: 'var(--text-dim)',
  insurance: 'var(--info)',
  marketing: 'var(--accent)',
  sales_commission: 'var(--accent-2)',
  payment_processing: 'var(--accent-2)',
  customer_support: 'var(--info)',
  refunds: 'var(--neg)',
  product_cost: 'var(--warn)',
  inventory: 'var(--warn)',
  raw_materials: 'var(--warn)',
  packaging: 'var(--text-dim)',
  shipping: 'var(--pos)',
  storage: 'var(--text-dim)',
  transport: 'var(--pos)',
  tax: 'var(--info)',
  accounting: 'var(--accent-2)',
  legal: 'var(--accent-2)',
  bank_fees: 'var(--neg)',
  loan_interest: 'var(--neg)',
  licenses: 'var(--info)',
  training: 'var(--accent)',
  travel: 'var(--pos)',
  commission: 'var(--accent-2)',
  service: 'var(--pos)',
  other: 'var(--text-mute)'
}

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

const getManualExpenseColumnInsertIndex = (config: TableColumnConfig[]) => {
  const dateIndex = config.findIndex((column) => column.id === 'date')
  const fixedExpensesIndex = config.findIndex((column) => column.id === FIXED_BUSINESS_EXPENSES_COLUMN_KEY)
  const spendIndex = config.findIndex((column) => column.id === 'spend')

  if (fixedExpensesIndex >= 0) return fixedExpensesIndex + 1
  if (spendIndex >= 0) return spendIndex
  if (dateIndex >= 0) return dateIndex + 1
  return Math.min(4, config.length)
}

const setManualExpenseColumnVisibilityInConfig = (
  config: TableColumnConfig[],
  visible: boolean
) => {
  const currentConfig = normalizeTableConfigOrder(config)
  const existingIndex = currentConfig.findIndex((column) => column.id === MANUAL_BUSINESS_EXPENSES_COLUMN_KEY)

  if (existingIndex >= 0) {
    const [existingColumn] = currentConfig.splice(existingIndex, 1)
    const insertIndex = visible
      ? getManualExpenseColumnInsertIndex(currentConfig)
      : Math.min(existingIndex, currentConfig.length)

    currentConfig.splice(insertIndex, 0, {
      ...existingColumn,
      visible
    })

    return normalizeTableConfigOrder(currentConfig)
  }

  const manualColumn = {
    id: MANUAL_BUSINESS_EXPENSES_COLUMN_KEY,
    visible,
    order: 4
  }
  const insertIndex = getManualExpenseColumnInsertIndex(currentConfig)

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
    useAppConfig<string | number | boolean>(MANUAL_BUSINESS_EXPENSES_CONFIG_KEY, '1')
  const [manualExpenseColumnVisible, setManualExpenseColumnVisible] = useState(false)
  const [savingManualExpenseToggle, setSavingManualExpenseToggle] = useState(false)

  // Form state
  const [name, setName] = useState('')
  const [type, setType] = useState<CreateCostDto['type']>('payroll')
  const [calculationType, setCalculationType] = useState<'percentage' | 'fixed'>('fixed')
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
    setType('payroll')
    setCalculationType('fixed')
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
        applies_to: calculationType === 'percentage' ? appliesTo || null : null
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
    return COST_TYPE_TONES[type] || COST_TYPE_TONES.other
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
                Configura sueldos, renta, operación, comisiones y gastos fijos. Los montos ingresados se consideran valores <strong>mensuales</strong> y se reflejan en el reporte mensual.
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
          <div className={styles.loadingContainer} role="status" aria-live="polite" aria-label="Cargando costos">
            <Loader2 size={32} className={styles.spinner} aria-hidden="true" />
          </div>
        ) : costs.length === 0 ? (
          <div className={styles.emptyState}>
            <DollarSign size={48} strokeWidth={1.5} />
            <h3>No hay costos configurados</h3>
            <p>Agrega sueldos, renta, comisiones o gastos para calcular tu ganancia neta</p>
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
            <Badge variant={manualReportCostsActive ? 'success' : 'neutral'}>
              {manualReportCostsActive ? 'Activo' : 'Inactivo'}
            </Badge>
          </div>
          <Switch
            checked={manualReportCostsActive}
            disabled={manualReportCostsBusy}
            onChange={(checked) => handleManualBusinessExpensesToggle(checked)}
          />
        </div>
      </Card>

      {/* Modal para crear/editar costo */}
      {showModal && createPortal(
        <div className={styles.modalOverlay} data-overlay="" onClick={() => setShowModal(false)}>
          <div
            className={styles.modal}
            data-modal=""
            data-modal-shell="legacy"
            data-modal-size="md"
            data-modal-type="custom"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader} data-modal-header="">
              <h3>{editingCost ? 'Editar costo' : 'Nuevo costo'}</h3>
              <button className={styles.closeButton} onClick={() => setShowModal(false)}>
                <X size={20} />
              </button>
            </div>

            <div className={styles.modalBody} data-modal-content="">
              {/* Nombre */}
              <div className={styles.formGroup}>
                <label>Nombre *</label>
                <input
                  type="text"
                  className={styles.input}
                  placeholder="Ej: Sueldos administrativos, Renta de oficina, Software mensual"
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
                  {COST_TYPE_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </optgroup>
                  ))}
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
                      value="fixed"
                      checked={calculationType === 'fixed'}
                      onChange={() => setCalculationType('fixed')}
                    />
                    Monto fijo ($)
                  </label>
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
                </div>
              </div>

              {/* Valor */}
              <div className={styles.formGroup}>
                <label>
                  {calculationType === 'percentage' ? 'Porcentaje *' : 'Monto fijo *'}
                </label>
                <div className={styles.inputWithPrefix}>
                  <span className={styles.prefix}>
                    {calculationType === 'percentage' ? '%' : '$'}
                  </span>
                  <NumberInput
                    className={`${styles.input} ${styles.prefixedInput}`}
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

            <div className={styles.modalFooter} data-modal-footer="">
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
