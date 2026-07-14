import React, { useEffect, useState } from 'react'
import { Loader2, Plus, Trash2, UserX } from 'lucide-react'
import { Badge, Button, Card, CustomSelect, PageHeader } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import {
  hiddenContactsService,
  type HiddenFilter,
  type MatchType
} from '@/services/hiddenContactsService'
import pageStyles from './Settings.module.css'
import styles from './HiddenContactsSettings.module.css'

const MATCH_TYPE_OPTIONS = [
  { value: 'contains', label: 'Contiene el texto' },
  { value: 'exact', label: 'Coincidencia exacta' }
]

const getErrorStatus = (error: unknown) => (
  typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined
)

const getErrorMessage = (error: unknown) => (
  error instanceof Error ? error.message : ''
)

export const HiddenContactsSettings: React.FC = () => {
  const { showConfirm, showToast } = useNotification()
  const [hiddenFilters, setHiddenFilters] = useState<HiddenFilter[]>([])
  const [newFilter, setNewFilter] = useState('')
  const [newFilterType, setNewFilterType] = useState<MatchType>('contains')
  const [loadingFilters, setLoadingFilters] = useState(true)
  const [addingFilter, setAddingFilter] = useState(false)

  const loadHiddenFilters = async () => {
    setLoadingFilters(true)
    try {
      setHiddenFilters(await hiddenContactsService.getFilters())
    } catch (error) {
      showToast('error', 'No se cargaron los contactos ocultos', getErrorMessage(error) || 'Intenta otra vez.')
    } finally {
      setLoadingFilters(false)
    }
  }

  useEffect(() => {
    void loadHiddenFilters()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleAddFilter = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const filterText = newFilter.trim()

    if (!filterText) {
      showToast('warning', 'Falta el texto', 'Escribe el dato que quieres ocultar.')
      return
    }

    setAddingFilter(true)
    try {
      const createdFilter = await hiddenContactsService.addFilter(filterText, newFilterType)
      setHiddenFilters((current) => [createdFilter, ...current])
      setNewFilter('')
      setNewFilterType('contains')
      showToast('success', 'Regla agregada', `Los contactos que coincidan con “${filterText}” ya no aparecerán.`)
    } catch (error) {
      if (getErrorStatus(error) === 409 || getErrorMessage(error).toLowerCase().includes('existe')) {
        showToast('warning', 'La regla ya existe', 'No hace falta agregarla dos veces.')
      } else {
        showToast('error', 'No se agregó la regla', getErrorMessage(error) || 'Intenta otra vez.')
      }
    } finally {
      setAddingFilter(false)
    }
  }

  const handleDeleteFilter = (filter: HiddenFilter) => {
    showConfirm(
      'Eliminar regla de ocultamiento',
      `Al eliminar “${filter.filterText}”, los contactos que coincidan volverán a aparecer en Ristak. Esta acción no se puede deshacer.`,
      async () => {
        try {
          await hiddenContactsService.deleteFilter(filter.id)
          setHiddenFilters((current) => current.filter((item) => item.id !== filter.id))
          showToast('success', 'Regla eliminada', 'Los contactos que coincidan volverán a mostrarse.')
        } catch (error) {
          showToast('error', 'No se eliminó la regla', getErrorMessage(error) || 'Intenta otra vez.')
          return false
        }
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  return (
    <div className={pageStyles.settingsContent}>
      <PageHeader
        eyebrow="Configuración · Contactos"
        title="Contactos ocultos"
        subtitle="Excluye contactos de prueba o internos de todas las vistas de Ristak, sin depender de HighLevel ni de otra integración."
      />

      <Card className={pageStyles.settingsSection}>
        <div className={pageStyles.panelHeader}>
          <div className={pageStyles.panelHeaderLeft}>
            <div className={pageStyles.iconBox} aria-hidden="true">
              <UserX size={20} />
            </div>
            <div>
              <h2 className={pageStyles.panelTitle}>Reglas de ocultamiento</h2>
              <p className={pageStyles.panelDescription}>
                Cada regla revisa el nombre, correo, teléfono e ID del contacto. Se aplica a contactos, chat, reportes, métricas y notificaciones.
              </p>
            </div>
          </div>
        </div>

        <form className={styles.ruleForm} onSubmit={handleAddFilter}>
          <label className={styles.fieldLabel} htmlFor="hidden-contact-rule">
            Nombre, correo, teléfono o ID
          </label>
          <div className={styles.ruleControls}>
            <input
              id="hidden-contact-rule"
              className={styles.ruleTextInput}
              type="text"
              placeholder="Ej. prueba, equipo@negocio.com o 5512345678"
              value={newFilter}
              onChange={(event) => setNewFilter(event.target.value)}
              disabled={addingFilter}
              autoComplete="off"
            />
            <CustomSelect
              aria-label="Tipo de coincidencia"
              options={MATCH_TYPE_OPTIONS}
              value={newFilterType}
              onValueChange={(value) => setNewFilterType(value as MatchType)}
              disabled={addingFilter}
            />
            <Button
              type="submit"
              loading={addingFilter}
              disabled={!newFilter.trim()}
              leftIcon={<Plus size={16} />}
            >
              Agregar regla
            </Button>
          </div>
          <p className={styles.helpText}>
            “Contiene el texto” sirve para fragmentos; “Coincidencia exacta” solo oculta cuando el valor completo coincide.
          </p>
        </form>

        <section className={styles.rulesSection} aria-labelledby="hidden-rules-title">
          <div className={styles.rulesHeader}>
            <div>
              <h3 id="hidden-rules-title">Reglas activas</h3>
              <p>Los cambios se aplican a todo Ristak.</p>
            </div>
            <Badge variant="neutral">
              {hiddenFilters.length} {hiddenFilters.length === 1 ? 'regla' : 'reglas'}
            </Badge>
          </div>

          {loadingFilters ? (
            <div className={styles.loadingState} role="status" aria-live="polite">
              <Loader2 size={20} className={styles.spinIcon} aria-hidden="true" />
              <span>Cargando reglas…</span>
            </div>
          ) : hiddenFilters.length === 0 ? (
            <div className={styles.emptyState}>
              <UserX size={28} aria-hidden="true" />
              <div>
                <h4>No hay contactos ocultos</h4>
                <p>Agrega una regla arriba para excluir contactos de prueba o internos.</p>
              </div>
            </div>
          ) : (
            <ul className={styles.ruleList}>
              {hiddenFilters.map((filter) => (
                <li className={styles.ruleRow} key={filter.id}>
                  <div className={styles.ruleIdentity}>
                    <span className={styles.ruleText}>{filter.filterText}</span>
                    <Badge variant="neutral">
                      {filter.matchType === 'exact' ? 'Coincidencia exacta' : 'Contiene el texto'}
                    </Badge>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    iconOnly
                    aria-label={`Eliminar regla ${filter.filterText}`}
                    title="Eliminar regla"
                    onClick={() => handleDeleteFilter(filter)}
                  >
                    <Trash2 size={16} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </Card>
    </div>
  )
}
