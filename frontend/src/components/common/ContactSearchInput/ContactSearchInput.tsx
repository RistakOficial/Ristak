import React, { useState, useRef, useEffect } from 'react';
import styles from './ContactSearchInput.module.css';
import { Icon } from '../Icon/Icon';
import { Contact } from '@/types';
import { contactsService } from '@/services/contactsService';

interface ContactSearchInputProps {
  value: Contact | null;
  onChange: (contact: Contact | null) => void;
  placeholder?: string;
  required?: boolean;
  error?: string;
  disabled?: boolean;
}

const CONTACT_SEARCH_DELAY_MS = 90;

export const ContactSearchInput: React.FC<ContactSearchInputProps> = ({
  value,
  onChange,
  placeholder = 'Buscar o agregar contacto...',
  required = false,
  error,
  disabled = false
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showNewContactForm, setShowNewContactForm] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  // New contact form state
  const [newContact, setNewContact] = useState({
    name: '',
    lastName: '',
    email: '',
    phone: ''
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

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

    if (term.length < 2 || value) {
      setSuggestions([]);
      setIsOpen(false);
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

      const totalItems = suggestions.length + 1; // +1 for "Add new contact" option

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
          } else if (selectedIndex === suggestions.length) {
            setShowNewContactForm(true);
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
  }, [isOpen, suggestions, selectedIndex, showNewContactForm]);

  const handleSelectContact = (contact: Contact) => {
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
      setNewContact({ name: '', lastName: '', email: '', phone: '' });
      setFormErrors({});
      setShowNewContactForm(false);
    } catch (error) {
      // TODO: Implement proper logging service
      setFormErrors({ general: 'Error al crear el contacto' });
    } finally {
      setIsLoading(false);
    }
  };

  const highlightMatch = (text: string, search: string) => {
    if (!search) return text;
    const parts = text.split(new RegExp(`(${search})`, 'gi'));
    return parts.map((part, index) =>
      part.toLowerCase() === search.toLowerCase() ? (
        <mark key={index} className={styles.highlight}>{part}</mark>
      ) : (
        part
      )
    );
  };

  return (
    <div className={styles.wrapper}>
      <label className={styles.label}>
        Contacto {required && <span className={styles.required}>*</span>}
      </label>

      {value ? (
        // Selected contact chip
        <div className={styles.chip}>
          <div className={styles.chipContent}>
            <Icon name="user" size={14} />
            <span className={styles.chipName}>{value.name}</span>
            {value.email && <span className={styles.chipEmail}>({value.email})</span>}
          </div>
          <button
            type="button"
            className={styles.chipRemove}
            onClick={handleRemoveContact}
            disabled={disabled}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ) : (
        // Search input
        <>
          <div className={styles.inputWrapper}>
            <Icon name="search" size={16} className={styles.searchIcon} />
            <input
              ref={inputRef}
              type="text"
              className={styles.input}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onFocus={() => searchTerm && setIsOpen(true)}
              placeholder={placeholder}
              disabled={disabled}
            />
            {isLoading && (
              <div className={styles.spinner}>
                <Icon name="loader-2" size={16} />
              </div>
            )}
          </div>

          {isOpen && (
            <div ref={dropdownRef} className={styles.dropdown} data-ristak-dropdown-panel>
              {showNewContactForm ? (
                // New contact form
                <div className={styles.newContactForm}>
                  <div className={styles.formHeader}>
                    <h4>Nuevo Contacto</h4>
                    <button
                      type="button"
                      className={styles.closeButton}
                      onClick={() => {
                        setShowNewContactForm(false);
                        setNewContact({ name: '', lastName: '', email: '', phone: '' });
                        setFormErrors({});
                      }}
                    >
                      <Icon name="x" size={16} />
                    </button>
                  </div>

                  <div className={styles.formBody}>
                    <div className={styles.formRow}>
                      <div className={styles.formField}>
                        <input
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
                          type="text"
                          placeholder="Apellido"
                          value={newContact.lastName}
                          onChange={(e) => setNewContact({ ...newContact, lastName: e.target.value })}
                        />
                      </div>
                    </div>

                    <div className={styles.formField}>
                      <input
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
                      <button
                        type="button"
                        className={styles.cancelButton}
                        onClick={() => {
                          setShowNewContactForm(false);
                          setNewContact({ name: '', lastName: '', email: '', phone: '' });
                          setFormErrors({});
                        }}
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        className={styles.saveButton}
                        onClick={handleCreateContact}
                        disabled={isLoading}
                      >
                        {isLoading ? 'Guardando...' : 'Guardar'}
                      </button>
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
                              {highlightMatch(contact.name, searchTerm)}
                            </div>
                            {(contact.email || contact.phone) && (
                              <div className={styles.contactDetails}>
                                {contact.email && highlightMatch(contact.email, searchTerm)}
                                {contact.email && contact.phone && ' • '}
                                {contact.phone && highlightMatch(contact.phone, searchTerm)}
                              </div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : searchTerm.length >= 2 && !isLoading ? (
                    <div className={styles.noResults}>
                      No se encontraron contactos
                    </div>
                  ) : null}

                  <button
                    type="button"
                    className={`${styles.addNewButton} ${
                      selectedIndex === suggestions.length ? styles.selected : ''
                    }`}
                    data-ristak-dropdown-item
                    data-active={selectedIndex === suggestions.length ? 'true' : undefined}
                    onClick={() => setShowNewContactForm(true)}
                    onMouseEnter={() => setSelectedIndex(suggestions.length)}
                  >
                    <Icon name="plus" size={16} />
                    <span>Agregar nuevo contacto</span>
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}

      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
};
