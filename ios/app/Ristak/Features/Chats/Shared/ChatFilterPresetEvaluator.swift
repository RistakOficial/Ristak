import Foundation

/// Evaluación client-side de presets condicionales sobre las filas cargadas
/// (doc research/03 §3.4; semántica de `PhoneChat.tsx:1644-1853`). Igual que
/// /movil, se evalúa sobre la página cargada — con paginación un preset puede
/// verse "incompleto" (gap conocido doc 03 §6.5, no inventar filtro server-side).
enum ChatFilterPresetEvaluator {
    static func matches(_ preset: ChatFilterPreset, contact: ChatContact) -> Bool {
        guard !preset.rules.isEmpty else { return true }
        if preset.matchAll {
            return preset.rules.allSatisfy { ruleMatches($0, contact: contact) }
        }
        return preset.rules.contains { ruleMatches($0, contact: contact) }
    }

    // MARK: - Reglas

    static func ruleMatches(_ rule: ChatFilterPresetRule, contact: ChatContact) -> Bool {
        switch rule.field {
        case "chat_segment":
            return matchesSegment(rule, contact: contact)
        case "business_phone":
            return compareText(candidates(contact.lastBusinessPhoneNumberId, contact.lastBusinessPhone), rule: rule)
        case "channel":
            return compareText([ChatRowSignals.channelKey(contact)], rule: rule)
        case "origin":
            return compareText([ChatRowSignals.originKey(contact)], rule: rule)
        case "social":
            return compareText([ChatRowSignals.socialKey(contact)], rule: rule)
        case "activity":
            return matchesActivityRule(rule, contact: contact)
        case "full_name":
            return compareText([contact.name], rule: rule)
        case "phone":
            var phones = [contact.phone]
            phones.append(contentsOf: contact.phones.map(\.phone))
            return compareText(phones, rule: rule)
        case "email":
            return compareText([contact.email], rule: rule)
        case "status":
            return compareText([contact.status], rule: rule)
        case "source":
            return compareText([contact.source ?? ""], rule: rule)
        case "unread":
            return compareBool(contact.visibleUnreadCount > 0, rule: rule)
        case "tags":
            return compareArray(contact.tags, rule: rule)
        default:
            if rule.field.hasPrefix("custom:") {
                let identity = String(rule.field.dropFirst("custom:".count))
                return matchesCustomField(identity: identity, rule: rule, contact: contact)
            }
            // Campo desconocido: no bloquear la fila.
            return true
        }
    }

    private static func candidates(_ values: String...) -> [String] {
        values.filter { !$0.isEmpty }
    }

    private static func matchesSegment(_ rule: ChatFilterPresetRule, contact: ChatContact) -> Bool {
        let segment = rule.values.first ?? ""
        let belongs: Bool
        switch segment {
        case "customers": belongs = ChatRowSignals.isCustomer(contact)
        case "leads": belongs = ChatRowSignals.isLead(contact)
        case "appointments": belongs = ChatRowSignals.isAppointment(contact)
        case "unread": belongs = contact.visibleUnreadCount > 0
        case "comments": belongs = ChatRowSignals.hasCommentSignal(contact)
        default: belongs = false
        }
        return rule.op == "is_not" ? !belongs : belongs
    }

    private static func matchesActivityRule(_ rule: ChatFilterPresetRule, contact: ChatContact) -> Bool {
        let value = rule.values.first ?? ""
        let belongs = ChatRowSignals.matchesActivity(value, contact: contact)
        return rule.op == "is_not" ? !belongs : belongs
    }

    // MARK: - Comparadores

    /// Texto con normalización sin acentos (doc 03 §3.4).
    private static func compareText(_ rawCandidates: [String], rule: ChatFilterPresetRule) -> Bool {
        let candidates = rawCandidates.map(ristakFoldedText).filter { !$0.isEmpty }
        let targets = rule.values.map(ristakFoldedText).filter { !$0.isEmpty }
        let joined = candidates.joined(separator: " ")

        switch rule.op {
        case "empty":
            return candidates.isEmpty
        case "not_empty":
            return !candidates.isEmpty
        case "is", "eq":
            return targets.contains { target in candidates.contains(target) }
        case "is_not", "neq":
            return !targets.contains { target in candidates.contains(target) }
        case "contains", "any":
            return targets.contains { joined.contains($0) }
        case "not_contains", "none":
            return !targets.contains { joined.contains($0) }
        case "all":
            return targets.allSatisfy { joined.contains($0) }
        case "starts_with":
            return targets.contains { target in candidates.contains { $0.hasPrefix(target) } }
        case "ends_with":
            return targets.contains { target in candidates.contains { $0.hasSuffix(target) } }
        case "gt", "lt", "gte", "lte", "between":
            return compareNumeric(candidates.compactMap(Double.init), rule: rule)
        default:
            return targets.contains { target in candidates.contains(target) }
        }
    }

    private static func compareBool(_ value: Bool, rule: ChatFilterPresetRule) -> Bool {
        switch rule.op {
        case "yes":
            return value
        case "no":
            return !value
        default:
            let target = ristakFoldedText(rule.values.first ?? "")
            let targetBool = ["1", "true", "yes", "si", "sí", "on"].contains(target)
            return rule.op == "is_not" ? value != targetBool : value == targetBool
        }
    }

    private static func compareArray(_ values: [String], rule: ChatFilterPresetRule) -> Bool {
        let set = Set(values.map(ristakFoldedText))
        let targets = rule.values.map(ristakFoldedText).filter { !$0.isEmpty }
        switch rule.op {
        case "empty": return set.isEmpty
        case "not_empty": return !set.isEmpty
        case "all": return targets.allSatisfy { set.contains($0) }
        case "none", "not_contains", "is_not": return !targets.contains { set.contains($0) }
        default: // any / contains / is
            return targets.contains { set.contains($0) }
        }
    }

    private static func compareNumeric(_ numbers: [Double], rule: ChatFilterPresetRule) -> Bool {
        guard let value = numbers.first else { return false }
        let target = Double(rule.values.first ?? "") ?? 0
        switch rule.op {
        case "eq": return value == target
        case "neq": return value != target
        case "gt": return value > target
        case "gte": return value >= target
        case "lt": return value < target
        case "lte": return value <= target
        case "between":
            let upper = Double(rule.valueTo ?? "") ?? target
            return value >= min(target, upper) && value <= max(target, upper)
        default: return false
        }
    }

    // MARK: - Campos personalizados

    private static func matchesCustomField(identity: String, rule: ChatFilterPresetRule, contact: ChatContact) -> Bool {
        let foldedIdentity = ristakFoldedText(identity)
        let field = contact.customFields.first { field in
            [field.key, field.fieldKey, field.definitionId, field.id]
                .map(ristakFoldedText)
                .contains(foldedIdentity)
        }

        let rawValue = field?.value
        let text = customFieldText(rawValue)

        switch rule.op {
        case "empty":
            return text.isEmpty
        case "not_empty":
            return !text.isEmpty
        case "yes", "no":
            let boolValue = customFieldBool(rawValue)
            return rule.op == "yes" ? boolValue : !boolValue
        case "eq", "neq", "gt", "gte", "lt", "lte", "between":
            guard let number = customFieldNumber(rawValue) else { return false }
            return compareNumeric([number], rule: rule)
        case "before", "after", "on", "last_days", "older_days":
            return compareDate(text, rule: rule)
        default:
            return compareText([text], rule: rule)
        }
    }

    private static func customFieldText(_ value: RistakJSONValue?) -> String {
        guard let value else { return "" }
        if let string = value.stringValue { return string.trimmingCharacters(in: .whitespacesAndNewlines) }
        return ""
    }

    private static func customFieldNumber(_ value: RistakJSONValue?) -> Double? {
        guard let value else { return nil }
        if let string = value.stringValue { return Double(string) }
        return nil
    }

    private static func customFieldBool(_ value: RistakJSONValue?) -> Bool {
        guard let string = value?.stringValue else { return false }
        return ["1", "true", "yes", "si", "sí", "on"].contains(ristakFoldedText(string))
    }

    private static func compareDate(_ text: String, rule: ChatFilterPresetRule) -> Bool {
        guard let date = RistakDateParsing.date(fromISO: text) else { return false }
        let now = Date()
        switch rule.op {
        case "before":
            guard let target = RistakDateParsing.date(fromISO: rule.values.first) else { return false }
            return date < target
        case "after":
            guard let target = RistakDateParsing.date(fromISO: rule.values.first) else { return false }
            return date > target
        case "on":
            guard let target = RistakDateParsing.date(fromISO: rule.values.first) else { return false }
            return Calendar.current.isDate(date, inSameDayAs: target)
        case "last_days":
            let days = Double(rule.values.first ?? "") ?? 0
            return date >= now.addingTimeInterval(-days * 86_400)
        case "older_days":
            let days = Double(rule.values.first ?? "") ?? 0
            return date < now.addingTimeInterval(-days * 86_400)
        default:
            return false
        }
    }
}
