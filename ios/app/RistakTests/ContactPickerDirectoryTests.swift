import Foundation
import XCTest
@testable import Ristak

final class ContactPickerDirectoryTests: XCTestCase {
    private let contactsJSON = #"""
    [
      {"id":"accent","name":"Ángel Núñez","email":"angel@example.com","phone":"+52 656 123 4567","phones":[{"id":"alt","phone":"+52 656 999 0000","label":"Trabajo","isPrimary":false,"source":"test"}]},
      {"id":"email","name":"María López","email":"ventas@negocio.mx","phone":"+52 55 7654 3210"},
      {"id":"other","name":"Otro Contacto","email":"otro@example.com","phone":"+52 81 1111 2222"},
      {"id":"matched","name":"Match Phone","email":"match@example.com","phone":"+52 81 3333 4444","matchedPhone":"+52 656 777 8888"}
    ]
    """#

    private func contacts() throws -> [ChatContact] {
        try JSONDecoder().decode([ChatContact].self, from: Data(contactsJSON.utf8))
    }

    func testFilterMatchesNamesWithoutDependingOnAccentsOrCase() throws {
        let result = ContactPickerDirectory.filter(try contacts(), query: "ANGEL NUNEZ")
        XCTAssertEqual(result.map(\.id), ["accent"])
    }

    func testFilterMatchesEmailAndPhoneDigits() throws {
        XCTAssertEqual(
            ContactPickerDirectory.filter(try contacts(), query: "ventas@negocio").map(\.id),
            ["email"]
        )
        XCTAssertEqual(
            ContactPickerDirectory.filter(try contacts(), query: "6561234567").map(\.id),
            ["accent"]
        )
    }

    func testFilterMatchesSecondaryAndMatchedPhones() throws {
        XCTAssertEqual(
            ContactPickerDirectory.filter(try contacts(), query: "6569990000").map(\.id),
            ["accent"]
        )
        XCTAssertEqual(
            ContactPickerDirectory.filter(try contacts(), query: "6567778888").map(\.id),
            ["matched"]
        )
    }

    func testTextWithoutDigitsDoesNotMatchEveryPhone() throws {
        XCTAssertTrue(ContactPickerDirectory.filter(try contacts(), query: "sin coincidencia").isEmpty)
    }
}
