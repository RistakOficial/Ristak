import { useEffect, useState } from 'react'
import apiClient from '@/services/apiClient'
import { PhoneSheet, PhoneButton, PhoneTextField, PhoneSegmentedTabs } from '@/components/phone/ui'
import { PhoneSelect } from '@/components/phone/PhoneSelect'
import { NOTIFICATION_FILTER_TARGETS, emptyNotificationFilter, notificationRule, notificationRuleField, type NotificationFilterCatalog } from '../../../../shared/notificationContactFilters'
import type { ContactAdvancedFilterConfig, ContactAdvancedRule } from '../../../../shared/contactAdvancedFilterTypes'
import styles from './PhoneChat.module.css'

const modes = [{ value: 'all', label: 'Todas' }, { value: 'any', label: 'Cualquiera' }]
export function PhoneNotificationContactFilters() {
  const [target, setTarget] = useState<typeof NOTIFICATION_FILTER_TARGETS[number] | null>(null)
  return <section className={styles.settingsSection}>
    <h3>Filtros por contacto</h3>
    <p>Elige de quién quieres recibir avisos. Los filtros son personales y se conservan al cambiar de celular.</p>
    {NOTIFICATION_FILTER_TARGETS.map(item => <PhoneButton key={item.key} variant="secondary" fullWidth onClick={() => setTarget(item)}>{item.label}</PhoneButton>)}
    {target && <PhoneNotificationFilterEditor key={target.key} target={target} onClose={() => setTarget(null)} />}
  </section>
}
function PhoneNotificationFilterEditor({ target, onClose }: { target: typeof NOTIFICATION_FILTER_TARGETS[number]; onClose: () => void }) {
  const [catalog, setCatalog] = useState<NotificationFilterCatalog | null>(null)
  const [draft, setDraft] = useState<ContactAdvancedFilterConfig>(emptyNotificationFilter)
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
      apiClient.get<{ config: Record<string, string> }>('/user-config', { params: { keys: target.key }, signal: controller.signal })
    ]).then(([fields, response]) => {
      if (controller.signal.aborted) return
      const raw = response.config[target.key]
      const config = raw ? JSON.parse(raw) : emptyNotificationFilter()
      if (config.version !== 1 || !Array.isArray(config.groups)) throw new Error('El filtro guardado no es válido.')
      setDraft(config)
      setCatalog(fields)
    }).catch(err => { if (!controller.signal.aborted) setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [target.key, attempt])
  const patchRule = (gi: number, ri: number, patch: Partial<ContactAdvancedRule>) => setDraft(current => ({ ...current, groups: current.groups.map((g, i) => i === gi ? { ...g, rules: g.rules.map((r, j) => j === ri ? { ...r, ...patch } : r) } : g) }))
  const save = async () => {
    setSaving(true); setError('')
    try { await apiClient.post('/user-config', { key: target.key, value: draft }); onClose() }
    catch (err) { setError(err instanceof Error ? err.message : 'No se guardó el filtro.') }
    finally { setSaving(false) }
  }
  return <PhoneSheet isOpen onClose={() => { if (!saving) onClose() }} title={target.label} height="tall">
    <div className={styles.settingsSection}>
      <p>Solo recibirás avisos de contactos que cumplan las condiciones. Se combinan con tus interruptores y calendarios.</p>
      {target.key !== 'contact_push_notification_filter' && <p>También se aplica el filtro de Todos los avisos de contactos.</p>}
      {loading && <p role="status">Cargando filtros…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !catalog && <PhoneButton onClick={() => setAttempt(n => n + 1)}>Reintentar</PhoneButton>}
      {catalog && !loading && <fieldset disabled={saving} style={{ border: 0, padding: 0, minWidth: 0 }}>
        {!draft.groups.length && <p>Sin condiciones: este filtro permite todos los contactos.</p>}
        {!!draft.groups.length && <><p>Coincidencia de bloques</p><PhoneSegmentedTabs options={modes} value={draft.groupMode || 'all'} onChange={mode => setDraft(d => ({ ...d, groupMode: mode as 'all' | 'any' }))} ariaLabel="Coincidencia de bloques" /></>}
        {draft.groups.map((group, gi) => <section key={group.id} className={styles.settingsSection}>
          <h3>Bloque {gi + 1}</h3>
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
              <PhoneButton variant="ghost" onClick={() => setDraft(d => ({ ...d, groups: d.groups.map((g, i) => i === gi ? { ...g, rules: g.rules.filter((_, j) => j !== ri) } : g) }))}>Quitar condición</PhoneButton>
            </div>
          })}
          <PhoneButton variant="secondary" onClick={() => { setAddingTo(gi); setFieldSearch('') }}>Agregar condición</PhoneButton>
          <PhoneButton variant="danger" onClick={() => setDraft(d => ({ ...d, groups: d.groups.filter((_, i) => i !== gi) }))}>Eliminar bloque</PhoneButton>
        </section>)}
        <PhoneButton variant="secondary" disabled={draft.groups.length >= 10} onClick={() => { setAddingTo('new'); setFieldSearch('') }}>Agregar bloque</PhoneButton>
        <PhoneButton variant="ghost" onClick={() => setDraft(emptyNotificationFilter())}>Quitar todos los filtros</PhoneButton>
        <PhoneButton fullWidth loading={saving} onClick={save}>Guardar filtros</PhoneButton>
      </fieldset>}
    </div>
    <PhoneSheet isOpen={addingTo !== null} onClose={() => setAddingTo(null)} title="Elegir campo" height="tall">
      <div className={styles.settingsSection}>
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
    </PhoneSheet>
  </PhoneSheet>
}
