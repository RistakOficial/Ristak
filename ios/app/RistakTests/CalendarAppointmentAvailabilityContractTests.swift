import XCTest
@testable import Ristak

@MainActor
final class CalendarAppointmentAvailabilityContractTests: XCTestCase {
    func testDefaultSlotCreateRequiresStrictAvailabilityCheck() {
        let viewModel = makeCreateViewModel()

        XCTAssertEqual(viewModel.entryMode, .defaultSlots)
        XCTAssertTrue(viewModel.requiresStrictAvailabilityCheck)

        viewModel.entryMode = .custom
        XCTAssertFalse(viewModel.requiresStrictAvailabilityCheck)
    }

    func testStrictAvailabilityFieldIsEncodedOnlyWhenRequested() throws {
        let strictJSON = try jsonObject(for: AppointmentDraftRequest(strictAvailabilityCheck: true))
        XCTAssertEqual(strictJSON["strictAvailabilityCheck"] as? Bool, true)

        let customJSON = try jsonObject(for: AppointmentDraftRequest())
        XCTAssertNil(customJSON["strictAvailabilityCheck"])
    }

    private func makeCreateViewModel() -> AppointmentFormViewModel {
        AppointmentFormViewModel(
            createIn: [],
            preferredCalendarID: nil,
            prefill: AppointmentPrefill(
                day: CalendarBusinessDay(year: 2026, month: 7, day: 14),
                startMinutes: nil,
                durationMinutes: nil
            ),
            contact: AppointmentContactSelection(
                id: "contact-1",
                name: "Prueba"
            ),
            timeZone: TimeZone(secondsFromGMT: 0)!
        )
    }

    private func jsonObject(for request: AppointmentDraftRequest) throws -> [String: Any] {
        let data = try JSONEncoder().encode(request)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
