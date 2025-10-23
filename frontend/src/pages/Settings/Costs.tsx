import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Card, Button } from '@/components/common'
import { Plus, X, Pencil, DollarSign, Loader2, TrendingDown } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { costsService, type Cost, type CreateCostDto } from '@/services/costsService'
import styles from './Costs.module.css'

export const Costs: React.FC = () => {
  const { showToast, showConfirm } = useNotification()

  const [costs, setCosts] = useState<Cost[]>([])
  const [loading, setLoading] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editingCost, setEditingCost] = useState<Cost | null>(null)

  // Form state
  const [name, setName] = useState('')
  const [type, setType] = useState<CreateCostDto['type']>('tax')
  const [calculationType, setCalculationType] = useState<'percentage' | 'fixed'>('percentage')
  const [value, setValue] = useState('')
  const [appliesTo, setAppliesTo] = useState<'revenue' | 'profit' | ''>('revenue')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    loadCosts()
  }, [])

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
              <h2 className={styles.title}>Gestión de Costos</h2>
              <p className={styles.subtitle}>
                Configura impuestos, comisiones y gastos fijos que se restarán de tus ingresos
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
                <select
                  className={styles.select}
                  value={type}
                  onChange={(e) => setType(e.target.value as CreateCostDto['type'])}
                >
                  <option value="tax">Impuesto</option>
                  <option value="commission">Comisión</option>
                  <option value="rent">Renta</option>
                  <option value="service">Servicio</option>
                  <option value="other">Otro</option>
                </select>
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
                  <input
                    type="number"
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
                  <select
                    className={styles.select}
                    value={appliesTo}
                    onChange={(e) => setAppliesTo(e.target.value as any)}
                  >
                    <option value="revenue">Ingresos totales</option>
                    <option value="profit">Ganancias netas</option>
                    <option value="">No aplica</option>
                  </select>
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
