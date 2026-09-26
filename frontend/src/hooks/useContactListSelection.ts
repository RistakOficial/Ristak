import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Contact } from '@/types'

// Keep the records required by every bulk action, including those on other pages.
export function useContactListSelection(contacts: Contact[], scopeKey: string) {
  const [selection, setSelection] = useState<{ scope: string; contacts: Contact[] }>({ scope: scopeKey, contacts: [] })
  const [selectingAll, setSelectingAll] = useState(false)
  const [allSelected, setAllSelected] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  const currentScopeRef = useRef(scopeKey)
  currentScopeRef.current = scopeKey

  const cancelRequest = useCallback(() => {
    requestRef.current?.abort()
    requestRef.current = null
    setSelectingAll(false)
    setAllSelected(false)
  }, [])

  useEffect(() => {
    cancelRequest()
    setSelection({ scope: scopeKey, contacts: [] })
    return () => requestRef.current?.abort()
  }, [scopeKey, cancelRequest])

  const selectedContacts = useMemo(() => {
    if (selection.scope !== scopeKey) return []
    const visible = new Map(contacts.map(contact => [contact.id, contact]))
    return selection.contacts.map(contact => visible.get(contact.id) ?? contact)
  }, [contacts, selection, scopeKey])
  const selectedContactIds = useMemo(() => selectedContacts.map(contact => contact.id), [selectedContacts])
  const selectedIds = useMemo(() => new Set(selectedContactIds), [selectedContactIds])
  const allPageSelected = contacts.length > 0 && contacts.every(contact => selectedIds.has(contact.id))

  const setSelectedContactIds = (update: string[] | ((previous: string[]) => string[])) => {
    cancelRequest()
    setSelection(previous => {
      const previousContacts = previous.scope === scopeKey ? previous.contacts : []
      const ids = typeof update === 'function' ? update(previousContacts.map(contact => contact.id)) : update
      const available = new Map([...previousContacts, ...contacts].map(contact => [contact.id, contact]))
      return { scope: scopeKey, contacts: [...new Set(ids)].flatMap(id => available.has(id) ? [available.get(id)!] : []) }
    })
  }

  const selectAll = async (load: (signal: AbortSignal) => Promise<Contact[]>) => {
    cancelRequest()
    const controller = new AbortController()
    requestRef.current = controller
    setSelectingAll(true)
    try {
      const allContacts = await load(controller.signal)
      if (controller.signal.aborted || currentScopeRef.current !== scopeKey) return
      setSelection({ scope: scopeKey, contacts: allContacts })
      setAllSelected(true)
    } catch (error) {
      if (!controller.signal.aborted && currentScopeRef.current === scopeKey) throw error
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null
        setSelectingAll(false)
      }
    }
  }

  return { selectedContacts, selectedContactIds, setSelectedContactIds, selectAll, selectingAll, allSelected, allPageSelected }
}
