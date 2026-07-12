import XCTest
@testable import Ristak

final class AnalyticsChartScaleTests: XCTestCase {
    func testUpperBoundKeepsMaximumValueAtEightyPercentOfPlot() {
        let points = [
            AnalyticsChartPoint(label: "2026-07-01", value1: 40, value2: 80),
            AnalyticsChartPoint(label: "2026-07-02", value1: 20, value2: 60),
        ]

        let upperBound = AnalyticsChartScale.upperBound(for: points)

        XCTAssertEqual(upperBound, 100, accuracy: 0.0001)
        XCTAssertEqual(80 / upperBound, 0.8, accuracy: 0.0001)
    }

    func testUpperBoundHasSafeMinimumForTinyValues() {
        let points = [AnalyticsChartPoint(label: "2026-07-01", value1: 0.2, value2: 0.5)]

        XCTAssertEqual(AnalyticsChartScale.upperBound(for: points), 1.25, accuracy: 0.0001)
    }
}
