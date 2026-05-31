// JarvisViewModel.swift
//
// SwiftUI-facing view model. Owns the audio coordinator and the socket
// and exposes the four observable values the SwiftUI view binds to:
//
//   - status (idle/listening/thinking/speaking/error)
//   - caption (the human-readable status caption)
//   - capabilities ([String]) for the chip
//   - lastToolResult (String, raw JSON) for the debug pane

import Foundation
import SwiftUI

@MainActor
public final class JarvisViewModel: ObservableObject {
    public enum Status: String, Equatable {
        case idle, listening, thinking, speaking, error
    }

    @Published public private(set) var status: Status = .idle
    @Published public private(set) var caption: String = ""
    @Published public private(set) var capabilities: [String] = []
    @Published public private(set) var lastToolResult: String = ""
    @Published public private(set) var connectionState: String = "disconnected"

    private let audio = AudioEngineCoordinator()
    private var socket: JarvisSocket?
    private var serverURL: URL
    private let userId: String

    public init() {
        self.serverURL = UserDefaults.standard.jarvisServerURL
        self.userId = Keychain.jarvisUserId
        audio.delegate = self
        Task { await self.refreshCapabilities() }
    }

    public func setServerURL(_ url: URL) {
        UserDefaults.standard.jarvisServerURL = url
        self.serverURL = url
        Task { await self.refreshCapabilities() }
    }

    public var activeUserId: String { userId }

    public func start() {
        do {
            try audio.start()
        } catch {
            status = .error
            caption = "Audio failed: \(error)"
            return
        }
        let s = JarvisSocket(serverURL: serverURL, userId: userId)
        s.delegate = self
        self.socket = s
        s.connect()
        status = .listening
        caption = "Connecting…"
    }

    public func stop() {
        audio.stop()
        socket?.close()
        socket = nil
        status = .idle
        caption = ""
        connectionState = "disconnected"
    }

    private func refreshCapabilities() async {
        guard let url = JarvisConfig.healthURL(from: serverURL) else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let caps = json["capabilities"] as? [[String: Any]] else { return }
            let enabled = caps.compactMap { c -> String? in
                guard let name = c["name"] as? String,
                      let available = c["available"] as? Bool,
                      available else { return nil }
                return name
            }
            await MainActor.run { self.capabilities = enabled }
        } catch {
            // Server not yet up — silent.
        }
    }
}

// MARK: - AudioEngineDelegate

extension JarvisViewModel: AudioEngineDelegate {
    nonisolated public func audioEngine(_ engine: AudioEngineCoordinator, capturedPCMBase64 base64: String, rms: Float) {
        Task { @MainActor [weak self] in
            self?.socket?.send([
                "type": "input_audio_buffer.append",
                "audio": base64,
            ])
        }
    }
    nonisolated public func audioEngineDidDetectBargeIn(_ engine: AudioEngineCoordinator) {
        Task { @MainActor [weak self] in
            self?.socket?.send(["type": "jarvis.barge_in"])
            self?.status = .listening
            self?.caption = "Cut off."
        }
    }
}

// MARK: - JarvisSocketDelegate

extension JarvisViewModel: JarvisSocketDelegate {
    nonisolated public func socketDidOpen(_ socket: JarvisSocket) {
        Task { @MainActor [weak self] in
            self?.connectionState = "open"
        }
    }

    nonisolated public func socket(_ socket: JarvisSocket, didReceiveEvent event: [String : Any]) {
        Task { @MainActor [weak self] in
            self?.handleEvent(event)
        }
    }

    nonisolated public func socket(_ socket: JarvisSocket, didCloseWithCode code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        Task { @MainActor [weak self] in
            self?.connectionState = "closed (\(code.rawValue))"
        }
    }

    nonisolated public func socket(_ socket: JarvisSocket, didFailWithError error: Error) {
        Task { @MainActor [weak self] in
            self?.status = .error
            self?.caption = "Connection error: \(error.localizedDescription)"
        }
    }

    private func handleEvent(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        switch type {
        case "jarvis.session_ready":
            status = .listening
            caption = "Listening. Say something."
        case "jarvis.filler":
            status = .thinking
            caption = (event["text"] as? String) ?? "Working…"
        case "jarvis.tool_result":
            if let data = try? JSONSerialization.data(withJSONObject: event, options: [.prettyPrinted]),
               let text = String(data: data, encoding: .utf8) {
                lastToolResult = text
            }
        case "response.audio.delta":
            status = .speaking
            if let b64 = event["delta"] as? String, let pcm = Data(base64Encoded: b64) {
                audio.enqueuePlayback(pcm16LE: pcm)
            }
        case "response.audio.done":
            status = .listening
            caption = "Listening."
        case "input_audio_buffer.speech_started":
            status = .listening
            caption = "Heard you."
        case "input_audio_buffer.speech_stopped":
            status = .thinking
            caption = "Thinking…"
        case "error":
            status = .error
            if let err = event["error"] as? [String: Any], let msg = err["message"] as? String {
                caption = "Upstream error: \(msg)"
            } else {
                caption = "Upstream error."
            }
        default:
            break
        }
    }
}
