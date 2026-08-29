import type { ContactCustomFieldDefinition } from './types';

export type ContactCustomFieldValueLike = {
  id?: string;
  definitionId?: string;
  fieldId?: string;
  field_id?: string;
  customFieldId?: string;
  key?: string;
  fieldKey?: string;
  field_key?: string;
  name?: string;
  label?: string;
  dataType?: string;
  value?: unknown;
  options?: Array<{ label?: string; value?: string; name?: string } | string>;
  sourceType?: string;
  sourceSiteId?: string;
  source_site_id?: string;
  sourceFormId?: string;
  source_form_id?: string;
  sourceFieldId?: string;
  source_field_id?: string;
};

type CustomFieldIdentityLike = {
  id?: string;
  definitionId?: string;
  fieldId?: string;
  field_id?: string;
  customFieldId?: string;
  key?: string;
  fieldKey?: string;
  field_key?: string;
  label?: string;
  name?: string;
};

type ContactCustomFieldOptionLike = NonNullable<ContactCustomFieldValueLike['options']>[number];

export type ContactCustomFieldOption = {
  label: string;
  value: string;
};

export type UserContactCustomFieldRow = {
  id: string;
  definition: ContactCustomFieldDefinition;
  label: string;
  dataType: string;
  options: ContactCustomFieldOption[];
  selectedValues: string[];
  value: string;
  displayValue: string;
};

const HIDDEN_ACCOUNT_FIELD_TOKENS = new Set([
  'businessname',
  'nombredelnegocio',
  'nombredenegocio',
]);

function normalizedFieldToken(value?: string) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isHiddenAccountCustomField(definition: ContactCustomFieldDefinition) {
  return [definition.key, definition.fieldKey, definition.label, definition.name]
    .map(normalizedFieldToken)
    .some((token) => HIDDEN_ACCOUNT_FIELD_TOKENS.has(token));
}

export function isUserCustomFieldDefinition(definition: ContactCustomFieldDefinition) {
  return !definition.archived
    && !definition.system
    && !definition.systemManaged
    && !definition.locked
    && String(definition.sourceType || '').toLowerCase() !== 'system'
    && !isHiddenAccountCustomField(definition);
}

function normalizedCandidates(values: Array<unknown>) {
  return [...new Set(
    values.map((value) => String(value || '').trim().toLocaleLowerCase('es-MX')).filter(Boolean),
  )];
}

function stableKeys(field: Partial<CustomFieldIdentityLike>) {
  return normalizedCandidates([
    field.definitionId,
    field.id,
    field.customFieldId,
    field.fieldId,
    field.field_id,
    field.key,
    field.fieldKey,
    field.field_key,
  ]);
}

function fallbackKeys(field: Partial<CustomFieldIdentityLike>) {
  return normalizedCandidates([field.label, field.name]).map((value) => `label:${value}`);
}

export function findContactCustomFieldValue(
  definition: ContactCustomFieldDefinition,
  values: ContactCustomFieldValueLike[],
) {
  const definitionStableKeys = new Set(stableKeys(definition));
  const stableMatch = values.find((value) => (
    stableKeys(value).some((key) => definitionStableKeys.has(key))
  ));
  if (stableMatch) return stableMatch;

  const definitionFallbackKeys = new Set(fallbackKeys(definition));
  if (definitionFallbackKeys.size === 0) return undefined;

  const fallbackMatches = values.filter((value) => {
    // Una etiqueta sólo rescata respuestas legacy sin identidad. Si ambos
    // lados tienen IDs/keys distintos, son preguntas diferentes aunque el
    // texto visible coincida.
    if (definitionStableKeys.size > 0 && stableKeys(value).length > 0) return false;
    return fallbackKeys(value).some((key) => definitionFallbackKeys.has(key));
  });
  return fallbackMatches.length === 1 ? fallbackMatches[0] : undefined;
}

function sourceIdentity(definition: ContactCustomFieldDefinition) {
  const fieldId = normalizedCandidates([definition.sourceFieldId])[0];
  const scope = normalizedCandidates([definition.sourceFormId, definition.sourceSiteId])[0];
  return fieldId && scope ? `source:${scope}:field:${fieldId}` : '';
}

function hasMeaningfulValue(field?: ContactCustomFieldValueLike) {
  const value = field?.value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function definitionTimestamp(definition: ContactCustomFieldDefinition) {
  const raw = String(definition.updatedAt || definition.createdAt || '').trim();
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function isUncuratedRecoveryDefinition(
  definition: ContactCustomFieldDefinition,
  matchingField?: ContactCustomFieldValueLike,
) {
  if (String(definition.sourceType || '').trim().toLowerCase() !== 'submission_recovery') return false;
  if (hasMeaningfulValue(matchingField)) return false;
  const fieldGroup = String(definition.fieldGroup || '').trim().toLowerCase();
  return !String(definition.folderId || '').trim() && (!fieldGroup || fieldGroup === 'general');
}

export function selectUserCustomFieldDefinitions(
  definitions: ContactCustomFieldDefinition[],
  values: ContactCustomFieldValueLike[],
) {
  const candidates = definitions
    .filter(isUserCustomFieldDefinition)
    .map((definition, index) => ({
      definition,
      index,
      match: findContactCustomFieldValue(definition, values),
      sourceIdentity: sourceIdentity(definition),
    }))
    .filter(({ definition, match }) => !isUncuratedRecoveryDefinition(definition, match));

  const visibleIndexes = new Set<number>();
  const candidatesBySource = new Map<string, typeof candidates>();

  candidates.forEach((candidate) => {
    if (!candidate.sourceIdentity) {
      visibleIndexes.add(candidate.index);
      return;
    }
    const group = candidatesBySource.get(candidate.sourceIdentity) || [];
    group.push(candidate);
    candidatesBySource.set(candidate.sourceIdentity, group);
  });

  candidatesBySource.forEach((group) => {
    if (group.length === 1) {
      visibleIndexes.add(group[0].index);
      return;
    }

    const populated = group.filter((candidate) => hasMeaningfulValue(candidate.match));
    if (populated.length > 0) {
      populated.forEach((candidate) => visibleIndexes.add(candidate.index));
      return;
    }

    const preferred = group.reduce((current, candidate) => (
      !current || definitionTimestamp(candidate.definition) > definitionTimestamp(current.definition)
        ? candidate
        : current
    ), undefined as typeof group[number] | undefined);
    if (preferred) visibleIndexes.add(preferred.index);
  });

  return candidates
    .filter((candidate) => visibleIndexes.has(candidate.index))
    .map((candidate) => candidate.definition);
}

function optionValue(option: ContactCustomFieldOptionLike) {
  if (option && typeof option === 'object') {
    return String(option.value || option.label || option.name || '').trim();
  }
  return String(option || '').trim();
}

function optionLabel(option: ContactCustomFieldOptionLike) {
  if (option && typeof option === 'object') {
    return String(option.label || option.name || option.value || '').trim();
  }
  return String(option || '').trim();
}

export function normalizeContactCustomFieldOptions(options: unknown): ContactCustomFieldOption[] {
  if (!Array.isArray(options)) return [];

  const byValue = new Map<string, ContactCustomFieldOption>();
  options.forEach((option) => {
    const value = optionValue(option as ContactCustomFieldOptionLike);
    const label = optionLabel(option as ContactCustomFieldOptionLike);
    if (value && !byValue.has(value)) byValue.set(value, { value, label: label || value });
  });
  return [...byValue.values()];
}

function selectedValue(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    return String(item.value || item.label || item.name || '').trim();
  }
  return String(value ?? '').trim();
}

export function getContactCustomFieldSelectedValues(rawValue: unknown) {
  return (Array.isArray(rawValue) ? rawValue : [rawValue])
    .map(selectedValue)
    .filter(Boolean);
}

export function resolveContactCustomFieldOptions(
  definitionOptions: unknown,
  valueField?: ContactCustomFieldValueLike,
) {
  const currentOptions = normalizeContactCustomFieldOptions(definitionOptions);
  const savedOptions = normalizeContactCustomFieldOptions(valueField?.options);
  const byValue = new Map(
    (currentOptions.length ? currentOptions : savedOptions)
      .map((option) => [option.value, option]),
  );
  const savedByValue = new Map(savedOptions.map((option) => [option.value, option]));

  // El catálogo puede cambiar después de que la persona respondió. Conserva
  // únicamente la opción histórica elegida y su etiqueta original; no revive
  // todas las alternativas retiradas del formulario.
  normalizeContactCustomFieldOptions(
    Array.isArray(valueField?.value) ? valueField.value : [valueField?.value],
  ).forEach((answer) => {
    byValue.set(
      answer.value,
      savedByValue.get(answer.value) || byValue.get(answer.value) || answer,
    );
  });

  return [...byValue.values()];
}

function displayValue(rawValue: unknown, options: ContactCustomFieldValueLike['options'] = []) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return '';
  if (typeof rawValue === 'boolean') return rawValue ? 'Sí' : 'No';

  const labelsByValue = new Map(options.map((option) => [optionValue(option), optionLabel(option)]));
  const displayOne = (value: unknown) => {
    const raw = selectedValue(value);
    return labelsByValue.get(raw) || raw;
  };

  if (Array.isArray(rawValue)) return rawValue.map(displayOne).filter(Boolean).join(', ');
  if (typeof rawValue === 'object') {
    const direct = displayOne(rawValue);
    if (direct) return direct;
    try {
      return JSON.stringify(rawValue);
    } catch {
      return String(rawValue);
    }
  }
  return displayOne(rawValue);
}

function editableValue(rawValue: unknown) {
  if (rawValue === null || rawValue === undefined) return '';
  if (Array.isArray(rawValue)) return rawValue.map(selectedValue).filter(Boolean).join(', ');
  if (typeof rawValue === 'object') {
    try {
      return JSON.stringify(rawValue);
    } catch {
      return String(rawValue);
    }
  }
  return String(rawValue);
}

export function buildUserCustomFieldRows(
  definitions: ContactCustomFieldDefinition[],
  values: ContactCustomFieldValueLike[],
): UserContactCustomFieldRow[] {
  return selectUserCustomFieldDefinitions(definitions, values).map((definition, index) => {
    const field = findContactCustomFieldValue(definition, values);
    const rawValue = field?.value;
    const dataType = String(definition.dataType || field?.dataType || 'text').trim().toLowerCase();
    const isChoice = ['radio', 'dropdown', 'select', 'checkboxes', 'multiselect'].includes(dataType);
    const options = isChoice
      ? resolveContactCustomFieldOptions(definition.options, field)
      : normalizeContactCustomFieldOptions(definition.options?.length ? definition.options : field?.options);
    const selectedValues = getContactCustomFieldSelectedValues(rawValue);
    return {
      id: definition.definitionId || definition.fieldKey || definition.key || `field-${index}`,
      definition,
      label: definition.label || definition.name || `Campo ${index + 1}`,
      dataType,
      options,
      selectedValues,
      value: isChoice ? (selectedValues[0] || '') : editableValue(rawValue),
      displayValue: displayValue(rawValue, options),
    };
  });
}

export function buildContactCustomFieldUpdate(
  row: UserContactCustomFieldRow,
  value: unknown,
): ContactCustomFieldValueLike {
  return {
    definitionId: row.definition.definitionId,
    key: row.definition.key,
    fieldKey: row.definition.fieldKey,
    label: row.label,
    dataType: row.dataType,
    options: row.options,
    value,
  };
}
