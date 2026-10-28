import React, { useCallback, useEffect, useState } from 'react'
import { Button, CustomSelect, Modal, Table, type Column } from '@/components/common'
import apiClient from '@/services/apiClient'
import { useNotification } from '@/contexts/NotificationContext'
import styles from './ContactBlocksModal.module.css'

interface Block {
  id: string
  identity_type: 'phone' | 'email' | 'contact'
  identity_value: string
  reason: string
  contact_name?: string
}
interface BlockPage { items: Block[]; total: number }

export function ContactBlocksModal({ onClose }: { onClose: () => void }) {
  const { showToast, showConfirm } = useNotification()
  const [type, setType] = useState('email')
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [result, setResult] = useState<BlockPage>({ items: [], total: 0 })
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setLoadError('')
    try {
      const data = await apiClient.get<BlockPage>('/contacts/blocked', { params: { search, limit: '20', offset: String((page - 1) * 20) }, signal })
      if (!signal?.aborted) setResult(data)
    } catch (error) {
      if (!signal?.aborted) setLoadError(error instanceof Error ? error.message : 'No se pudieron cargar los bloqueos.')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [page, search])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await apiClient.post('/contacts/blocked', { identityType: type, identityValue: value, reason })
      setValue('')
      setReason('')
      showToast('success', 'Bloqueo guardado. No podrá enviar formularios ni reservar con ese dato.')
      if (page !== 1) setPage(1)
      else await load()
    } catch (error) {
      showToast('error', error instanceof Error ? error.message : 'No se pudo guardar el bloqueo.')
    } finally { setBusy(false) }
  }
  const unblock = (block: Block) => showConfirm('Desbloquear contacto',
    'Se volverán a aceptar solicitudes con este dato. Su historial y el estado de la papelera se conservan.',
    async () => {
      setBusy(true)
      try {
        await apiClient.delete(`/contacts/blocked/${encodeURIComponent(block.id)}`)
        if (result.items.length === 1 && page > 1) setPage(page - 1)
        else await load()
        showToast('success', 'Bloqueo retirado.')
      } catch (error) {
        showToast('error', error instanceof Error ? error.message : 'No se pudo retirar el bloqueo.')
        return false
      } finally { setBusy(false) }
    }, 'Desbloquear', 'Cancelar')

  const columns: Column<Block>[] = [
    { key: 'identity_type', header: 'Tipo', render: (v: string) => v === 'phone' ? 'Teléfono' : v === 'email' ? 'Correo' : 'Contacto' },
    { key: 'identity_value', header: 'Identidad bloqueada', render: (value: string, block: Block) => block.contact_name || value },
    { key: 'reason', header: 'Motivo interno' },
    { key: 'actions', header: 'Acciones', render: (_: unknown, block: Block) => <Button variant="ghost" disabled={busy} onClick={() => unblock(block)}>Desbloquear</Button> }
  ]
  return <Modal isOpen title="Contactos bloqueados" onClose={onClose} size="lg">
    <div className={styles.content}>
      <p className={styles.description}>Bloquea un correo o un teléfono completo. Las coincidencias son exactas: el nombre no se usa. El bloqueo permanece aunque el contacto salga de la papelera.</p>
      <p className={styles.description}>Los mensajes de estas identidades se ignoran en Ristak. Esto no bloquea la cuenta dentro de WhatsApp ni otros datos que aún no hayas agregado.</p>
      <form onSubmit={add} className={styles.fields}>
        <label>Identificar por<CustomSelect value={type} onValueChange={setType} disabled={busy} options={[{ value: 'email', label: 'Correo' }, { value: 'phone', label: 'Teléfono' }]} /></label>
        <label>{type === 'email' ? 'Correo electrónico' : 'Teléfono con código de país'}<input required type={type === 'email' ? 'email' : 'tel'} value={value} maxLength={320} onChange={event => setValue(event.target.value)} placeholder={type === 'email' ? 'persona@ejemplo.com' : '+52 55 1234 5678'} disabled={busy} /></label>
        <label>Motivo interno (opcional)<input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} disabled={busy} /></label>
        <Button type="submit" disabled={busy || !value.trim()}>{busy ? 'Guardando…' : 'Agregar bloqueo'}</Button>
      </form>
      {loadError ? <p role="alert">{loadError}</p> : <Table columns={columns} data={result.items} keyExtractor={block => block.id} loading={loading} searchPlaceholder="Buscar correo o teléfono" serverSideSearch searchTerm={search} onSearchTermChange={value => { setSearch(value); setPage(1) }} pageSize={20} serverSidePagination currentPage={page} totalItems={result.total} onPageChange={setPage} />}
    </div>
  </Modal>
}
