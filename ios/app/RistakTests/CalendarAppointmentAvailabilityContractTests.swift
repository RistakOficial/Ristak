import XCTest
@testable import Ristak

@MainActor
final class CalendarAppointmentAvailabilityContractTests: XCTestCase {
    func testCreateModesKeepStrictAndCustomOverlapContractsMutuallyExclusive() {
        let viewModel = makeCreateViewModel()

        XCTAssertEqual(viewModel.entryMode, .defaultSlots)
        XCTAssertTrue(viewModel.requiresStrictAvailabilityCheck)
        XCTAssertFalse(viewModel.appointmentConflictOverrideRequested())
        XCTAssertFalse(viewModel.appointmentConflictOverrideRequested(manualRetry: true))
        XCTAssertFalse(viewModel.offersManualAppointmentConflictRetry)

        viewModel.entryMode = .custom
        XCTAssertFalse(viewModel.requiresStrictAvailabilityCheck)
        XCTAssertTrue(viewModel.appointmentConflictOverrideRequested())
        XCTAssertTrue(viewModel.appointmentConflictOverrideRequested(manualRetry: true))
        XCTAssertFalse(viewModel.offersManualAppointmentConflictRetry)
    }

    func testOnlyEditKeepsTheLegacyManualConflictRetry() throws {
        let appointment = try JSONDecoder().decode(
            CalendarAppointment.self,
            from: Data(#"""
            {
                "id": "appointment-1",
                "startTime": "2026-07-14T16:00:00.000Z",
                "endTime": "2026-07-14T17:00:00.000Z"
            }
            """#.utf8)
        )
        let viewModel = AppointmentFormViewModel(
            edit: appointment,
            calendars: [],
            timeZone: TimeZone(secondsFromGMT: 0)!
        )

        XCTAssertTrue(viewModel.isEdit)
        XCTAssertTrue(viewModel.offersManualAppointmentConflictRetry)
        XCTAssertFalse(viewModel.appointmentConflictOverrideRequested())
        XCTAssertTrue(viewModel.appointmentConflictOverrideRequested(manualRetry: true))
    }

    func testAvailabilityFieldsEncodeStrictAndCustomOverlapSeparately() throws {
        let strictJSON = try jsonObject(for: AppointmentDraftRequest(strictAvailabilityCheck: true))
        XCTAssertEqual(strictJSON["strictAvailabilityCheck"] as? Bool, true)
        XCTAssertNil(strictJSON["ignoreAppointmentConflicts"])

        let customJSON = try jsonObject(for: AppointmentDraftRequest(ignoreAppointmentConflicts: true))
        XCTAssertNil(customJSON["strictAvailabilityCheck"])
        XCTAssertEqual(customJSON["ignoreAppointmentConflicts"] as? Bool, true)
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
