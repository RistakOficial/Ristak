import Foundation
import OSLog

/// Registro local deliberadamente incapaz de contener texto libre o IDs.
/// Solo persiste enums cerrados y números acotados para diagnóstico técnico.
struct RistakDiagnosticRecord: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        case lifecycle
        case performance
        case metricPayload
        case metricDiagnostic
    }

    enum LifecycleMilestone: String, Codable, Sendable {
        case bootstrapStarted
        case contentReady
    }

    let schemaVersion: Int
    /// Instante UTC en milisegundos Unix. No es una fecha de negocio.
    let timestampMilliseconds: Int64
    let kind: Kind
    let lifecycleMilestone: LifecycleMilestone?
    let operation: RistakPerformanceOperation?
    let outcome: RistakPerformanceOutcome?
    let durationMilliseconds: Int?
    let itemCount: Int?
    let payloadCount: Int?
    let crashCount: Int?
    let hangCount: Int?
    let cpuExceptionCount: Int?
    let diskWriteExceptionCount: Int?

    private init(
        timestamp: Date,
        kind: Kind,
        lifecycleMilestone: LifecycleMilestone? = nil,
        operation: RistakPerformanceOperation? = nil,
        outcome: RistakPerformanceOutcome? = nil,
        durationMilliseconds: Int? = nil,
        itemCount: Int? = nil,
        payloadCount: Int? = nil,
        crashCount: Int? = nil,
        hangCount: Int? = nil,
        cpuExceptionCount: Int? = nil,
        diskWriteExceptionCount: Int? = nil
    ) {
        schemaVersion = 1
        timestampMilliseconds = Int64(timestamp.timeIntervalSince1970 * 1_000)
        self.kind = kind
        self.lifecycleMilestone = lifecycleMilestone
        self.operation = operation
        self.outcome = outcome
        self.durationMilliseconds = Self.clamped(durationMilliseconds, maximum: 86_400_000)
        self.itemCount = Self.clamped(itemCount, maximum: 10_000_000)
        self.payloadCount = Self.clamped(payloadCount, maximum: 100_000)
        self.crashCount = Self.clamped(crashCount, maximum: 100_000)
        self.hangCount = Self.clamped(hangCount, maximum: 100_000)
        self.cpuExceptionCount = Self.clamped(cpuExceptionCount, maximum: 100_000)
        self.diskWriteExceptionCount = Self.clamped(diskWriteExceptionCount, maximum: 100_000)
    }

    static func lifecycle(
        _ milestone: LifecycleMilestone,
        timestamp: Date = Date()
    ) -> RistakDiagnosticRecord {
        RistakDiagnosticRecord(
            timestamp: timestamp,
            kind: .lifecycle,
            lifecycleMilestone: milestone
        )
    }

    static func performance(
        operation: RistakPerformanceOperation,
        outcome: RistakPerformanceOutcome,
        durationMilliseconds: Int,
        itemCount: Int,
        timestamp: Date = Date()
    ) -> RistakDiagnosticRecord {
        RistakDiagnosticRecord(
            timestamp: timestamp,
            kind: .performance,
            operation: operation,
            outcome: outcome,
            durationMilliseconds: durationMilliseconds,
            itemCount: itemCount
        )
    }

    static func metricPayload(
        count: Int,
        timestamp: Date = Date()
    ) -> RistakDiagnosticRecord {
        RistakDiagnosticRecord(
            timestamp: timestamp,
            kind: .metricPayload,
            payloadCount: count
        )
    }

    static func metricDiagnostic(
        payloadCount: Int,
        crashCount: Int,
        hangCount: Int,
        cpuExceptionCount: Int,
        diskWriteExceptionCount: Int,
        timestamp: Date = Date()
    ) -> RistakDiagnosticRecord {
        RistakDiagnosticRecord(
            timestamp: timestamp,
            kind: .metricDiagnostic,
            payloadCount: payloadCount,
            crashCount: crashCount,
            hangCount: hangCount,
            cpuExceptionCount: cpuExceptionCount,
            diskWriteExceptionCount: diskWriteExceptionCount
        )
    }

    private static func clamped(_ value: Int?, maximum: Int) -> Int? {
        value.map { min(max($0, 0), maximum) }
    }
}

/// Ring buffer persistente y serializado. Conserva como máximo 200 eventos y
/// 256 KiB; una escritura dañada se reemplaza en la siguiente operación.
actor RistakDiagnosticRingBuffer {
    static let shared = RistakDiagnosticRingBuffer()

    private static let logger = Logger(
        subsystem: RistakObservability.subsystem,
        category: "diagnostic-store"
    )

    private let fileURL: URL
    private let maximumEntries: Int
    private let maximumBytes: Int
    private var cachedRecords: [RistakDiagnosticRecord]?

    init(
        fileURL: URL = RistakDiagnosticRingBuffer.defaultFileURL(),
        maximumEntries: Int = 200,
        maximumBytes: Int = 256 * 1_024
    ) {
        self.fileURL = fileURL
        self.maximumEntries = max(1, maximumEntries)
        self.maximumBytes = max(1_024, maximumBytes)
    }

    func append(_ record: RistakDiagnosticRecord) {
        var records = loadIfNeeded()
        records.append(record)
        records.sort { $0.timestampMilliseconds < $1.timestampMilliseconds }
        if records.count > maximumEntries {
            records.removeFirst(records.count - maximumEntries)
        }

        do {
            var encoded = try Self.encoder.encode(records)
            while encoded.count > maximumBytes, !records.isEmpty {
                records.removeFirst()
                encoded = try Self.encoder.encode(records)
            }
            try persist(encoded)
            cachedRecords = records
        } catch {
            // No imprimimos el error/path: puede contener información del
            // dispositivo. La falla del almacén sí queda contada en OSLog.
            Self.logger.error("diagnostic_ring_write_failed")
        }
    }

    func snapshot() -> [RistakDiagnosticRecord] {
        loadIfNeeded()
    }

    func clear() {
        cachedRecords = []
        try? FileManager.default.removeItem(at: fileURL)
    }

    private func loadIfNeeded() -> [RistakDiagnosticRecord] {
        if let cachedRecords { return cachedRecords }
        guard let data = try? Data(contentsOf: fileURL),
              data.count <= maximumBytes,
              let decoded = try? Self.decoder.decode(
                  [RistakDiagnosticRecord].self,
                  from: data
              )
        else {
            cachedRecords = []
            return []
        }
        let bounded = Array(decoded.suffix(maximumEntries))
        cachedRecords = bounded
        return bounded
    }

    private func persist(_ data: Data) throws {
        let directoryURL = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        try data.write(to: fileURL, options: .atomic)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: fileURL.path
        )
    }

    nonisolated private static func defaultFileURL() -> URL {
        let baseURL = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        return baseURL
            .appendingPathComponent("RistakObservability", isDirectory: true)
            .appendingPathComponent("diagnostics-v1.json", isDirectory: false)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    private static let decoder = JSONDecoder()
}
