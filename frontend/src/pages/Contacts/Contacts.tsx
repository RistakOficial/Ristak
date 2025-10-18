import React, { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { KpiCard, Card, Button, Table, DateRangePicker, PageContainer, TabList, Badge, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/common'
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
  Trash2,
  MoreVertical,
  Eye,
  Mail,
  Tag
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useLabels } from '@/contexts/LabelsContext'
import { formatCurrency, formatDate, formatDateToISO, formatEndDateToISO, formatNumber, parseLocalDateString } from '@/utils/format'
import { contactsService, type Contact, type ContactStats } from '@/services/contactsService'
import type { ContactAppointment, ContactPayment } from '@/types'
import { useNotification } from '@/contexts/NotificationContext'
import styles from './Contacts.module.css'
import { dedupeContacts } from '@/utils/contactDedup'

const APPOINTMENT_CANCELED_STATUSES = new Set([
  'cancelled',
  'canceled',
  'no_show',
  'noshow',
  'failed',
  'missed'
])

const STATUS_PRIORITY: Record<Contact['status'], number> = {
  lead: 0,
  appointment: 1,
  customer: 2
}

const PAYMENT_SUCCESS_STATUSES = new Set([
  'succeeded',
  'paid',
  'completed',
  'complete',
  'fulfilled',
  'success'
])

const PAYMENT_REFUND_STATUSES = new Set(['refunded', 'refund'])
const PAYMENT_PENDING_STATUSES = new Set(['pending', 'processing'])
const PAYMENT_FAILED_STATUSES = new Set(['failed', 'canceled', 'cancelled'])

const mergeContactDetailRecords = (
  baseContact: Contact | null,
  detailContacts: Contact[],
  primaryId: string | null
): Contact => {
  const allContacts = baseContact ? [baseContact, ...detailContacts] : [...detailContacts]
  const template = allContacts[0]

  const merged: Contact = {
    ...(template ?? {} as Contact),
    id: primaryId ?? template?.id ?? '',
    firstAppointmentDate: template?.firstAppointmentDate ?? null,
    nextAppointmentDate: template?.nextAppointmentDate ?? null,
    purchases: template?.purchases ?? 0,
    ltv: template?.ltv ?? 0,
    appointments: template?.appointments ? [...template.appointments] : [],
    payments: template?.payments ? [...template.payments] : undefined
  }

  const mergedIds = new Set<string>()
  if (primaryId) mergedIds.add(primaryId)
  if (baseContact?.mergedContactIds) {
    baseContact.mergedContactIds.forEach(id => id && mergedIds.add(id))
  }
  if (template?.mergedContactIds) {
    template.mergedContactIds.forEach(id => id && mergedIds.add(id))
  }

  let latestPurchaseTimestamp = merged.lastPurchase ? Date.parse(merged.lastPurchase) : Number.NEGATIVE_INFINITY

  const paymentMap = new Map<string, ContactPayment>()
  merged.payments?.forEach(payment => {
    if (!payment) return
    const key = payment.id ?? `${payment.date}-${payment.amount}-${payment.status ?? ''}`
    paymentMap.set(key, payment)
  })

  const appointmentMap = new Map<string, ContactAppointment>()
  merged.appointments?.forEach(appointment => {
    if (!appointment) return
    const key = appointment.id ?? `${appointment.start_time}-${appointment.title ?? ''}`
    appointmentMap.set(key, appointment)
  })

  const getStatusPriority = (status?: Contact['status']) => status ? STATUS_PRIORITY[status] ?? 0 : 0

  for (const contact of allContacts) {
    if (!contact) continue

    if (contact.id) mergedIds.add(contact.id)
    contact.mergedContactIds?.forEach(id => id && mergedIds.add(id))

    if (!merged.name && contact.name) merged.name = contact.name
    if (!merged.email && contact.email) merged.email = contact.email
    if (!merged.phone && contact.phone) merged.phone = contact.phone
    if (!merged.source && contact.source) merged.source = contact.source
    if (!merged.ad_name && contact.ad_name) merged.ad_name = contact.ad_name
    if (!merged.ad_id && contact.ad_id) merged.ad_id = contact.ad_id

    merged.purchases = Math.max(merged.purchases ?? 0, contact.purchases ?? 0)
    merged.ltv = Math.max(merged.ltv ?? 0, contact.ltv ?? 0)

    if (getStatusPriority(contact.status) > getStatusPriority(merged.status)) {
      merged.status = contact.status ?? merged.status
    }

    if (contact.lastPurchase) {
      const ts = Date.parse(contact.lastPurchase)
      if (!Number.isNaN(ts) && ts > latestPurchaseTimestamp) {
        latestPurchaseTimestamp = ts
        merged.lastPurchase = contact.lastPurchase
      }
    }

    contact.payments?.forEach(payment => {
      if (!payment) return
      const key = payment.id ?? `${payment.date}-${payment.amount}-${payment.status ?? ''}`
      if (!paymentMap.has(key)) {
        paymentMap.set(key, payment)
      }
    })

    contact.appointments?.forEach(appointment => {
      if (!appointment) return
      const key = appointment.id ?? `${appointment.start_time}-${appointment.title ?? ''}`
      if (!appointmentMap.has(key)) {
        appointmentMap.set(key, appointment)
      }
    })
  }

  const appointments = Array.from(appointmentMap.values()).sort((a, b) =>
    new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  )

  merged.appointments = appointments
  if (appointments.length > 0) {
    merged.firstAppointmentDate = appointments[0].start_time
  } else {
    merged.firstAppointmentDate = baseContact?.firstAppointmentDate ?? merged.firstAppointmentDate ?? null
  }

  const now = Date.now()
  const upcomingAppointment = appointments.find(appointment => {
    const start = Date.parse(appointment.start_time)
    if (Number.isNaN(start) || start < now) {
      return false
    }
    const statusValue = (appointment.appointment_status || appointment.status || '').toLowerCase()
    return !APPOINTMENT_CANCELED_STATUSES.has(statusValue)
  })

  merged.nextAppointmentDate = upcomingAppointment
    ? upcomingAppointment.start_time
    : baseContact?.nextAppointmentDate ?? null

  const payments = Array.from(paymentMap.values())
  merged.payments = payments.length > 0 ? payments : undefined

  merged.mergedContactIds = Array.from(mergedIds).filter(id => id && id !== merged.id)

  return merged
}

export const Contacts: React.FC = () => {
  const { dateRange, setDateRange } = useDateRange()
  const { showToast } = useNotification()
  const { labels } = useLabels()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [stats, setStats] = useState<ContactStats | null>(null)
  const [filter, setFilter] = useState('all')
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [selectedContactDetails, setSelectedContactDetails] = useState<Contact | null>(null)
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [contactDetailsLoading, setContactDetailsLoading] = useState(false)
  const [showNewContactModal, setShowNewContactModal] = useState(false)
  const [editingContact, setEditingContact] = useState<Contact | null>(null)
  const [deletingContact, setDeletingContact] = useState<Contact | null>(null)
  const [loading, setLoading] = useState(false)
  const [viewMode, setViewMode] = useState<'all' | 'by-date'>('all') // Por defecto 'all' (Todos)
  const [isClient, setIsClient] = useState(false)

  const appointmentDateFormatter = useMemo(() => new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }), [])

  const rangeStart = dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start)
  const rangeEnd = dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end)
  const spansMultipleYears = rangeStart.getFullYear() !== rangeEnd.getFullYear()
  const tableDateOptions = { includeYear: spansMultipleYears, referenceDate: rangeEnd }

  const formatAppointmentDateTime = (value: string) => {
    if (!value) return '—'
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return '—'
    return appointmentDateFormatter.format(parsed)
  }

  const formatStatusText = (value: string) => {
    return value
      .toLowerCase()
      .split(/[\s_]+/)
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }

  const getAppointmentStatusBadge = (status?: string | null): { label: string; variant: BadgeVariant } => {
    if (!status) return { label: 'Reservado', variant: 'warning' }
    const normalized = status.toLowerCase()

    if (['confirmed', 'booked', 'scheduled'].includes(normalized)) {
      return { label: 'Reservado', variant: 'warning' }
    }
    if (['completed', 'showed', 'attended', 'complete'].includes(normalized)) {
      return { label: 'Asistió', variant: 'success' }
    }
    if (['cancelled', 'canceled', 'no_show', 'noshow', 'failed', 'missed'].includes(normalized)) {
      return { label: 'Cancelado', variant: 'error' }
    }
    if (['pending', 'unconfirmed'].includes(normalized)) {
      return { label: 'Pendiente', variant: 'warning' }
    }
    if (normalized === 'rescheduled') {
      return { label: 'Reagendada', variant: 'info' }
    }
    return { label: formatStatusText(normalized), variant: 'neutral' }
  }

  const getPaymentStatusBadge = (status?: string | null): { label: string; variant: BadgeVariant } => {
    if (!status) return { label: 'Pendiente', variant: 'warning' }
    const normalized = status.toLowerCase()

    if (PAYMENT_SUCCESS_STATUSES.has(normalized)) {
      return { label: 'Pagado', variant: 'success' }
    }
    if (PAYMENT_REFUND_STATUSES.has(normalized)) {
      return { label: 'Reembolsado', variant: 'error' }
    }
    if (PAYMENT_PENDING_STATUSES.has(normalized)) {
      return { label: 'Pendiente', variant: 'warning' }
    }
    if (PAYMENT_FAILED_STATUSES.has(normalized)) {
      return { label: 'Fallido', variant: 'error' }
    }

    return { label: formatStatusText(normalized), variant: 'neutral' }
  }

  const openContactModal = (contact: Contact) => {
    setSelectedContact(contact)
    setSelectedContactDetails(null)
    setSelectedContactId(contact.id)
    setContactDetailsLoading(true)
  }

  const closeContactModal = () => {
    setSelectedContact(null)
    setSelectedContactId(null)
    setContactDetailsLoading(false)
    setSelectedContactDetails(null)
  }

  useEffect(() => {
    fetchData()
  }, [dateRange, viewMode])

  useEffect(() => {
    setIsClient(true)
  }, [])

  useEffect(() => {
    if (!selectedContactId) return

    let isMounted = true

    const targetIds = Array.from(
      new Set(
        [selectedContactId, ...(selectedContact?.mergedContactIds ?? [])].filter(
          (id): id is string => Boolean(id)
        )
      )
    )

    const loadContactDetails = async () => {
      try {
        const results = await Promise.all(
          targetIds.map(async (id) => {
            try {
              return await contactsService.getContactDetails(id)
            } catch (error) {
              if (id === selectedContactId) {
                throw error
              }
              return null
            }
          })
        )

        if (!isMounted) {
          return
        }

        const validResults = results.filter((contact): contact is Contact => Boolean(contact))

        if (validResults.length === 0) {
          setSelectedContactDetails(selectedContact ?? null)
          return
        }

        const mergedDetails = mergeContactDetailRecords(selectedContact ?? null, validResults, selectedContactId)
        setSelectedContactDetails(mergedDetails)
      } catch (error) {
        if (isMounted) {
          setSelectedContactDetails(selectedContact ?? null)
          showToast('error', 'No se pudieron cargar los detalles del contacto', 'Intenta nuevamente.')
        }
      } finally {
        if (isMounted) {
          setContactDetailsLoading(false)
        }
      }
    }

    loadContactDetails()

    return () => {
      isMounted = false
    }
  }, [selectedContactId, selectedContact, showToast])

  const contactData = selectedContactDetails ?? selectedContact

  const hasAppointmentsData = typeof contactData?.appointments !== 'undefined'
  const hasPaymentsData = typeof contactData?.payments !== 'undefined'

  const contactAppointments = useMemo(() => {
    if (!contactData?.appointments) return []
    return [...contactData.appointments].sort((a, b) =>
      new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
    )
  }, [contactData?.appointments])

  const contactPayments = useMemo(() => {
    if (!contactData?.payments) return []
    return [...contactData.payments].sort((a, b) => {
      const dateA = a?.date ? Date.parse(a.date) : 0
      const dateB = b?.date ? Date.parse(b.date) : 0
      return dateB - dateA
    })
  }, [contactData?.payments])

  const nextAppointmentTimestamp = useMemo(() => {
    if (!contactData?.nextAppointmentDate) return null
    const parsed = new Date(contactData.nextAppointmentDate)
    if (Number.isNaN(parsed.getTime())) {
      return null
    }
    return parsed.getTime()
  }, [contactData?.nextAppointmentDate])

  const paymentsCount = contactPayments.length
  const appointmentsCount = contactAppointments.length

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
        endDate = formatEndDateToISO(end) // Incluir día completo
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
          onClick={() => openContactModal(item)}
        >
          {value}
        </button>
      ),
      sortable: true
    },
    {
      key: 'status',
      header: 'Estado',
      render: (value) => getStatusBadge(value as Contact['status']),
      sortable: true
    },
    {
      key: 'phone',
      header: 'Teléfono',
      sortable: true
    },
    {
      key: 'email',
      header: 'Email',
      sortable: true,
      visible: false
    },
    {
      key: 'ltv',
      header: 'Pagos totales',
      render: (value) => value > 0 ? formatCurrency(value) : '-',
      sortable: true
    },
    {
      key: 'id',
      header: 'Acciones',
      render: (_, item) => {
        // Contar acciones disponibles
        const actions = []
        actions.push('view') // Ver detalles siempre disponible
        if (item.email) actions.push('email') // Enviar email si tiene email
        actions.push('edit') // Editar siempre disponible
        actions.push('delete') // Eliminar siempre disponible

        // Si solo hay una acción (eliminar), mostrar botón directo
        // Esto solo pasa si el contacto no tiene email y es la única acción
        if (actions.length === 1 && actions[0] === 'delete') {
          return (
            <div className={styles.actions}>
              <button
                className={`${styles.actionButton} ${styles.deleteButton}`}
                onClick={() => setDeletingContact(item)}
                title="Eliminar contacto"
              >
                <Trash2 size={16} />
              </button>
            </div>
          )
        }

        // Si hay múltiples acciones, mostrar dropdown
        return (
          <div className={styles.actions}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className={styles.actionButton} title="Más acciones">
                  <MoreVertical size={16} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* Ver detalles */}
                <DropdownMenuItem onClick={() => openContactModal(item)}>
                  <Eye size={16} />
                  <span style={{ marginLeft: '8px' }}>Ver detalles</span>
                </DropdownMenuItem>

                {/* Enviar email (si tiene email) */}
                {item.email && (
                  <DropdownMenuItem onClick={() => window.location.href = `mailto:${item.email}`}>
                    <Mail size={16} />
                    <span style={{ marginLeft: '8px' }}>Enviar email</span>
                  </DropdownMenuItem>
                )}

                {/* Editar */}
                <DropdownMenuItem onClick={() => setEditingContact(item)}>
                  <Pencil size={16} />
                  <span style={{ marginLeft: '8px' }}>Editar contacto</span>
                </DropdownMenuItem>

                {/* Separador antes de acción destructiva */}
                <DropdownMenuSeparator />

                {/* Eliminar */}
                <DropdownMenuItem
                  onClick={() => setDeletingContact(item)}
                  className={styles.destructive}
                >
                  <Trash2 size={16} />
                  <span style={{ marginLeft: '8px' }}>Eliminar contacto</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      },
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
        </div>

        <div className={styles.controlsRow}>
          <div className={styles.dateFilters}>
            <TabList
              tabs={[
                { value: 'all', label: 'Todos' },
                { value: 'by-date', label: 'Por fecha' }
              ]}
              activeTab={viewMode}
              onTabChange={(value) => setViewMode(value as 'all' | 'by-date')}
              variant="compact"
            />
            {viewMode === 'by-date' && (
              <DateRangePicker
                startDate={formatDateToISO(dateRange.start)}
                endDate={formatDateToISO(dateRange.end)}
                onChange={(start, end) => setDateRange({
                  start: parseLocalDateString(start),
                  end: parseLocalDateString(end),
                  preset: 'custom'
                })}
              />
            )}
          </div>
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
          key="contacts_table_v2"
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
          tableId="contacts_v2"
        />
      </Card>

      {isClient && selectedContact && createPortal(
        <div className={styles.modalOverlay} onClick={closeContactModal}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2>Ficha de Contacto</h2>
              <button
                className={styles.closeButton}
                onClick={closeContactModal}
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
                    <span className={styles.value}>{contactData?.name ?? '—'}</span>
                  </div>
                  <div>
                    <span className={styles.label}>Email:</span>
                    <span className={styles.value}>{contactData?.email ?? '—'}</span>
                  </div>
                  <div>
                    <span className={styles.label}>Teléfono:</span>
                    <span className={styles.value}>{contactData?.phone ?? '—'}</span>
                  </div>
                  <div>
                    <span className={styles.label}>Estado:</span>
                    {getStatusBadge((contactData?.status ?? 'lead') as Contact['status'])}
                  </div>
                </div>
              </div>

              <div className={styles.infoSection}>
                <h3>Historial de Compras</h3>
                <div className={styles.infoGrid}>
                  <div>
                    <span className={styles.label}>Total de compras:</span>
                    <span className={styles.value}>{contactData?.purchases ?? 0}</span>
                  </div>
                  <div>
                    <span className={styles.label}>Pagos totales:</span>
                    <span className={styles.value}>{formatCurrency(contactData?.ltv ?? 0)}</span>
                  </div>
                  {contactData?.lastPurchase && (
                    <div>
                      <span className={styles.label}>Última compra:</span>
                      <span className={styles.value}>
                        {formatDate(contactData.lastPurchase, tableDateOptions)}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {(contactData?.firstAppointmentDate ||
                contactData?.nextAppointmentDate ||
                hasAppointmentsData ||
                contactAppointments.length > 0 ||
                contactDetailsLoading) && (
                  <div className={styles.infoSection}>
                    <h3>Citas</h3>
                    {(contactData?.firstAppointmentDate || contactData?.nextAppointmentDate) && (
                      <div className={styles.infoGrid}>
                        {contactData?.firstAppointmentDate && (
                          <div>
                            <span className={styles.label}>Primera cita:</span>
                            <span className={styles.value}>
                              {formatDate(contactData.firstAppointmentDate, tableDateOptions)}
                            </span>
                          </div>
                        )}
                        {contactData?.nextAppointmentDate && (
                          <div>
                            <span className={styles.label}>Próxima cita:</span>
                            <span className={styles.value}>
                              {formatDate(contactData.nextAppointmentDate, tableDateOptions)}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {contactDetailsLoading && (
                      <p className={styles.loadingState}>Cargando historial de citas...</p>
                    )}

                    {!contactDetailsLoading && hasAppointmentsData && contactAppointments.length === 0 && (
                      <p className={styles.emptyState}>Este contacto no tiene citas registradas.</p>
                    )}

                    {contactAppointments.length > 0 && (
                      <ul className={styles.appointmentsList}>
                        {contactAppointments.map(appointment => {
                          const statusValue = appointment.appointment_status || appointment.status
                          const statusInfo = getAppointmentStatusBadge(statusValue)
                          const appointmentDate = new Date(appointment.start_time)
                          const normalizedStatus = statusValue ? statusValue.toLowerCase() : ''
                          const isCancelled = ['cancelled', 'canceled', 'no_show', 'noshow', 'missed', 'failed'].includes(normalizedStatus)
                          const appointmentTime = appointmentDate.getTime()
                          const showUpcomingBadge = nextAppointmentTimestamp !== null
                            ? appointmentTime === nextAppointmentTimestamp
                            : appointmentTime >= Date.now() && !isCancelled

                          return (
                            <li key={appointment.id} className={styles.appointmentItem}>
                              <div className={styles.appointmentInfo}>
                                <span className={styles.appointmentDate}>
                                  {formatAppointmentDateTime(appointment.start_time)}
                                </span>
                                {appointment.title && (
                                  <span className={styles.appointmentTitle}>{appointment.title}</span>
                                )}
                                {appointment.notes && (
                                  <span className={styles.appointmentNotes}>{appointment.notes}</span>
                                )}
                              </div>
                              <div className={styles.appointmentBadges}>
                                {showUpcomingBadge && (
                                  <Badge variant="primary">Próxima</Badge>
                                )}
                                <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )}

              {(contactData?.source || contactData?.ad_name || contactData?.ad_id) && (
                <div className={styles.infoSection}>
                  <h3>De dónde llegó el contacto:</h3>
                  <div className={styles.infoGrid}>
                    {contactData?.source && (
                      <div>
                        <span className={styles.label}>Fuente:</span>
                        <span className={styles.value}>{contactData.source}</span>
                      </div>
                    )}
                    {contactData?.ad_name && (
                      <div>
                        <span className={styles.label}>Anuncio:</span>
                        <span className={styles.value}>{contactData.ad_name}</span>
                      </div>
                    )}
                    {contactData?.ad_id && (
                      <div>
                        <span className={styles.label}>ID del Anuncio:</span>
                        <span className={styles.value}>{contactData.ad_id}</span>
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

export default Contacts
