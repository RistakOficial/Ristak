import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { KpiCard, Card, Button, Table, DateRangePicker, PageContainer, TabList, Badge } from '@/components/common'
import type { Column, BadgeVariant } from '@/components/common'
import {
  Plus,
  Info,
  Users,
  Calendar,
  User,
  DollarSign,
  TrendingUp,
  X,
  Pencil,
  Trash2
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useLabels } from '@/contexts/LabelsContext'
import { formatCurrency, formatDate, formatDateToISO, formatNumber, parseLocalDateString } from '@/utils/format'
import { contactsService, type Contact, type ContactStats } from '@/services/contactsService'
import { useNotification } from '@/contexts/NotificationContext'
import styles from './Contacts.module.css'
import { dedupeContacts } from '@/utils/contactDedup'


export const Contacts: React.FC = () => {
  const { dateRange, setDateRange } = useDateRange()
  const { showToast } = useNotification()
  const { labels } = useLabels()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [stats, setStats] = useState<ContactStats | null>(null)
  const [filter, setFilter] = useState('all')
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [showNewContactModal, setShowNewContactModal] = useState(false)
  const [editingContact, setEditingContact] = useState<Contact | null>(null)
  const [deletingContact, setDeletingContact] = useState<Contact | null>(null)
  const [loading, setLoading] = useState(false)
  const [viewMode, setViewMode] = useState<'all' | 'by-date'>('all') // Por defecto 'all' (Todos)
  const [isClient, setIsClient] = useState(false)

  const rangeStart = dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start)
  const rangeEnd = dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end)
  const spansMultipleYears = rangeStart.getFullYear() !== rangeEnd.getFullYear()
  const tableDateOptions = { includeYear: spansMultipleYears, referenceDate: rangeEnd }

  useEffect(() => {
    fetchData()
  }, [dateRange, viewMode])

  useEffect(() => {
    setIsClient(true)
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
      let startDate: string | undefined
      let endDate: string | undefined

      // Solo usar fechas si está en modo 'by-date'
      if (viewMode === 'by-date') {
        // Ensure dates are Date objects
        const start = dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start)
        const end = dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end)
        startDate = formatDateToISO(start)
        endDate = formatDateToISO(end)
      }
      // Si viewMode === 'all', no enviamos fechas para obtener TODOS los contactos

      const [contactsData, statsData] = await Promise.all([
        contactsService.getContacts(startDate, endDate),
        contactsService.getStats(startDate, endDate)
      ])

      setContacts(contactsData)
      setStats(statsData)
    } catch (error) {
      // Error already shown to user via toast
      showToast('error', 'No se pudieron cargar los contactos', 'Hubo un problema al obtener la información de contactos. Intenta refrescar la página.')
    } finally {
      setLoading(false)
    }
  }

  const filteredContacts = contacts.filter(contact => {
    if (filter === 'all') return true
    if (filter === 'customers') return contact.status === 'customer'
    if (filter === 'appointments') return contact.status === 'appointment'
    return true
  })

  const filterOptions = [
    { label: 'Todos', value: 'all' },
    { label: labels.customers, value: 'customers' }
  ]

  const statusConfig: Record<Contact['status'], { label: string; variant: BadgeVariant }> = {
    lead: { label: labels.lead, variant: 'neutral' },
    appointment: { label: 'Agendó cita', variant: 'success' },
    customer: { label: labels.customer, variant: 'primary' }
  }

  const getStatusBadge = (status: Contact['status']) => {
    const config = statusConfig[status] ?? { label: status, variant: 'neutral' as BadgeVariant }
    return <Badge variant={config.variant}>{config.label}</Badge>
  }

  const columns: Column<Contact>[] = [
    {
      key: 'createdAt',
      header: 'Fecha de creación',
      render: (value) => formatDate(value, tableDateOptions),
      sortable: true
    },
    {
      key: 'name',
      header: 'Nombre',
      render: (value, item) => (
        <button
          className={styles.nameLink}
          onClick={() => setSelectedContact(item)}
        >
          {value}
        </button>
      ),
      sortable: true
    },
    {
      key: 'email',
      header: 'Email',
      sortable: true,
      visible: false
    },
    {
      key: 'phone',
      header: 'Teléfono',
      sortable: true
    },
    {
      key: 'ltv',
      header: 'Pagos totales',
      render: (value) => value > 0 ? formatCurrency(value) : '-',
      sortable: true
    },
    {
      key: 'status',
      header: 'Estado',
      render: (value) => getStatusBadge(value as Contact['status']),
      sortable: true
    },
    {
      key: 'id',
      header: 'Acciones',
      render: (_, item) => (
        <div className={styles.actions}>
          <button
            className={styles.actionButton}
            onClick={() => setEditingContact(item)}
            title="Editar contacto"
          >
            <Pencil size={16} />
          </button>
          <button
            className={`${styles.actionButton} ${styles.deleteButton}`}
            onClick={() => setDeletingContact(item)}
            title="Eliminar contacto"
          >
            <Trash2 size={16} />
          </button>
        </div>
      ),
      sortable: false
    }
  ]

  const statsData = {
    total: stats?.total || 0,
    withAppointments: stats?.withAppointments || 0,
    customers: stats?.customers || 0,
    ltvTotal: stats?.ltvTotal || 0,
    ltvPromedio: stats?.avgLtv || 0,
    totalChange: stats ? contactsService.calculateDelta(stats.total, stats.totalPrev) : 0,
    appointmentsChange: stats ? contactsService.calculateDelta(stats.withAppointments, stats.withAppointmentsPrev) : 0,
    customersChange: stats ? contactsService.calculateDelta(stats.customers, stats.customersPrev) : 0,
    ltvTotalChange: stats ? contactsService.calculateDelta(stats.ltvTotal, stats.ltvTotalPrev) : 0,
    ltvPromedioChange: stats ? contactsService.calculateDelta(stats.avgLtv, stats.avgLtvPrev) : 0
  }

  const handleCreateContact = async (contact: Omit<Contact, 'id' | 'createdAt' | 'ltv' | 'purchases'>) => {
    try {
      const newContact = await contactsService.createContact(contact)
      setContacts(prev => dedupeContacts<Contact>([...prev, newContact]))
      setShowNewContactModal(false)
      showToast('success', '¡Contacto creado exitosamente!', `${contact.name} se agregó a tu lista de contactos`)
      fetchData()
    } catch (error) {
      // Error already shown to user via toast
      showToast('error', 'No se pudo crear el contacto', 'Hubo un problema al guardar el contacto. Verifica los datos e intenta nuevamente.')
    }
  }

  return (
    <PageContainer>
      <div className={styles.container}>
        <div className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Contactos</h1>
          <p className={styles.pageSubtitle}>Visualiza tus contactos, clientes y su valor acumulado en el tiempo.</p>
          {viewMode === 'by-date' && (
            <div className={styles.datePickerInline}>
              <DateRangePicker
                startDate={formatDateToISO(dateRange.start)}
                endDate={formatDateToISO(dateRange.end)}
                onChange={(start, end) => setDateRange({
                  start: parseLocalDateString(start),
                  end: parseLocalDateString(end),
                  preset: 'custom'
                })}
              />
            </div>
          )}
        </div>

        <div className={styles.controlsRow}>
          <TabList
            tabs={[
              { value: 'all', label: 'Todos' },
              { value: 'by-date', label: 'Por fecha' }
            ]}
            activeTab={viewMode}
            onTabChange={(value) => setViewMode(value as 'all' | 'by-date')}
            variant="compact"
          />
        </div>

        <div className={styles.kpiRow}>
          <KpiCard
            title="Total Contactos"
            value={formatNumber(statsData.total)}
            delta={statsData.totalChange}
            deltaLabel="vs periodo anterior"
            icon={<Users className="text-[var(--color-text-tertiary)]" />}
          />
          <KpiCard
            title={labels.customers}
            value={formatNumber(statsData.customers)}
            delta={statsData.customersChange}
            deltaLabel="vs periodo anterior"
            icon={<User className="text-[var(--color-text-tertiary)]" />}
          />
          <KpiCard
            title="Pagos totales"
            value={formatCurrency(statsData.ltvTotal)}
            delta={statsData.ltvTotalChange}
            deltaLabel="vs periodo anterior"
            icon={<DollarSign className="text-[var(--color-text-tertiary)]" />}
          />
          <KpiCard
            title="Pagos totales promedio"
            value={formatCurrency(statsData.ltvPromedio)}
            delta={statsData.ltvPromedioChange}
            deltaLabel="vs periodo anterior"
            icon={<TrendingUp className="text-[var(--color-text-tertiary)]" />}
          />
        </div>

      <Card padding="none">
        <Table
          key="contacts_table"
          initialColumns={columns}
          data={filteredContacts}
          keyExtractor={(item) => item.id}
          emptyMessage="No hay contactos disponibles"
          loading={loading}
          searchable={true}
          searchPlaceholder="Buscar contactos..."
          paginated={true}
          pageSize={20}
          exportable={true}
          onExport={() => {/* TODO: Implement export functionality */}}
          filters={filterOptions}
          activeFilter={filter}
          onFilterChange={setFilter}
          tableId="contacts"
        />
      </Card>

      {isClient && selectedContact && createPortal(
        <div className={styles.modalOverlay} onClick={() => setSelectedContact(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2>Ficha de Contacto</h2>
              <button
                className={styles.closeButton}
                onClick={() => setSelectedContact(null)}
              >
                <X size={20} />
              </button>
            </div>

            <div className={styles.contactInfo}>
              <div className={styles.infoSection}>
                <h3>Información Personal</h3>
                <div className={styles.infoGrid}>
                  <div>
                    <span className={styles.label}>Nombre:</span>
                    <span className={styles.value}>{selectedContact.name}</span>
                  </div>
                  <div>
                    <span className={styles.label}>Email:</span>
                    <span className={styles.value}>{selectedContact.email}</span>
                  </div>
                  <div>
                    <span className={styles.label}>Teléfono:</span>
                    <span className={styles.value}>{selectedContact.phone}</span>
                  </div>
                  <div>
                    <span className={styles.label}>Estado:</span>
                    {getStatusBadge(selectedContact.status)}
                  </div>
                </div>
              </div>

              <div className={styles.infoSection}>
                <h3>Historial de Compras</h3>
                <div className={styles.infoGrid}>
                  <div>
                    <span className={styles.label}>Total de compras:</span>
                    <span className={styles.value}>{selectedContact.purchases}</span>
                  </div>
                  <div>
                    <span className={styles.label}>Pagos totales:</span>
                    <span className={styles.value}>{formatCurrency(selectedContact.ltv)}</span>
                  </div>
                  {selectedContact.lastPurchase && (
                    <div>
                      <span className={styles.label}>Última compra:</span>
                      <span className={styles.value}>
                        {formatDate(selectedContact.lastPurchase, tableDateOptions)}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {(selectedContact.source || selectedContact.ad_name || selectedContact.ad_id) && (
                <div className={styles.infoSection}>
                  <h3>De dónde llegó el contacto:</h3>
                  <div className={styles.infoGrid}>
                    {selectedContact.source && (
                      <div>
                        <span className={styles.label}>Fuente:</span>
                        <span className={styles.value}>{selectedContact.source}</span>
                      </div>
                    )}
                    {selectedContact.ad_name && (
                      <div>
                        <span className={styles.label}>Anuncio:</span>
                        <span className={styles.value}>{selectedContact.ad_name}</span>
                      </div>
                    )}
                    {selectedContact.ad_id && (
                      <div>
                        <span className={styles.label}>ID del Anuncio:</span>
                        <span className={styles.value}>{selectedContact.ad_id}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {isClient && showNewContactModal && createPortal(
        <div className={styles.modalOverlay} onClick={() => setShowNewContactModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2>Nuevo Contacto</h2>
            <form className={styles.form} onSubmit={(e) => {
              e.preventDefault()
              const formData = new FormData(e.currentTarget)
              const contact = {
                name: formData.get('name') as string,
                email: formData.get('email') as string,
                phone: formData.get('phone') as string,
                status: 'lead' as const
              }
              handleCreateContact(contact)
            }}>
              <div className={styles.formGroup}>
                <label>Nombre completo</label>
                <input name="name" type="text" required />
              </div>
              <div className={styles.formGroup}>
                <label>Email</label>
                <input name="email" type="email" required />
              </div>
              <div className={styles.formGroup}>
                <label>Teléfono</label>
                <input name="phone" type="tel" required />
              </div>
              <div className={styles.formActions}>
                <Button type="button" variant="ghost" onClick={() => setShowNewContactModal(false)}>
                  Cancelar
                </Button>
                <Button type="submit">
                  Crear contacto
                </Button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {isClient && editingContact && createPortal(
        <div className={styles.modalOverlay} onClick={() => setEditingContact(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2>Editar Contacto</h2>
              <button
                className={styles.closeButton}
                onClick={() => setEditingContact(null)}
              >
                <X size={20} />
              </button>
            </div>
            <form className={styles.form} onSubmit={async (e) => {
              e.preventDefault()
              const formData = new FormData(e.currentTarget)
              const updatedContact = {
                full_name: formData.get('name') as string,
                email: formData.get('email') as string,
                phone: formData.get('phone') as string,
                source: formData.get('source') as string
              }

              try {
                await contactsService.updateContact(editingContact.id, updatedContact)
                setEditingContact(null)
                showToast('success', '¡Contacto actualizado!', 'Los cambios se guardaron correctamente')
                fetchData()
              } catch (error) {
                showToast('error', 'Error al actualizar', 'No se pudo actualizar el contacto')
              }
            }}>
              <div className={styles.formGroup}>
                <label>Nombre completo</label>
                <input
                  name="name"
                  type="text"
                  defaultValue={editingContact.name}
                  required
                />
              </div>
              <div className={styles.formGroup}>
                <label>Email</label>
                <input
                  name="email"
                  type="email"
                  defaultValue={editingContact.email}
                />
              </div>
              <div className={styles.formGroup}>
                <label>Teléfono</label>
                <input
                  name="phone"
                  type="tel"
                  defaultValue={editingContact.phone}
                />
              </div>
              <div className={styles.formGroup}>
                <label>Fuente</label>
                <input
                  name="source"
                  type="text"
                  defaultValue={editingContact.source || ''}
                />
              </div>
              <div className={styles.formActions}>
                <Button type="button" variant="ghost" onClick={() => setEditingContact(null)}>
                  Cancelar
                </Button>
                <Button type="submit">
                  Guardar cambios
                </Button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {isClient && deletingContact && createPortal(
        <div className={styles.modalOverlay} onClick={() => setDeletingContact(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2>¿Estás seguro?</h2>
              <button
                className={styles.closeButton}
                onClick={() => setDeletingContact(null)}
              >
                <X size={20} />
              </button>
            </div>
            <p>
              ¿Deseas eliminar a <strong>{deletingContact.name}</strong>?
              Esta acción no se puede deshacer y se eliminarán todos los datos relacionados.
            </p>
            <div className={styles.formActions}>
              <Button type="button" variant="ghost" onClick={() => setDeletingContact(null)}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await contactsService.deleteContact(deletingContact.id)
                    setDeletingContact(null)
                    showToast('success', '¡Contacto eliminado!', 'El contacto se eliminó correctamente')
                    fetchData()
                  } catch (error) {
                    showToast('error', 'Error al eliminar', 'No se pudo eliminar el contacto')
                  }
                }}
              >
                Eliminar
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}
      </div>
    </PageContainer>
  )
}
