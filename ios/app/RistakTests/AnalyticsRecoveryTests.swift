import XCTest
@testable import Ristak

@MainActor
final class AnalyticsRecoveryTests: XCTestCase {
    private let storage = RistakSnapshotCache.shared

    private func configureAccount(
        currency: String = "USD",
        zone: String = "America/Denver",
        namespace: String = "analytics-tests.\(UUID().uuidString)"
    ) -> AppConfigStore {
        storage.configure(namespace: namespace)
        storage.store([RistakAppConfigKey.accountCurrency: currency], for: RistakCacheKey.appConfig)
        storage.store(zone, for: RistakCacheKey.timezone)
        let config = AppConfigStore()
        config.hydrateFromCache()
        return config
    }

    private func model(
        _ probe: AnalyticsMetricsProbe,
        delay: Duration = .milliseconds(10),
        grace: Duration = .milliseconds(350),
        now: @escaping () -> Date = Date.init,
        customize: (inout AnalyticsQueries) -> Void = { _ in }
    ) -> AnalyticsViewModel {
        var queries = AnalyticsQueries()
        queries.metrics = { _, _ in try await probe.metrics() }
        queries.financialOverview = { _, _, _ in await probe.chart(); return [] }
        queries.series = { _, _, _, _ in [] }
        queries.funnel = { _, _, _, _ in [] }
        queries.originDistribution = { _, _, _ in try JSONDecoder().decode(OriginDistributionSnapshot.self, from: Data("{}".utf8)) }
        queries.originPhoneBreakdown = { _, _ in try JSONDecoder().decode(OriginDistributionSnapshot.self, from: Data("{}".utf8)) }
        queries.customLabels = { .defaults }
        queries.phones = { try JSONDecoder().decode(WhatsAppAPIStatus.self, from: Data("{}".utf8)) }
        customize(&queries)
        return AnalyticsViewModel(queries: queries, recovery: AnalyticsRecovery(delays: [delay]), snapshotGrace: grace, now: now)
    }

    private func waitUntil(_ condition: @MainActor () async -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !(await condition()) {
            guard ContinuousClock.now < deadline else { throw ProbeError.timeout }
            try await Task.sleep(for: .milliseconds(2))
        }
    }

    func testCachedPanelsSurviveTransientFailureAndOnlyFailedPanelRetries() async throws {
        let config = configureAccount()
        defer { storage.reset() }
        let probe = AnalyticsMetricsProbe([.value(14), .offline, .paused])
        let model = model(probe)
        defer { model.stop() }

        await model.start(config: config, includeWeb: true)
        model.stop()
        await model.start(config: config, includeWeb: true)

        XCTAssertEqual(model.metrics.value?.ingresosNetos?.value, 14)
        XCTAssertFalse(model.metrics.isLoading)
        XCTAssertNil(model.metrics.errorMessage)
        try await waitUntil { await probe.isPaused }
        await probe.resume(22)
        try await waitUntil { model.metrics.value?.ingresosNetos?.value == 22 }
        let chartCount = await probe.chartCount
        XCTAssertEqual(chartCount, 2)
    }

    func testFirstUseWaitsWithoutFalseZeroAndRecoversWithoutReopening() async throws {
        let config = configureAccount()
        defer { storage.reset() }
        let probe = AnalyticsMetricsProbe([.offline, .paused])
        let model = model(probe)
        defer { model.stop() }

        await model.start(config: config, includeWeb: false)
        XCTAssertNil(model.metrics.value)
        XCTAssertTrue(model.metrics.isLoading)
        XCTAssertNil(model.metrics.errorMessage)
        XCTAssertFalse(model.originTabs.contains(.traffic))
        XCTAssertFalse(model.chartKinds.contains(.visitorsLeads))
        try await waitUntil { await probe.isPaused }
        await probe.resume(0)
        try await waitUntil { model.metrics.value?.ingresosNetos?.value == 0 }
        XCTAssertFalse(model.metrics.isLoading)
    }

    func testFastResponseWinsBeforeCachedPreviewAndSlowResponseReplacesPreview() async throws {
        let config = configureAccount()
        defer { storage.reset() }
        let seed = model(AnalyticsMetricsProbe([.value(11)]))
        await seed.start(config: config, includeWeb: true)
        seed.stop()

        let fastProbe = AnalyticsMetricsProbe([.paused])
        let fast = model(fastProbe, grace: .seconds(5))
        let fastLoad = Task { await fast.start(config: config, includeWeb: true) }
        try await waitUntil { await fastProbe.isPaused }
        XCTAssertNil(fast.metrics.value)
        await fastProbe.resume(0)
        await fastLoad.value
        XCTAssertEqual(fast.metrics.value?.ingresosNetos?.value, 0)
        fast.stop()

        let slowProbe = AnalyticsMetricsProbe([.paused])
        let slow = model(slowProbe, grace: .milliseconds(20))
        defer { slow.stop() }
        let slowLoad = Task { await slow.start(config: config, includeWeb: true) }
        try await waitUntil { slow.metrics.value?.ingresosNetos?.value == 0 }
        await slowProbe.resume(17)
        await slowLoad.value
        XCTAssertEqual(slow.metrics.value?.ingresosNetos?.value, 17)
    }

    func testKnownOfflineImmediatelyShowsMatchedSnapshotWithoutWaitingForTimeout() async throws {
        let config = configureAccount()
        defer { storage.reset() }
        let seed = model(AnalyticsMetricsProbe([.value(19)]))
        await seed.start(config: config, includeWeb: false)
        seed.stop()

        let probe = AnalyticsMetricsProbe([.paused])
        let offline = model(probe, grace: .seconds(60))
        defer { offline.stop() }
        offline.setNetworkAvailable(false)
        let load = Task { await offline.start(config: config, includeWeb: false) }
        try await waitUntil { await probe.isPaused }
        XCTAssertEqual(offline.metrics.value?.ingresosNetos?.value, 19)
        await probe.resume(21)
        await load.value
        XCTAssertEqual(offline.metrics.value?.ingresosNetos?.value, 21)
    }

    func testNextBusinessDayOfflineShowsLastWindowWithDatesUntilLiveZeroArrives() async throws {
        let tenant = "analytics-tests.\(UUID().uuidString)"
        let config = configureAccount(zone: "America/Mexico_City", namespace: tenant)
        defer { storage.reset() }
        // La primera apertura ya es 20 de noviembre en UTC y aún 19 en el negocio.
        let before = try XCTUnwrap(RistakDateParsing.date(fromISO: "2026-11-20T05:50:00Z"))
        let after = try XCTUnwrap(RistakDateParsing.date(fromISO: "2026-11-20T06:10:00Z"))
        let seed = model(AnalyticsMetricsProbe([.value(19)]), now: { before })
        await seed.start(config: config, includeWeb: false)
        seed.stop()
        await storage.flushPendingWrites()
        storage.configure(namespace: nil)
        storage.configure(namespace: tenant)
        await storage.preloadIntoMemory()
        let restoredConfig = AppConfigStore()
        restoredConfig.hydrateFromCache()

        let probe = AnalyticsMetricsProbe([.offline, .paused])
        let reopened = model(probe, now: { after })
        defer { reopened.stop() }
        await reopened.start(config: restoredConfig, includeWeb: false)
        XCTAssertEqual(reopened.range?.endDate, "2026-11-20")
        XCTAssertEqual(reopened.metrics.value?.ingresosNetos?.value, 19)
        XCTAssertEqual(reopened.metrics.previousRange?.savedReportLabel, "Informe guardado del 21 oct 2026 al 19 nov 2026")
        XCTAssertNil(reopened.chart.previousRange)
        try await waitUntil { await probe.isPaused }
        await probe.resume(0)
        try await waitUntil { reopened.metrics.value?.ingresosNetos?.value == 0 }
        XCTAssertNil(reopened.metrics.previousRange)
    }

    func testCurrentOriginNeverMixesInNumbersFromPreviousWindow() async throws {
        let config = configureAccount()
        defer { storage.reset() }
        let cache = try XCTUnwrap(AnalyticsCache(config: config, includeWeb: true))
        let earlier = try XCTUnwrap(AnalyticsDateRange.businessNoon("2026-11-19", timeZone: config.businessTimeZone))
        let today = try XCTUnwrap(AnalyticsDateRange.businessNoon("2026-11-20", timeZone: config.businessTimeZone))
        let savedRange = try XCTUnwrap(AnalyticsService.dateRange(for: .d30, timeZone: config.businessTimeZone, now: earlier))
        let old = try JSONDecoder().decode(OriginDistributionSnapshot.self, from: Data("""
        {"whatsappNumbers":[{"name":"Ventas","value":77},{"name":"Recepción","value":40}]}
        """.utf8))
        cache.storeOrigin(old, savedRange)

        let originGate = AnalyticsMetricsProbe([.paused])
        let model = model(AnalyticsMetricsProbe([.value(0)]), now: { today }) { queries in
            queries.originDistribution = { _, _, _ in
                _ = try await originGate.metrics()
                return try JSONDecoder().decode(OriginDistributionSnapshot.self, from: Data("{}".utf8))
            }
        }
        defer { model.stop() }
        model.setNetworkAvailable(false)
        let load = Task { await model.start(config: config, includeWeb: true) }
        try await waitUntil { await originGate.isPaused }
        XCTAssertEqual(model.origin.previousRange, savedRange)
        XCTAssertTrue(model.showsWhatsAppPanel)
        await originGate.resume(0)
        await load.value
        XCTAssertNil(model.origin.previousRange)
        XCTAssertEqual(model.origin.value?.whatsappNumbers.count, 0)
        XCTAssertFalse(model.showsWhatsAppPanel)
        let current = try XCTUnwrap(model.range)
        let exact = cache.query(.origin, range: current, period: .custom)
        XCTAssertEqual(exact.snapshot(OriginDistributionSnapshot.self)?.value.whatsappNumbers.count, 0)
    }

    func testRelativeLookupChoosesLatestMatchingWindowAndCustomStaysExact() throws {
        let config = configureAccount()
        defer { storage.reset() }
        let cache = try XCTUnwrap(AnalyticsCache(config: config, includeWeb: true))
        let zone = config.businessTimeZone
        let today = try XCTUnwrap(AnalyticsDateRange.businessNoon("2026-11-03", timeZone: zone))
        let requested = try XCTUnwrap(AnalyticsService.dateRange(for: .d30, timeZone: zone, now: today))
        func store(_ period: AnalyticsPeriod, _ end: String, _ scope: DashboardScope, _ value: Double) throws {
            let day = try XCTUnwrap(AnalyticsDateRange.businessNoon(end, timeZone: zone))
            let range = try XCTUnwrap(AnalyticsService.dateRange(for: period, timeZone: zone, now: day))
            cache.storeChart([AnalyticsChartPoint(label: end, value1: value, value2: 0)], range, .revenueSpend, scope)
        }
        try store(.d30, "2026-11-01", .all, 1)
        try store(.d30, "2026-11-02", .all, 2)
        try store(.d60, "2026-11-03", .all, 60)
        try store(.d30, "2026-11-03", .campaigns, 40)
        try store(.d30, "2026-11-04", .all, 100)
        let panel = AnalyticsCache.Panel.chart(.revenueSpend, .all)
        let query = cache.query(panel, range: requested, period: .d30)
        let previous = try XCTUnwrap(query.snapshot([AnalyticsChartPoint].self))
        XCTAssertEqual(previous.value.first?.value1, 2)
        XCTAssertEqual(previous.previousRange?.endDate, "2026-11-02")
        XCTAssertNil(cache.query(panel, range: requested, period: .custom).snapshot([AnalyticsChartPoint].self))
        let withoutWeb = try XCTUnwrap(AnalyticsCache(config: config, includeWeb: false))
        XCTAssertNil(withoutWeb.query(panel, range: requested, period: .d30).snapshot([AnalyticsChartPoint].self))
        storage.configure(namespace: "another-tenant.\(UUID().uuidString)")
        XCTAssertNil(query.snapshot([AnalyticsChartPoint].self))
    }

    func testLateSameRangeResponseCannotReplaceNewerReconnection() async throws {
        let config = configureAccount()
        defer { storage.reset() }
        let probe = AnalyticsMetricsProbe([.paused, .value(42)])
        let model = model(probe)
        defer { model.stop() }
        let slow = Task { await model.start(config: config, includeWeb: true) }
        try await waitUntil { await probe.isPaused }

        await model.start(config: config, includeWeb: true)
        await probe.resume(3)
        await slow.value
        XCTAssertEqual(model.metrics.value?.ingresosNetos?.value, 42)
        let range = try XCTUnwrap(model.range)
        let snapshot = try XCTUnwrap(AnalyticsCache(config: config, includeWeb: true))
        XCTAssertEqual(storage.value(DashboardMetricsSnapshot.self, for: snapshot.metricsKey(range))?.ingresosNetos?.value, 42)
    }

    func testCacheHonorsWebAccessCurrencyTimezoneAndServerDenial() async throws {
        let config = configureAccount()
        defer { storage.reset() }
        let probe = AnalyticsMetricsProbe([.value(10), .forbidden, .offline, .value(21)])
        let model = model(probe)
        defer { model.stop() }
        await model.start(config: config, includeWeb: true)
        let range = try XCTUnwrap(model.range)
        let restricted = try XCTUnwrap(AnalyticsCache(config: config, includeWeb: false))
        XCTAssertNil(storage.value(DashboardMetricsSnapshot.self, for: restricted.metricsKey(range)))

        storage.store(["account_currency": "EUR"], for: RistakCacheKey.appConfig)
        let euroConfig = AppConfigStore()
        euroConfig.hydrateFromCache()
        let euro = try XCTUnwrap(AnalyticsCache(config: euroConfig, includeWeb: true))
        XCTAssertNil(storage.value(DashboardMetricsSnapshot.self, for: euro.metricsKey(range)))

        storage.store("Europe/Paris", for: RistakCacheKey.timezone)
        let parisConfig = AppConfigStore()
        parisConfig.hydrateFromCache()
        let paris = try XCTUnwrap(AnalyticsCache(config: parisConfig, includeWeb: true))
        XCTAssertNotEqual(euro.metricsKey(range), paris.metricsKey(range))

        await model.start(config: parisConfig, includeWeb: true)
        XCTAssertTrue(model.accessDenied)
        model.stop()
        await model.start(config: parisConfig, includeWeb: true)
        XCTAssertTrue(model.accessDenied)
        await model.start(config: parisConfig, includeWeb: true)
        XCTAssertFalse(model.accessDenied)
        XCTAssertEqual(model.metrics.value?.ingresosNetos?.value, 21)
    }

    func testAccessUsesDashboardPermissionAndWebTrafficUsesItsOwnPlanFeature() {
        let dashboard = RistakUser(id: "1", accessConfig: ["dashboard": .read],
                                   licenseEnforced: true, licensePlan: "Ristak Pro",
                                   licenseFeatures: ["dashboard": true, "web_analytics": true])
        let webOnly = RistakUser(id: "2", accessConfig: ["analytics": .read])
        let basic = RistakUser(id: "3", accessConfig: ["dashboard": .read],
                               licenseEnforced: true, licensePlan: "Basic",
                               licenseFeatures: ["dashboard": true, "web_analytics": true])
        XCTAssertTrue(RistakAccessRules.hasPhoneSectionAccess(user: dashboard, section: .analytics))
        XCTAssertFalse(RistakAccessRules.hasPhoneSectionAccess(user: webOnly, section: .analytics))
        XCTAssertTrue(RistakAccessRules.canReadWebAnalytics(dashboard))
        XCTAssertFalse(RistakAccessRules.canReadWebAnalytics(basic))
    }

    func testLeavingCancelsPendingRetriesAndNewAccountIgnoresOldResults() async throws {
        let config = configureAccount()
        let probe = AnalyticsMetricsProbe([.offline, .paused, .value(28)])
        let model = model(probe, delay: .milliseconds(30))
        defer { model.stop(); storage.reset() }
        await model.start(config: config, includeWeb: true)
        model.stop()
        try await Task.sleep(for: .milliseconds(90))
        let callsWhileHidden = await probe.metricsCount
        XCTAssertEqual(callsWhileHidden, 1)

        let slow = Task { await model.start(config: config, includeWeb: true) }
        try await waitUntil { await probe.isPaused }
        storage.reset()
        let other = configureAccount()
        await model.start(config: other, includeWeb: true)
        await probe.resume(800)
        await slow.value
        let range = try XCTUnwrap(model.range)
        let cache = try XCTUnwrap(AnalyticsCache(config: other, includeWeb: true))
        XCTAssertEqual(storage.value(DashboardMetricsSnapshot.self, for: cache.metricsKey(range))?.ingresosNetos?.value, 28)
    }
}

private enum ProbeError: Error { case timeout, unexpectedCall }

private actor AnalyticsMetricsProbe {
    enum Reply { case value(Int), offline, forbidden, paused }
    private var replies: [Reply]
    private var continuation: CheckedContinuation<Int, Never>?
    private(set) var metricsCount = 0
    private(set) var chartCount = 0

    init(_ replies: [Reply]) { self.replies = replies }
    var isPaused: Bool { continuation != nil }
    func chart() { chartCount += 1 }

    func resume(_ value: Int) {
        continuation?.resume(returning: value)
        continuation = nil
    }

    func metrics() async throws -> DashboardMetricsSnapshot {
        metricsCount += 1
        guard !replies.isEmpty else { throw ProbeError.unexpectedCall }
        let amount: Int
        switch replies.removeFirst() {
        case .value(let value): amount = value
        case .offline: throw RistakAPIError.network(URLError(.notConnectedToInternet))
        case .forbidden: throw RistakAPIError(kind: .accessDenied, status: 403, message: "Sin acceso")
        case .paused: amount = await withCheckedContinuation { continuation = $0 }
        }
        let payload = Data("{\"ingresosNetos\":{\"value\":\(amount),\"variation\":0}}".utf8)
        return try JSONDecoder().decode(DashboardMetricsSnapshot.self, from: payload)
    }
}
