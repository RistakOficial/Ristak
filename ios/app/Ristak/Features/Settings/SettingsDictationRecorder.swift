import AVFoundation
import Foundation
import Observation

/// Grabador de dictado del panel «Asistente Personal AI» (doc 10 §4.15):
/// m4a/AAC alta calidad con `AVAudioRecorder`; el archivo se sube BINARIO a
/// `POST /api/ai-agent/transcribe` con `Content-Type: audio/m4a`.
@MainActor
@Observable
final class SettingsDictationRecorder {
    private(set) var isRecording = false
    private var recorder: AVAudioRecorder?

    /// Pide permiso de micrófono; `false` = denegado.
    func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    /// Inicia una grabación nueva (descarta cualquier archivo previo).
    func start() throws {
        discard()

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
        try session.setActive(true)

        let filename = "dictado-negocio-\(Int(Date().timeIntervalSince1970)).m4a"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]

        let recorder = try AVAudioRecorder(url: url, settings: settings)
        guard recorder.record() else {
            throw NSError(
                domain: "SettingsDictation",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No se pudo iniciar la grabación. Intenta de nuevo."]
            )
        }
        self.recorder = recorder
        isRecording = true
    }

    /// Detiene la grabación y devuelve el m4a (nil si no había grabación).
    /// El caller borra el archivo cuando termina de usarlo.
    func stop() -> URL? {
        guard let recorder, isRecording else { return nil }
        recorder.stop()
        self.recorder = nil
        isRecording = false
        return recorder.url
    }

    /// Cancela y limpia la grabación en curso.
    func discard() {
        if let recorder {
            recorder.stop()
            try? FileManager.default.removeItem(at: recorder.url)
        }
        recorder = nil
        isRecording = false
    }
}
