import type { ContactCustomFieldDefinition } from './types';

export type ContactCustomFieldValueLike = {
  id?: string;
  definitionId?: string;
  fieldId?: string;
  field_id?: string;
  key?: string;
  fieldKey?: string;
  name?: string;
  label?: string;
  value?: unknown;
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

function normalizedCandidates(values: Array<string | undefined>) {
  return values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
}

function findValue(
  definition: ContactCustomFieldDefinition,
  values: ContactCustomFieldValueLike[],
) {
  const definitionIds = normalizedCandidates([definition.definitionId]);
  const definitionKeys = normalizedCandidates([definition.key, definition.fieldKey]);
  return values.find((value) => {
    const valueIds = normalizedCandidates([value.definitionId, value.fieldId, value.field_id, value.id]);
    if (definitionIds.some((id) => valueIds.includes(id))) return true;
    const valueKeys = normalizedCandidates([value.key, value.fieldKey]);
    return definitionKeys.some((key) => valueKeys.includes(key));
  });
}

export function buildUserCustomFieldRows(
  definitions: ContactCustomFieldDefinition[],
  values: ContactCustomFieldValueLike[],
) {
  return definitions.filter(isUserCustomFieldDefinition).map((definition, index) => {
    const field = findValue(definition, values);
    const rawValue = field?.value;
    const value = Array.isArray(rawValue)
      ? rawValue.join(', ')
      : rawValue === null || rawValue === undefined
        ? ''
        : String(rawValue);
    return {
      id: definition.definitionId || definition.fieldKey || definition.key || `field-${index}`,
      definition,
      label: definition.label || definition.name || `Campo ${index + 1}`,
      value,
    };
  });
}
