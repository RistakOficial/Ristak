import XCTest
@testable import Ristak

@MainActor
final class CalendarAppointmentOutboxTests: XCTestCase {
    override func setUp() {
        super.setUp()
        RistakSnapshotCache.shared.configure(
            namespace: "calendar-outbox-test-\(UUID().uuidString)"
        )
    }

    override func tearDown() {
        RistakSnapshotCache.shared.reset()
        super.tearDown()
    }

    func testOfflineAppointmentPersistsExactIdempotencyKeyAndMergesIntoRange() async {
        let requestID = "ios-appointment:test-1"
        let draft = AppointmentDraftRequest(
            calendarId: "calendar-1",
            contactId: "contact-1",
            title: "Cita offline",
            appointmentStatus: "confirmed",
            startTime: "2026-07-29T16:00:00.000Z",
            endTime: "2026-07-29T17:00:00.000Z",
            timeZone: "America/Ciudad_Juarez"
        )

        let local = await CalendarAppointmentOutbox.shared.enqueue(
            draft: draft,
            clientRequestId: requestID
        )

        XCTAssertEqual(local.id, "offline-appointment:\(requestID)")
        XCTAssertEqual(local.syncStatus, "local_pending")
        XCTAssertEqual(CalendarAppointmentOutbox.shared.entries.count, 1)
        XCTAssertEqual(
            CalendarAppointmentOutbox.shared.entries.first?.draft.clientRequestId,
            requestID
        )

        let interval = DateInterval(
            start: try XCTUnwrap(RistakDateParsing.date(fromISO: "2026-07-29T00:00:00.000Z")),
            end: try XCTUnwrap(RistakDateParsing.date(fromISO: "2026-07-30T00:00:00.000Z"))
        )
        let merged = CalendarAppointmentOutbox.shared.merge(
            canonical: [],
            calendarID: "calendar-1",
            interval: interval
        )
        XCTAssertEqual(merged.map(\.id), [local.id])
    }

    func testDiscardRemovesPendingAppointmentFromDurableQueue() async {
        let requestID = "ios-appointment:test-discard"
        let local = await CalendarAppointmentOutbox.shared.enqueue(
            draft: AppointmentDraftRequest(
                calendarId: "calendar-1",
                startTime: "2026-07-29T16:00:00.000Z",
                endTime: "2026-07-29T17:00:00.000Z",
                timeZone: "America/Ciudad_Juarez"
            ),
            clientRequestId: requestID
        )

        XCTAssertTrue(
            CalendarAppointmentOutbox.shared.discard(localEventID: local.id)
        )
        await RistakSnapshotCache.shared.flushPendingWrites()
        XCTAssertTrue(CalendarAppointmentOutbox.shared.entries.isEmpty)
    }
}
