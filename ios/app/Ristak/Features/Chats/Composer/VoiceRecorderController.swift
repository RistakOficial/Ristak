import AVFoundation
import Foundation
import Observation

/// Grabador de notas de voz (doc 05 §7.3): AAC/m4a con `AVAudioRecorder`
/// (el backend transcodifica a OGG/Opus). Mide `durationMs` en cliente —
/// el backend NO la calcula (gap doc 05 §10.15).
@MainActor
@Observable
final class VoiceRecorderController: NSObject {
    enum Phase: Equatable {
        case idle
        case recording
        /// Grabación terminada, esperando confirmar/enviar o descartar.
        case preview
    }

    private(set) var phase: Phase = .idle
    /// Segundos transcurridos (se actualiza ~4 veces por segundo).
    private(set) var elapsedSeconds: TimeInterval = 0
    /// Nivel de metering normalizado 0…1 para la onda en vivo.
    private(set) var meterLevel: Double = 0
    /// Archivo m4a de la última grabación terminada.
    private(set) var recordedFileURL: URL?
    /// Duración medida de la grabación terminada.
    private(set) var recordedDurationMs: Double = 0

    private var recorder: AVAudioRecorder?
    private var meterTask: Task<Void, Never>?

    var isRecording: Bool { phase == .recording }
    var hasPreview: Bool { phase == .preview && recordedFileURL != nil }

    /// Pide permiso de micrófono; `false` = denegado.
    func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    /// Inicia una grabación nueva. Lanza error con copy en español si falla.
    func start() throws {
        discard()

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
        try session.setActive(true)

        let filename = "nota-voz-\(Int(Date().timeIntervalSince1970)).m4a"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]

        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.isMeteringEnabled = true
        guard recorder.record() else {
            throw NSError(
                domain: "VoiceRecorder",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No se pudo iniciar la grabación. Intenta de nuevo."]
            )
        }

        self.recorder = recorder
        recordedFileURL = nil
        recordedDurationMs = 0
        elapsedSeconds = 0
        phase = .recording
        startMetering()
    }

    /// Detiene y deja la grabación lista en `preview` (o descarta si es muy corta).
    /// - Returns: `false` si la grabación duró menos del mínimo (600 ms).
    @discardableResult
    func stop() -> Bool {
        guard let recorder, phase == .recording else { return false }
        let duration = recorder.currentTime
        recorder.stop()
        stopMetering()
        self.recorder = nil

        let durationMs = duration * 1000
        if durationMs < ChatMediaLimits.minVoiceNoteDurationMs {
            try? FileManager.default.removeItem(at: recorder.url)
            phase = .idle
            elapsedSeconds = 0
            return false
        }

        recordedFileURL = recorder.url
        recordedDurationMs = durationMs
        elapsedSeconds = duration
        phase = .preview
        return true
    }

    /// Cancela la grabación en curso o descarta el preview.
    func discard() {
        if let recorder {
            recorder.stop()
            try? FileManager.default.removeItem(at: recorder.url)
        }
        recorder = nil
        stopMetering()
        if let recordedFileURL {
            try? FileManager.default.removeItem(at: recordedFileURL)
        }
        recordedFileURL = nil
        recordedDurationMs = 0
        elapsedSeconds = 0
        phase = .idle
    }

    /// Consume el preview (tras enviarlo). El archivo lo limpia el caller
    /// cuando el envío termina.
    func consumePreview() -> (url: URL, durationMs: Double)? {
        guard let url = recordedFileURL, recordedDurationMs > 0 else { return nil }
        let duration = recordedDurationMs
        recordedFileURL = nil
        recordedDurationMs = 0
        elapsedSeconds = 0
        phase = .idle
        return (url, duration)
    }

    // MARK: - Metering

    private func startMetering() {
        meterTask?.cancel()
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard let self, let recorder = self.recorder, self.phase == .recording else { return }
                recorder.updateMeters()
                let power = recorder.averagePower(forChannel: 0) // -160…0 dB
                let normalized = max(0, min(1, Double(power + 50) / 50))
                self.meterLevel = normalized
                self.elapsedSeconds = recorder.currentTime
            }
        }
    }

    private func stopMetering() {
        meterTask?.cancel()
        meterTask = nil
        meterLevel = 0
    }
}
