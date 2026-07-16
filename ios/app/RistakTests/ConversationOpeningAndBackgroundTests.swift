import XCTest
@testable import Ristak

final class ConversationOpeningAndBackgroundTests: XCTestCase {
    func testHistoricalPaginationStaysClosedUntilBottomIsEstablished() throws {
        var state = ConversationOpeningScrollState()
        XCTAssertFalse(state.canLoadOlderMessages)

        let generation = try XCTUnwrap(state.contentDidChange(hasContent: true))
        XCTAssertTrue(state.isAnchoring)
        XCTAssertFalse(state.canLoadOlderMessages)

        state.didEstablishBottom(generation: generation)
        XCTAssertTrue(state.canLoadOlderMessages)
        XCTAssertFalse(state.isAnchoring)
    }

    func testNewLayoutInvalidatesAnOlderOpeningAnchor() throws {
        var state = ConversationOpeningScrollState()
        let first = try XCTUnwrap(state.contentDidChange(hasContent: true))
        let second = try XCTUnwrap(state.contentDidChange(hasContent: true))

        XCTAssertFalse(state.shouldContinueAnchoring(generation: first))
        XCTAssertTrue(state.shouldContinueAnchoring(generation: second))
        state.didEstablishBottom(generation: first)
        XCTAssertFalse(state.canLoadOlderMessages)
        state.didEstablishBottom(generation: second)
        XCTAssertTrue(state.canLoadOlderMessages)
    }

    func testLayoutCanReanchorAfterFirstBottomUntilOpeningSettles() throws {
        var state = ConversationOpeningScrollState()
        let first = try XCTUnwrap(state.contentDidChange(hasContent: true))
        state.didEstablishBottom(generation: first)

        XCTAssertTrue(state.canLoadOlderMessages)
        XCTAssertTrue(state.tracksOpeningLayout)

        let relayout = try XCTUnwrap(state.contentDidChange(hasContent: true))
        XCTAssertTrue(state.shouldContinueAnchoring(generation: relayout))
        state.didEstablishBottom(generation: relayout)
        state.didFinishOpeningTracking(generation: relayout)

        XCTAssertFalse(state.tracksOpeningLayout)
        XCTAssertNil(state.contentDidChange(hasContent: true))
    }

    func testUserScrollCancelsPendingOpeningReanchors() throws {
        var state = ConversationOpeningScrollState()
        let generation = try XCTUnwrap(state.contentDidChange(hasContent: true))

        state.userDidBeginScrolling()

        XCTAssertFalse(state.shouldContinueAnchoring(generation: generation))
        XCTAssertTrue(state.canLoadOlderMessages)
    }

    func testTransientEmptyResponseRetriesAndPreservesExistingHistory() {
        XCTAssertTrue(ConversationInitialEmptyResponsePolicy.shouldRetry(
            freshMessageCount: 0,
            existingMessageCount: 20,
            seedMessageCount: 20,
            seedHasLastMessageDate: true
        ))
        XCTAssertTrue(ConversationInitialEmptyResponsePolicy.shouldPreserveExisting(
            freshMessageCount: 0,
            existingMessageCount: 20
        ))
        XCTAssertFalse(ConversationInitialEmptyResponsePolicy.shouldRetry(
            freshMessageCount: 0,
            existingMessageCount: 0,
            seedMessageCount: 0,
            seedHasLastMessageDate: false
        ))
        XCTAssertTrue(ConversationInitialEmptyResponsePolicy.shouldFailAsTemporarilyUnavailable(
            finalFreshMessageCount: 0,
            existingMessageCount: 0,
            seedMessageCount: 3,
            seedHasLastMessageDate: true
        ))
        XCTAssertFalse(ConversationInitialEmptyResponsePolicy.shouldFailAsTemporarilyUnavailable(
            finalFreshMessageCount: 0,
            existingMessageCount: 0,
            seedMessageCount: 0,
            seedHasLastMessageDate: false
        ))
    }

    func testBackgroundPushAcceptsOnlyChatWithContact() {
        XCTAssertEqual(
            ChatBackgroundNotificationPolicy.contactID(in: [
                "category": "chat",
                "contactId": " contact-123 ",
            ]),
            "contact-123"
        )
        XCTAssertNil(ChatBackgroundNotificationPolicy.contactID(in: [
            "category": "payment",
            "contactId": "contact-123",
        ]))
        XCTAssertNil(ChatBackgroundNotificationPolicy.contactID(in: [
            "category": "chat",
        ]))
    }

    func testPrewarmPolicyPrioritizesPushContactAndDeduplicates() throws {
        let contacts = try JSONDecoder().decode([ChatContact].self, from: Data("""
        [
          {"id":"one","messageCount":2},
          {"id":"preferred","messageCount":3},
          {"id":"two","messageCount":1}
        ]
        """.utf8))

        XCTAssertEqual(
            ChatThreadPrewarmPolicy.candidateContactIDs(
                from: contacts,
                preferredContactID: "preferred",
                limit: 3
            ),
            ["preferred", "one", "two"]
        )
    }

    func testPrewarmFreshnessRejectsFutureOrExpiredTimestamps() {
        let now = Date(timeIntervalSince1970: 10_000)
        XCTAssertTrue(ChatThreadPrewarmPolicy.isFresh(
            updatedAt: now.addingTimeInterval(-30),
            now: now,
            maxAge: 60
        ))
        XCTAssertFalse(ChatThreadPrewarmPolicy.isFresh(
            updatedAt: now.addingTimeInterval(-61),
            now: now,
            maxAge: 60
        ))
        XCTAssertFalse(ChatThreadPrewarmPolicy.isFresh(
            updatedAt: now.addingTimeInterval(1),
            now: now,
            maxAge: 60
        ))
    }

    @MainActor
    func testBackgroundSnapshotsRejectAResponseFromThePreviousSession() async throws {
        let cache = RistakSnapshotCache.shared
        cache.reset()
        defer { cache.reset() }

        cache.configure(namespace: "tenant-a.user-a")
        let staleNamespace = try XCTUnwrap(cache.namespaceToken())
        let stalePermit = try XCTUnwrap(ChatThreadSnapshotCache.beginWrite(
            contactID: "contact-a",
            ifCurrent: staleNamespace
        ))

        // Simula logout/cambio de cuenta mientras el GET todavía iba en vuelo.
        cache.configure(namespace: "tenant-b.user-b")
        let message = ChatMessage(
            id: "message-a",
            contactId: "contact-a",
            date: "2026-07-16T12:00:00.000Z",
            direction: .inbound,
            text: "No debe caer en B",
            channel: "whatsapp"
        )
        let threadStored = await ChatThreadSnapshotCache.savePrepared(
            [message],
            contactID: "contact-a",
            flushToDisk: false,
            using: stalePermit
        )
        XCTAssertFalse(threadStored)
        XCTAssertFalse(cache.contains(ChatSnapshotKey.thread("contact-a")))

        let rows = try JSONDecoder().decode([ChatContact].self, from: Data("""
        [{"id":"contact-a","name":"Cuenta A","messageCount":1}]
        """.utf8))
        let inboxStored = ChatInboxDiskCache.save(rows, ifCurrent: staleNamespace)
        XCTAssertFalse(inboxStored)
        XCTAssertFalse(cache.contains(ChatSnapshotKey.inbox))
    }


    @MainActor
    func testNewerThreadCommitRejectsOlderResponseThatFinishesLate() async throws {
        let cache = RistakSnapshotCache.shared
        cache.reset()
        defer { cache.reset() }

        cache.configure(namespace: "tenant-order.user-order")
        let namespace = try XCTUnwrap(cache.namespaceToken())
        let olderPermit = try XCTUnwrap(ChatThreadSnapshotCache.beginWrite(
            contactID: "contact-order",
            ifCurrent: namespace
        ))
        let newerPermit = try XCTUnwrap(ChatThreadSnapshotCache.beginWrite(
            contactID: "contact-order",
            ifCurrent: namespace
        ))
        let older = ChatMessage(
            id: "older",
            contactId: "contact-order",
            date: "2026-07-16T12:00:00.000Z",
            direction: .inbound,
            text: "Respuesta vieja",
            channel: "whatsapp"
        )
        let newer = ChatMessage(
            id: "newer",
            contactId: "contact-order",
            date: "2026-07-16T12:01:00.000Z",
            direction: .inbound,
            text: "Respuesta nueva",
            channel: "whatsapp"
        )

        let newerStored = await ChatThreadSnapshotCache.savePrepared(
            [newer],
            contactID: "contact-order",
            flushToDisk: false,
            using: newerPermit
        )
        let olderStored = await ChatThreadSnapshotCache.savePrepared(
            [older],
            contactID: "contact-order",
            flushToDisk: false,
            using: olderPermit
        )
        XCTAssertTrue(newerStored)
        XCTAssertFalse(olderStored)
        XCTAssertEqual(ChatThreadSnapshotCache.load(contactID: "contact-order"), [newer])
    }

    func testSharedRecentConversationRequestReleasesCancelledWaiterAndCancelsLastLease() async throws {
        let probe = ConversationFetchCancellationProbe()
        let loader = ChatRecentConversationLoader { _, _, _ in
            try await probe.run()
        }
        let service = JourneyService(client: APIClient(maxStartupRetries: 0))

        let first = Task {
            try await loader.load(contactID: "contact-single-flight", service: service)
        }
        await probe.waitUntilStarted()
        let second = Task {
            try await loader.load(contactID: "contact-single-flight", service: service)
        }

        for _ in 0..<200 {
            if await loader.waiterCountForTesting(
                contactID: "contact-single-flight",
                service: service
            ) == 2 { break }
            await Task.yield()
        }
        let initialWaiterCount = await loader.waiterCountForTesting(
            contactID: "contact-single-flight",
            service: service
        )
        let initialStartCount = await probe.startCount
        XCTAssertEqual(initialWaiterCount, 2)
        XCTAssertEqual(initialStartCount, 1)

        first.cancel()
        do {
            _ = try await first.value
            XCTFail("El waiter cancelado no debe esperar al request compartido")
        } catch is CancellationError {
            // Correcto: el segundo consumidor conserva el request vivo.
        }
        let remainingWaiterCount = await loader.waiterCountForTesting(
            contactID: "contact-single-flight",
            service: service
        )
        let cancellationCountWithSecondWaiter = await probe.cancellationCount
        XCTAssertEqual(remainingWaiterCount, 1)
        XCTAssertEqual(cancellationCountWithSecondWaiter, 0)

        second.cancel()
        do {
            _ = try await second.value
            XCTFail("El último waiter cancelado debe terminar")
        } catch is CancellationError {
            // Correcto.
        }
        for _ in 0..<200 {
            if await probe.cancellationCount > 0 { break }
            await Task.yield()
        }
        let finalCancellationCount = await probe.cancellationCount
        XCTAssertEqual(finalCancellationCount, 1)
    }

    @MainActor
    func testBackgroundCompletionGateCompletesExactlyOnceOnExpirationRace() {
        let gate = ChatBackgroundTaskCompletionGate()
        var completions: [Bool] = []

        XCTAssertTrue(gate.finish(success: false) { completions.append($0) })
        XCTAssertFalse(gate.finish(success: true) { completions.append($0) })
        XCTAssertEqual(completions, [false])
        XCTAssertTrue(gate.isCompleted)
    }
}

private actor ConversationFetchCancellationProbe {
    private(set) var startCount = 0
    private(set) var cancellationCount = 0
    private var startWaiters: [CheckedContinuation<Void, Never>] = []

    func waitUntilStarted() async {
        guard startCount == 0 else { return }
        await withCheckedContinuation { continuation in
            startWaiters.append(continuation)
        }
    }

    func run() async throws -> ChatRecentConversationPayload {
        startCount += 1
        let waiters = startWaiters
        startWaiters.removeAll()
        waiters.forEach { $0.resume() }
        do {
            try await Task.sleep(nanoseconds: 5_000_000_000)
            return ChatRecentConversationPayload(events: [], appBaseURL: nil)
        } catch {
            cancellationCount += 1
            throw error
        }
    }
}
