import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './ContactSearchInput.module.css';
import { Icon } from '../Icon/Icon';
import { SearchField } from '../SearchField';
import { Button } from '../Button';
import { contactsService } from '@/services/contactsService';
import { suppressContactAutofill } from '@/utils/browserAutofill';

export interface ContactSearchInputContact {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
}

interface ContactSearchInputProps {
  value: ContactSearchInputContact | null;
  onChange: (contact: ContactSearchInputContact | null) => void;
  label?: string;
  placeholder?: string;
  required?: boolean;
  error?: string;
  disabled?: boolean;
  portal?: boolean;
  allowCreate?: boolean;
}

const CONTACT_SEARCH_DELAY_MS = 90;

const emptyNewContact = () => ({
  name: '',
  lastName: '',
  email: '',
  phone: ''
});

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildContactDraftFromSearch = (rawSearchTerm: string) => {
  const term = rawSearchTerm.trim();
  const draft = emptyNewContact();
  if (!term) return draft;

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(term)) {
    return { ...draft, email: term };
  }

  const phoneCharactersOnly = /^[+\d\s().-]+$/.test(term);
  const phoneDigits = term.replace(/\D/g, '');
  if (phoneCharactersOnly && phoneDigits.length >= 7) {
    return { ...draft, phone: term };
  }

  const [firstName, ...lastNameParts] = term.split(/\s+/);
  return {
    ...draft,
    name: firstName || term,
    lastName: lastNameParts.join(' ')
  };
};

export const ContactSearchInput: React.FC<ContactSearchInputProps> = ({
  value,
  onChange,
  label = 'Contacto',
  placeholder = 'Buscar o agregar contacto...',
  required = false,
  error,
  disabled = false,
  portal = false,
  allowCreate = true
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<ContactSearchInputContact[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showNewContactForm, setShowNewContactForm] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  // New contact form state
  const [newContact, setNewContact] = useState(emptyNewContact);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [portalDropdownStyle, setPortalDropdownStyle] = useState<React.CSSProperties>();

  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setShowNewContactForm(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const term = searchTerm.trim();

    if (!term || value) {
      setSuggestions([]);
      setIsOpen(false);
      setIsLoading(false);
      setSelectedIndex(-1);
      return;
    }

    if (term.length < 2) {
      setSuggestions([]);
      setIsOpen(true);
      setIsLoading(false);
      setSelectedIndex(-1);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsLoading(true);
      setIsOpen(true);
      setSelectedIndex(-1);

      try {
        const results = await contactsService.searchContacts(term, controller.signal);
        if (!controller.signal.aborted) {
          setSuggestions(results);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setSuggestions([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    }, CONTACT_SEARCH_DELAY_MS);

    setIsOpen(true);
    setIsLoading(true);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchTerm, value]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen || showNewContactForm) return;

      const totalItems = suggestions.length + (allowCreate ? 1 : 0);
      if (totalItems === 0) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev => (prev + 1) % totalItems);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => (prev - 1 + totalItems) % totalItems);
          break;
        case 'Enter':
          e.preventDefault();
          if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
            handleSelectContact(suggestions[selectedIndex]);
          } else if (allowCreate && selectedIndex === suggestions.length) {
            openNewContactForm();
          }
          break;
        case 'Escape':
          setIsOpen(false);
          setSelectedIndex(-1);
          break;
      }
    };

    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [allowCreate, isOpen, suggestions, selectedIndex, showNewContactForm]);

  const updatePortalDropdownPosition = useCallback(() => {
    if (!portal || !isOpen) return;

    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;

    const viewportPadding = 16;
    const dropdownGap = 4;
    const maxDropdownHeight = 280;
    const minDropdownHeight = 180;
    const availableBelow = window.innerHeight - rect.bottom - dropdownGap - viewportPadding;
    const availableAbove = rect.top - dropdownGap - viewportPadding;
    const openAbove = availableBelow < minDropdownHeight && availableAbove > availableBelow;
    const availableSpace = openAbove ? availableAbove : availableBelow;
    const dropdownHeight = Math.min(maxDropdownHeight, Math.max(minDropdownHeight, availableSpace));
    const dropdownWidth = Math.min(rect.width, window.innerWidth - viewportPadding * 2);
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      window.innerWidth - viewportPadding - dropdownWidth
    );
    const top = openAbove
      ? Math.max(viewportPadding, rect.top - dropdownGap - dropdownHeight)
      : Math.min(rect.bottom + dropdownGap, window.innerHeight - viewportPadding - dropdownHeight);

    setPortalDropdownStyle({
      left,
      top,
      width: dropdownWidth,
      maxHeight: dropdownHeight
    });
  }, [isOpen, portal]);

  useLayoutEffect(() => {
    if (!portal || !isOpen) return;

    updatePortalDropdownPosition();

    window.addEventListener('resize', updatePortalDropdownPosition);
    window.addEventListener('scroll', updatePortalDropdownPosition, true);

    return () => {
      window.removeEventListener('resize', updatePortalDropdownPosition);
      window.removeEventListener('scroll', updatePortalDropdownPosition, true);
    };
  }, [isOpen, portal, updatePortalDropdownPosition]);

  const handleSelectContact = (contact: ContactSearchInputContact) => {
    onChange(contact);
    setSearchTerm('');
    setIsOpen(false);
    setSelectedIndex(-1);
  };

  const handleRemoveContact = () => {
    onChange(null);
    setSearchTerm('');
    inputRef.current?.focus();
  };

  const openNewContactForm = () => {
    setNewContact(buildContactDraftFromSearch(searchTerm));
    setFormErrors({});
    setShowNewContactForm(true);
    setSelectedIndex(-1);
  };

  const resetNewContactForm = () => {
    setShowNewContactForm(false);
    setNewContact(emptyNewContact());
    setFormErrors({});
  };

  const validateNewContact = () => {
    const errors: Record<string, string> = {};

    if (!newContact.name.trim()) {
      errors.name = 'El nombre es requerido';
    }

    if (!newContact.email.trim() && !newContact.phone.trim()) {
      errors.contact = 'Debes ingresar al menos un correo o teléfono';
    }

    if (newContact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newContact.email)) {
      errors.email = 'Correo inválido';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleCreateContact = async () => {
    if (!validateNewContact()) return;

    setIsLoading(true);
    try {
      const fullName = `${newContact.name} ${newContact.lastName}`.trim();
      const contactData = {
        name: fullName,
        email: newContact.email || undefined,
        phone: newContact.phone || undefined
      };

      const createdContact = await contactsService.createContact(contactData);
      handleSelectContact(createdContact);

      // Reset form
      setNewContact(emptyNewContact());
      setFormErrors({});
      setShowNewContactForm(false);
    } catch (error) {
      // TODO: Implement proper logging service
      setFormErrors({ general: 'Error al crear el contacto' });
    } finally {
      setIsLoading(false);
    }
  };

  const getContactDisplayName = (contact?: ContactSearchInputContact | null) => (
    contact?.name || `${contact?.firstName || ''} ${contact?.lastName || ''}`.trim() || contact?.email || contact?.phone || 'Sin nombre'
  );

  const getContactDisplayDetail = (contact?: ContactSearchInputContact | null) => (
    contact?.email && contact?.phone
      ? `${contact.email} • ${contact.phone}`
      : contact?.email || contact?.phone || 'Sin información de contacto'
  );

  const highlightMatch = (text: string | undefined, search: string) => {
    if (!text) return '';
    if (!search) return text;
    const normalizedSearch = search.trim();
    if (!normalizedSearch) return text;
    const parts = text.split(new RegExp(`(${escapeRegExp(normalizedSearch)})`, 'gi'));
    return parts.map((part, index) =>
      part.toLowerCase() === normalizedSearch.toLowerCase() ? (
        <mark key={index} className={styles.highlight}>{part}</mark>
      ) : (
        part
      )
    );
  };

  const trimmedSearchTerm = searchTerm.trim();
  const addNewContactLabel = trimmedSearchTerm
    ? `Crear nuevo contacto: ${trimmedSearchTerm}`
    : 'Agregar nuevo contacto';

  const dropdown = isOpen ? (
    <div
      ref={dropdownRef}
      className={`${styles.dropdown} ${portal ? styles.dropdownPortal : ''}`}
      style={portal ? portalDropdownStyle : undefined}
      data-ristak-dropdown-panel
    >
      {showNewContactForm ? (
        // New contact form
        <div className={styles.newContactForm}>
          <div className={styles.formHeader}>
            <h4>Nuevo contacto</h4>
            <button
              type="button"
              className={styles.closeButton}
              data-icon-btn
              aria-label="Cerrar formulario de contacto"
              onClick={resetNewContactForm}
            >
              <Icon name="x" size={16} />
            </button>
          </div>

          <div className={styles.formBody}>
            <div className={styles.formRow}>
              <div className={styles.formField}>
                <input
                  {...suppressContactAutofill}
                  type="text"
                  placeholder="Nombre *"
                  value={newContact.name}
                  onChange={(e) => setNewContact({ ...newContact, name: e.target.value })}
                  className={formErrors.name ? styles.inputError : ''}
                />
                {formErrors.name && <span className={styles.errorText}>{formErrors.name}</span>}
              </div>
              <div className={styles.formField}>
                <input
                  {...suppressContactAutofill}
                  type="text"
                  placeholder="Apellido"
                  value={newContact.lastName}
                  onChange={(e) => setNewContact({ ...newContact, lastName: e.target.value })}
                />
              </div>
            </div>

            <div className={styles.formField}>
              <input
                {...suppressContactAutofill}
                type="email"
                placeholder="Correo electrónico"
                value={newContact.email}
                onChange={(e) => setNewContact({ ...newContact, email: e.target.value })}
                className={formErrors.email ? styles.inputError : ''}
              />
              {formErrors.email && <span className={styles.errorText}>{formErrors.email}</span>}
            </div>

            <div className={styles.formField}>
              <input
                {...suppressContactAutofill}
                type="tel"
                placeholder="Teléfono"
                value={newContact.phone}
                onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })}
              />
            </div>

            {formErrors.contact && (
              <span className={styles.errorText}>{formErrors.contact}</span>
            )}
            {formErrors.general && (
              <span className={styles.errorText}>{formErrors.general}</span>
            )}

            <div className={styles.formActions}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={resetNewContactForm}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleCreateContact}
                disabled={isLoading}
              >
                {isLoading ? 'Creando...' : 'Crear contacto'}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        // Suggestions list
        <>
          {suggestions.length > 0 ? (
            <ul className={styles.suggestions}>
              {suggestions.map((contact, index) => (
                <li
                  key={contact.id}
                  className={`${styles.suggestionItem} ${
                    index === selectedIndex ? styles.selected : ''
                  }`}
                  data-ristak-dropdown-item
                  data-active={index === selectedIndex ? 'true' : undefined}
                  onClick={() => handleSelectContact(contact)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <Icon name="user" size={16} />
                  <div className={styles.contactInfo}>
                    <div className={styles.contactName}>
                      {highlightMatch(getContactDisplayName(contact), searchTerm)}
                    </div>
                    <div className={styles.contactDetails}>
                      {highlightMatch(getContactDisplayDetail(contact), searchTerm)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : searchTerm.length >= 2 && !isLoading ? (
            <div className={styles.noResults}>
              No se encontraron contactos
            </div>
          ) : null}

          {allowCreate && (
            <button
              type="button"
              className={`${styles.addNewButton} ${
                selectedIndex === suggestions.length ? styles.selected : ''
              }`}
              data-ristak-dropdown-item
              data-active={selectedIndex === suggestions.length ? 'true' : undefined}
              onClick={openNewContactForm}
              onMouseEnter={() => setSelectedIndex(suggestions.length)}
            >
              <Icon name="plus" size={16} />
              <span className={styles.addNewButtonText}>
                <span>{addNewContactLabel}</span>
                {trimmedSearchTerm && (
                  <small>Se abrirá el formulario con este dato precargado.</small>
                )}
              </span>
            </button>
          )}
        </>
      )}
    </div>
  ) : null;

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <label className={styles.label}>
        {label} {required && <span className={styles.required}>*</span>}
      </label>

      {value ? (
        <div className={styles.selectedContact}>
          <div className={styles.selectedContactInfo}>
            <p className={styles.selectedContactName}>{getContactDisplayName(value)}</p>
            <p className={styles.selectedContactDetail}>{getContactDisplayDetail(value)}</p>
          </div>
          <button
            type="button"
            className={styles.clearButton}
            onClick={handleRemoveContact}
            disabled={disabled}
            data-icon-btn
            aria-label="Quitar contacto seleccionado"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ) : (
        // Search input
        <>
          <SearchField
            ref={inputRef}
            value={searchTerm}
            onChange={(nextTerm) => setSearchTerm(nextTerm)}
            onFocus={() => searchTerm && setIsOpen(true)}
            onClear={() => {
              setSearchTerm('');
              setSuggestions([]);
              setIsOpen(false);
              setSelectedIndex(-1);
            }}
            placeholder={placeholder}
            disabled={disabled}
            loading={isLoading}
            aria-expanded={isOpen}
            autoComplete={suppressContactAutofill.autoComplete}
          />

          {portal && dropdown ? createPortal(dropdown, document.body) : dropdown}
        </>
      )}

      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
};
