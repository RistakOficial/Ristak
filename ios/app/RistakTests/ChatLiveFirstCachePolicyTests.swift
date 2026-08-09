import XCTest
@testable import Ristak

final class ChatLiveFirstCachePolicyTests: XCTestCase {
    func testInboxBootstrapIdentityChangesWhenAccountOrAccessBecomesReady() {
        let unresolved = ChatBootstrapIdentity(namespace: nil, canReadChat: false)
        let accountReady = ChatBootstrapIdentity(
            namespace: "tenant.example|user-1",
            canReadChat: false
        )
        let accessReady = ChatBootstrapIdentity(
            namespace: "tenant.example|user-1",
            canReadChat: true
        )

        XCTAssertNotEqual(unresolved, accountReady)
        XCTAssertNotEqual(accountReady, accessReady)
    }

    @MainActor
    func testInboxPublishesItsCachedRowsDuringNamespaceSetup() throws {
        let cache = RistakSnapshotCache.shared
        cache.reset()
        defer { cache.reset() }

        cache.configure(namespace: "tenant-immediate.user-immediate")
        let namespace = try XCTUnwrap(cache.namespaceToken())
        let cachedRows = try JSONDecoder().decode([ChatContact].self, from: Data("""
        [{"id":"cached-contact","name":"Conversación guardada","messageCount":1}]
        """.utf8))
        XCTAssertTrue(ChatInboxDiskCache.save(cachedRows, ifCurrent: namespace))

        let viewModel = InboxViewModel()
        viewModel.updateNamespace("tenant-immediate|user-immediate")

        XCTAssertEqual(viewModel.rows.map(\.id), ["cached-contact"])
        XCTAssertTrue(viewModel.isShowingCachedData)
    }

    func testCacheWaitsBehindShortGraceAndOnlyRevealsWithoutFreshResponse() {
        XCTAssertEqual(ChatLiveFirstCachePolicy.fallbackGrace, .milliseconds(350))
        XCTAssertTrue(ChatLiveFirstCachePolicy.shouldReveal(
            hasCachedData: true,
            freshResolved: false,
            requestIsCurrent: true,
            isCancelled: false
        ))
        XCTAssertFalse(ChatLiveFirstCachePolicy.shouldReveal(
            hasCachedData: true,
            freshResolved: true,
            requestIsCurrent: true,
            isCancelled: false
        ))
    }

    func testStaleOrCancelledRequestCannotRevealCache() {
        XCTAssertFalse(ChatLiveFirstCachePolicy.shouldReveal(
            hasCachedData: true,
            freshResolved: false,
            requestIsCurrent: false,
            isCancelled: false
        ))
        XCTAssertFalse(ChatLiveFirstCachePolicy.shouldReveal(
            hasCachedData: true,
            freshResolved: false,
            requestIsCurrent: true,
            isCancelled: true
        ))
    }
}
