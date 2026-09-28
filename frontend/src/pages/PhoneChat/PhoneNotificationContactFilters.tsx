import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { useUserConfig } from '@/hooks/useUserConfig'
import apiClient from '@/services/apiClient'
import { PhoneSheet, PhoneButton, PhoneTextField, PhoneSegmentedTabs } from '@/components/phone/ui'
import { PhoneSelect } from '@/components/phone/PhoneSelect'
import { NOTIFICATION_FILTER_TARGETS, emptyNotificationEventFilter, notificationConditionCount, notificationFilterCatalogForTarget, removeNotificationRule, type NotificationEventFilter, notificationRule, notificationRuleField, type NotificationFilterCatalog } from '../../../../shared/notificationContactFilters'
import type { ContactAdvancedFilterConfig, ContactAdvancedRule } from '../../../../shared/contactAdvancedFilterTypes'
import styles from './PhoneChat.module.css'

const modes = [{ value: 'all', label: 'Y · Todas' }, { value: 'any', label: 'O · Cualquiera' }]
export function PhoneNotificationContactFilters({ targetKey }: { targetKey: string }) {
  const target = NOTIFICATION_FILTER_TARGETS.find(item => item.key === targetKey)!
  const [open, setOpen] = useState(false)
  const [savedValue] = useUserConfig(target.key, '')
  const [savedCount, setSavedCount] = useState<number | null>(null)
  const count = savedCount ?? notificationConditionCount(savedValue)
  return <div className={styles.settingsField}>
    <PhoneButton variant="ghost" onClick={() => setOpen(true)}><Plus size={16} /> Agregar filtro</PhoneButton>
    {count > 0 && <small>{count} {count === 1 ? 'condición guardada' : 'condiciones guardadas'} · Editar filtros</small>}
    {open && <PhoneNotificationFilterEditor target={target} onSaved={value => setSavedCount(notificationConditionCount(value))} onClose={() => setOpen(false)} />}
  </div>
}
function PhoneNotificationFilterEditor({ target, onClose, onSaved }: { target: typeof NOTIFICATION_FILTER_TARGETS[number]; onClose: () => void; onSaved: (value: NotificationEventFilter) => void }) {
  const [catalog, setCatalog] = useState<NotificationFilterCatalog | null>(null)
  const [eventDraft, setEventDraft] = useState<NotificationEventFilter>(emptyNotificationEventFilter)
  const [clauseIndex, setClauseIndex] = useState(0)
  const draft = eventDraft.clauses[clauseIndex]
  const setDraft = (update: (value: ContactAdvancedFilterConfig) => ContactAdvancedFilterConfig) => setEventDraft(current => ({ ...current, clauses: current.clauses.map((clause, i) => i === clauseIndex ? update(clause) : clause) }))
  const savingRef = useRef(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [fieldSearch, setFieldSearch] = useState('')
  const [addingTo, setAddingTo] = useState<number | 'new' | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    Promise.all([
      apiClient.get<NotificationFilterCatalog>('/user-config/notification-filters/catalog', { signal: controller.signal }),
      apiClient.get<NotificationEventFilter>(`/user-config/notification-filters/${target.key}`, { signal: controller.signal })
    ]).then(([fields, response]) => {
      if (controller.signal.aborted) return
      if (response.version !== 2 || !response.clauses?.length) throw new Error('Actualiza Ristak para editar estos filtros.')
      setEventDraft(response)
      setClauseIndex(0)
      setCatalog(notificationFilterCatalogForTarget(fields, target.key))
      if (!notificationConditionCount(response)) setAddingTo('new')
    }).catch(err => { if (!controller.signal.aborted) setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [target.key, attempt])
  const patchRule = (gi: number, ri: number, patch: Partial<ContactAdvancedRule>) => setDraft(current => ({ ...current, groups: current.groups.map((g, i) => i === gi ? { ...g, rules: g.rules.map((r, j) => j === ri ? { ...r, ...patch } : r) } : g) }))
  const save = async () => {
    if (savingRef.current) return
    savingRef.current = true; setSaving(true); setError('')
    try { await apiClient.post('/user-config', { key: target.key, value: eventDraft }); onSaved(eventDraft); onClose() }
    catch (err) { setError(err instanceof Error ? err.message : 'No se guardó el filtro.') }
    finally { savingRef.current = false; setSaving(false) }
  }
  return <PhoneSheet isOpen onClose={() => { if (!saving) onClose() }} title={addingTo !== null ? "Agregar filtro" : target.label} height="tall">
    <div className={styles.settingsSection}>
      <p>Estas condiciones solo afectan este tipo de aviso. Combina filtros con Y, O o exclusiones.</p>
      {loading && <p role="status">Cargando filtros…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !catalog && <PhoneButton onClick={() => setAttempt(n => n + 1)}>Reintentar</PhoneButton>}
      {catalog && !loading && addingTo === null && <fieldset disabled={saving} style={{ border: 0, padding: 0, minWidth: 0 }}>
        {eventDraft.clauses.length > 1 && <>
          <p>Tus filtros anteriores se conservan aquí. Deben cumplirse todos estos conjuntos; puedes editar o quitar cada uno.</p>
          <PhoneSegmentedTabs options={eventDraft.clauses.map((_, i) => ({ value: String(i), label: `Condiciones ${i + 1}` }))} value={String(clauseIndex)} onChange={value => setClauseIndex(Number(value))} ariaLabel="Condiciones conservadas" />
          <PhoneButton variant="ghost" onClick={() => { setEventDraft(current => ({ ...current, clauses: current.clauses.filter((_, i) => i !== clauseIndex) })); setClauseIndex(0) }}>Quitar este conjunto</PhoneButton>
        </>}
        {!draft.groups.length && <p>Sin filtros: recibirás todos los avisos de este tipo.</p>}
        {!!draft.groups.length && <><p>Combinar grupos de condiciones</p><PhoneSegmentedTabs options={modes} value={draft.groupMode || 'all'} onChange={mode => setDraft(d => ({ ...d, groupMode: mode as 'all' | 'any' }))} ariaLabel="Combinar grupos de condiciones" /></>}
        {draft.groups.map((group, gi) => <section key={group.id} className={styles.settingsSection}>
          <h3>Grupo {gi + 1}</h3>
          <PhoneSegmentedTabs options={modes} value={group.mode} onChange={mode => setDraft(d => ({ ...d, groups: d.groups.map((g, i) => i === gi ? { ...g, mode: mode as 'all' | 'any' } : g) }))} ariaLabel={`Condiciones del bloque ${gi + 1}`} />
          <label className={styles.toggleRow}><span>Excluir si coincide este bloque</span><input type="checkbox" checked={!!group.negate} onChange={e => setDraft(d => ({ ...d, groups: d.groups.map((g, i) => i === gi ? { ...g, negate: e.target.checked } : g) }))} /></label>
          {group.rules.map((rule, ri) => {
            const field = notificationRuleField(rule, catalog)
            const needsValue = !['empty', 'not_empty', 'yes', 'no'].includes(rule.operator)
            const values = Array.isArray(rule.value) ? rule.value : rule.value ? [String(rule.value)] : []
            return <div key={rule.id} className={styles.settingsField}>
              <strong>{field?.label || 'Campo no disponible'}</strong>
              <PhoneSelect title="Condición" ariaLabel={`Condición de ${field?.label}`} options={field?.operators || []} value={rule.operator} onChange={operator => patchRule(gi, ri, { operator: operator as ContactAdvancedRule['operator'] })} />
              {needsValue && (field?.type === 'tags' ? <>
                {(field.options || []).map(option => <label className={styles.toggleRow} key={option.value}><span>{option.label}</span><input type="checkbox" checked={values.includes(option.value)} onChange={e => patchRule(gi, ri, { value: e.target.checked ? [...values, option.value] : values.filter(v => v !== option.value) })} /></label>)}
                {!field.options?.length && <p>No hay etiquetas disponibles.</p>}
              </> : field?.options?.length ? <PhoneSelect title="Valor" ariaLabel={`Valor de ${field.label}`} options={field.options} value={String(rule.value ?? '')} onChange={value => patchRule(gi, ri, { value })} /> : <PhoneTextField label="Valor" value={String(rule.value ?? '')} onChange={value => patchRule(gi, ri, { value })} placeholder={field?.type === 'date' && !['last_days', 'older_days'].includes(rule.operator) ? 'AAAA-MM-DD' : 'Valor'} maxLength={500} />)}
              {needsValue && rule.operator === 'between' && <PhoneTextField label="Hasta" value={String(rule.valueTo ?? '')} onChange={valueTo => patchRule(gi, ri, { valueTo })} placeholder={field?.type === 'date' ? 'AAAA-MM-DD' : 'Hasta'} maxLength={500} />}
              <PhoneButton variant="ghost" onClick={() => setDraft(d => removeNotificationRule(d, gi, ri))}>Quitar condición</PhoneButton>
            </div>
          })}
          <PhoneButton variant="secondary" onClick={() => { setAddingTo(gi); setFieldSearch('') }}>Agregar condición</PhoneButton>
          <PhoneButton variant="danger" onClick={() => setDraft(d => ({ ...d, groups: d.groups.filter((_, i) => i !== gi) }))}>Eliminar bloque</PhoneButton>
        </section>)}
        <PhoneButton variant="secondary" disabled={draft.groups.length >= 10} onClick={() => { setAddingTo('new'); setFieldSearch('') }}>Agregar grupo de condiciones</PhoneButton>
        <PhoneButton variant="ghost" onClick={() => { setEventDraft(emptyNotificationEventFilter()); setClauseIndex(0) }}>Quitar todos los filtros</PhoneButton>
        <PhoneButton fullWidth loading={saving} onClick={save}>Guardar filtros</PhoneButton>
      </fieldset>}
    </div>
    {addingTo !== null && <>
      <div className={styles.settingsSection}>
        <PhoneButton variant="ghost" onClick={() => setAddingTo(null)}>Volver a las condiciones</PhoneButton>
        <PhoneTextField label="Buscar campo" value={fieldSearch} onChange={setFieldSearch} />
        {catalog?.groups.filter(group => group.fields.some(f => f.label.toLocaleLowerCase().includes(fieldSearch.toLocaleLowerCase()))).map(group => <section key={group.label}>
          <h3>{group.label}</h3>
          {group.fields.filter(f => f.label.toLocaleLowerCase().includes(fieldSearch.toLocaleLowerCase())).map(field => <PhoneButton key={field.key} fullWidth variant="ghost" onClick={() => {
            const rule = notificationRule(field)
            setDraft(d => ({ ...d, groups: addingTo === 'new' ? [...d.groups, { id: Math.random().toString(36).slice(2), mode: 'all', negate: false, rules: [rule] }] : d.groups.map((g, i) => i === addingTo ? { ...g, rules: [...g.rules, rule] } : g) }))
            setAddingTo(null)
          }}>{field.label}</PhoneButton>)}
        </section>)}
      </div>
    </>}
  </PhoneSheet>
}
