import SwiftUI
import XCTest
@testable import Ristak

final class WhatsAppTextFormatterTests: XCTestCase {
    func testParsesEverySupportedInlineFormatWithoutDelimiters() {
        let line = try! XCTUnwrap(
            WhatsAppTextFormatter.parsedLines(
                "Confirmado: *hoy* _por favor_ ~antes~ `ABC-12` ```MX-900```"
            ).first
        )

        XCTAssertEqual(line.kind, .paragraph)
        XCTAssertEqual(line.segments.map(\.text).joined(), "Confirmado: hoy por favor antes ABC-12 MX-900")
        XCTAssertEqual(line.segments[1].styles, .bold)
        XCTAssertEqual(line.segments[3].styles, .italic)
        XCTAssertEqual(line.segments[5].styles, .strike)
        XCTAssertEqual(line.segments[7].styles, .inlineCode)
        XCTAssertEqual(line.segments[9].styles, .monospace)
    }

    func testSupportsNestedBoldItalicAndKeepsLiteralCodeUntouched() {
        let line = try! XCTUnwrap(
            WhatsAppTextFormatter.parsedLines("*_Importante_* y `*literal*`").first
        )

        XCTAssertEqual(line.segments.map(\.text).joined(), "Importante y *literal*")
        XCTAssertEqual(line.segments[0].styles, [.bold, .italic])
        XCTAssertEqual(line.segments[2].styles, .inlineCode)
    }

    func testKeepsIncompleteSyntaxAndIdentifiersLiteral() {
        let source = "folio_123 y *sin cierre y correo_nombre@empresa.com"
        let line = try! XCTUnwrap(WhatsAppTextFormatter.parsedLines(source).first)

        XCTAssertEqual(line.segments, [.init(text: source, styles: [])])
    }

    func testParsesWhatsAppListsAndQuotes() {
        let lines = WhatsAppTextFormatter.parsedLines(
            "- *Primero*\n2. _Segundo_\n> ~Ojo~"
        )

        XCTAssertEqual(lines.map(\.kind), [.bullet, .numbered("2"), .quote])
        XCTAssertEqual(lines.map { $0.segments.map(\.text).joined() }, ["Primero", "Segundo", "Ojo"])
        XCTAssertEqual(lines[0].segments[0].styles, .bold)
        XCTAssertEqual(lines[1].segments[0].styles, .italic)
        XCTAssertEqual(lines[2].segments[0].styles, .strike)
    }

    func testCompactPreviewRepresentsBlockSyntaxWithoutRawMarkers() {
        let preview = WhatsAppTextFormatter.attributedPreview(
            "- *Primero*\n> _Nota_",
            baseFont: .subheadline
        )

        XCTAssertEqual(String(preview.characters), "• Primero\n› Nota")
    }
}
