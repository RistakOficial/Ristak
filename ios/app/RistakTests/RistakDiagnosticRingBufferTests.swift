import Foundation
import XCTest
@testable import Ristak

final class RistakDiagnosticRingBufferTests: XCTestCase {
    func testRingBufferPersistsOnlyNewestBoundedRecords() async throws {
        let fixture = try makeFixtureURL()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let buffer = RistakDiagnosticRingBuffer(
            fileURL: fixture.file,
            maximumEntries: 3,
            maximumBytes: 16 * 1_024
        )
        for index in 0..<5 {
            await buffer.append(.performance(
                operation: .chatInboxLoad,
                outcome: .success,
                durationMilliseconds: index,
                itemCount: index,
                timestamp: Date(timeIntervalSince1970: TimeInterval(index))
            ))
        }

        let snapshot = await buffer.snapshot()
        XCTAssertEqual(snapshot.count, 3)
        XCTAssertEqual(snapshot.map(\.itemCount), [2, 3, 4])

        let reloaded = RistakDiagnosticRingBuffer(
            fileURL: fixture.file,
            maximumEntries: 3,
            maximumBytes: 16 * 1_024
        )
        let reloadedSnapshot = await reloaded.snapshot()
        XCTAssertEqual(reloadedSnapshot, snapshot)
    }

    func testRingBufferEnforcesByteLimitAndCannotStoreFreeText() async throws {
        let fixture = try makeFixtureURL()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let buffer = RistakDiagnosticRingBuffer(
            fileURL: fixture.file,
            maximumEntries: 1_000,
            maximumBytes: 1_024
        )
        for index in 0..<100 {
            await buffer.append(.metricDiagnostic(
                payloadCount: index,
                crashCount: index,
                hangCount: index,
                cpuExceptionCount: index,
                diskWriteExceptionCount: index,
                timestamp: Date(timeIntervalSince1970: TimeInterval(index))
            ))
        }

        let data = try Data(contentsOf: fixture.file)
        let persistedText = String(decoding: data, as: UTF8.self)
        XCTAssertLessThanOrEqual(data.count, 1_024)
        XCTAssertFalse(persistedText.contains("contenido privado de mensaje"))
        XCTAssertFalse(persistedText.contains("token-secreto"))
        let snapshot = await buffer.snapshot()
        XCTAssertFalse(snapshot.isEmpty)
    }

    func testPushDiagnosticsPersistOnlyClosedMilestones() async throws {
        let fixture = try makeFixtureURL()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let buffer = RistakDiagnosticRingBuffer(fileURL: fixture.file)
        await buffer.append(.push(.apnsTokenReceived))
        await buffer.append(.push(.backendRegistered))

        let snapshot = await buffer.snapshot()
        XCTAssertEqual(snapshot.map(\.pushMilestone), [
            .apnsTokenReceived,
            .backendRegistered,
        ])
        let persisted = String(decoding: try Data(contentsOf: fixture.file), as: UTF8.self)
        XCTAssertFalse(persisted.contains("device-token"))
        XCTAssertFalse(persisted.contains("contactId"))
    }

    private func makeFixtureURL() throws -> (directory: URL, file: URL) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("RistakDiagnosticTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return (directory, directory.appendingPathComponent("diagnostics.json"))
    }
}
