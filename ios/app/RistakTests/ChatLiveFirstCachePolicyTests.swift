import XCTest
@testable import Ristak

final class ChatLiveFirstCachePolicyTests: XCTestCase {
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
