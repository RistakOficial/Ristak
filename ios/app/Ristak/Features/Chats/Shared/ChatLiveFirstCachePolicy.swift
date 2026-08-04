import Foundation

enum ChatLiveFirstCachePolicy {
    static let fallbackGrace: Duration = .milliseconds(350)

    static func shouldReveal(
        hasCachedData: Bool,
        freshResolved: Bool,
        requestIsCurrent: Bool,
        isCancelled: Bool
    ) -> Bool {
        hasCachedData && !freshResolved && requestIsCurrent && !isCancelled
    }
}
