import Foundation
import XCTest
@testable import Ristak

final class ContactCustomFieldResolutionTests: XCTestCase {
    func testUsesPopulatedHistoricalDefinitionInsteadOfEmptyCurrentPlaceholder() throws {
        let definitions = try decodeDefinitions(#"""
        [
          {
            "definitionId":"field-service-old",
            "key":"service_old",
            "fieldKey":"service_old",
            "label":"¿Qué servicio buscas?",
            "dataType":"radio",
            "options":[{"value":"music","label":"Producción musical"}],
            "sourceFormId":"form-contact",
            "sourceFieldId":"question-service",
            "updatedAt":"2026-07-01T12:00:00.000Z"
          },
          {
            "definitionId":"field-service-current",
            "key":"service_current",
            "fieldKey":"service_current",
            "label":"¿Qué servicio buscas?",
            "dataType":"radio",
            "options":[{"value":"mix","label":"Mezcla y masterización"}],
            "sourceFormId":"form-contact",
            "sourceFieldId":"question-service",
            "updatedAt":"2026-08-01T12:00:00.000Z"
          }
        ]
        """#)
        let values = try decodeValues(#"""
        [
          {
            "definitionId":"field-service-old",
            "key":"service_old",
            "fieldKey":"service_old",
            "label":"¿Qué servicio buscas?",
            "dataType":"radio",
            "value":"music"
          }
        ]
        """#)

        let resolved = ContactInfoCustomFieldResolution.resolve(
            definitions: definitions,
            values: values
        )

        XCTAssertEqual(resolved.map(\.definition.definitionId), ["field-service-old"])
        XCTAssertEqual(resolved.first?.value?.value, .string("music"))
        XCTAssertEqual(
            ContactInfoCustomFieldValueFormat.optionLabel(
                for: "music",
                options: resolved.first?.definition.options ?? []
            ),
            "Producción musical"
        )
    }

    func testUsesNewestVersionWhenSharedSourceHasNoAnswer() throws {
        let definitions = try decodeDefinitions(#"""
        [
          {"definitionId":"old","key":"old","label":"Pregunta","sourceSiteId":"site","sourceFieldId":"question","updatedAt":"2026-07-01T00:00:00.000Z"},
          {"definitionId":"new","key":"new","label":"Pregunta","sourceSiteId":"site","sourceFieldId":"question","updatedAt":"2026-08-01T00:00:00.000Z"}
        ]
        """#)

        let resolved = ContactInfoCustomFieldResolution.resolve(definitions: definitions, values: [])

        XCTAssertEqual(resolved.map(\.definition.definitionId), ["new"])
    }

    func testRecoversUniqueLegacyLabelButDoesNotMixModernFieldsWithSameLabel() throws {
        let legacyDefinitions = try decodeDefinitions(#"""
        [{"definitionId":"instagram","key":"instagram","label":"Instagram"}]
        """#)
        let legacyValues = try decodeValues(#"""
        [{"label":"Instagram","value":"@artista"}]
        """#)
        XCTAssertEqual(
            ContactInfoCustomFieldResolution.resolve(
                definitions: legacyDefinitions,
                values: legacyValues
            ).first?.value?.value,
            .string("@artista")
        )

        let definitions = try decodeDefinitions(#"""
        [
          {"definitionId":"field-a","key":"a","label":"Elige una opción"},
          {"definitionId":"field-b","key":"b","label":"Elige una opción"}
        ]
        """#)
        let values = try decodeValues(#"""
        [
          {"definitionId":"field-a","key":"a","label":"Elige una opción","value":"A"},
          {"definitionId":"field-b","key":"b","label":"Elige una opción","value":"B"}
        ]
        """#)

        let resolved = ContactInfoCustomFieldResolution.resolve(definitions: definitions, values: values)
        XCTAssertEqual(resolved.map { $0.value?.value }, [.string("A"), .string("B")])
    }

    private func decodeDefinitions(_ json: String) throws -> [ContactCustomFieldDefinition] {
        try JSONDecoder().decode([ContactCustomFieldDefinition].self, from: Data(json.utf8))
    }

    private func decodeValues(_ json: String) throws -> [ContactCustomFieldValue] {
        try JSONDecoder().decode([ContactCustomFieldValue].self, from: Data(json.utf8))
    }
}
