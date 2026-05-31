// AudioEngineCoordinator.swift
//
// Owns the AVAudioEngine + AVAudioPlayerNode pair that captures the user's
// microphone at 24 kHz mono PCM16 (the format the OpenAI Realtime GA
// session uses) and plays back the audio deltas the server forwards.
//
// Capture pipeline:
//   AVAudioEngine.inputNode (whatever the hardware sample rate is)
//     -> AVAudioConverter (resample to 24 kHz Float32 mono)
//     -> Int16 LE PCM
//     -> base64 → `input_audio_buffer.append` upstream
//
// Playback pipeline:
//   server `response.audio.delta` (already renamed by the proxy)
//     -> base64 → Int16 LE PCM (24 kHz)
//     -> Float32 mono
//     -> AVAudioPlayerNode.scheduleBuffer
//
// Barge-in (US-04):
//   When the capture pipeline's RMS over a frame exceeds the VAD
//   threshold AND we are currently playing back, we:
//     - stop+clear the player node (≤200ms target)
//     - emit `jarvis.barge_in` to the server so it cancels the upstream
//       response within its own 300ms budget.

import AVFoundation
import Foundation

public protocol AudioEngineDelegate: AnyObject {
    /// New microphone PCM ready to push upstream. The data is Int16 LE,
    /// 24 kHz, mono, base64-encoded as the WebSocket payload requires.
    func audioEngine(_ engine: AudioEngineCoordinator, capturedPCMBase64 base64: String, rms: Float)

    /// Called when the engine detects a barge-in (user speaking while we
    /// were playing back). The caller is responsible for sending
    /// `jarvis.barge_in` upstream.
    func audioEngineDidDetectBargeIn(_ engine: AudioEngineCoordinator)
}

public final class AudioEngineCoordinator: @unchecked Sendable {
    public weak var delegate: AudioEngineDelegate?

    /// 24 kHz mono Float32 — matches the Realtime GA `pcm16` payload rate.
    public static let targetSampleRate: Double = 24_000

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var converter: AVAudioConverter?
    private var isPlaying = false
    private let bargeInRMSThreshold: Float = 0.04
    private let captureFormat: AVAudioFormat

    public init() {
        // Capture format we EMIT upstream — 24 kHz, mono, Float32 (the
        // converter feeds this from whatever the hardware delivers).
        self.captureFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Self.targetSampleRate,
            channels: 1,
            interleaved: false
        )!
    }

    /// Activate the audio session, install the capture tap, and prepare
    /// the player. Throws an explicit error per failure mode so callers
    /// can surface a precise reason in the UI.
    public func start() throws {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
        } catch {
            throw AudioEngineError.audioSessionConfigurationFailed(underlying: error)
        }

        let mixer = engine.mainMixerNode
        engine.attach(player)
        // 24 kHz mono out — the player schedules buffers in this format.
        engine.connect(player, to: mixer, format: captureFormat)

        // Capture tap — uses the input's native format, we convert
        // ourselves to avoid any "format mismatch" weirdness across
        // hardware (some Macs ship 44.1 kHz, AirPods give 16 kHz, etc).
        let inputFormat = engine.inputNode.outputFormat(forBus: 0)
        if inputFormat.sampleRate <= 0 || inputFormat.channelCount == 0 {
            throw AudioEngineError.inputFormatUnavailable(format: inputFormat)
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: captureFormat) else {
            throw AudioEngineError.converterCreationFailed(from: inputFormat, to: captureFormat)
        }
        self.converter = converter

        engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] inputBuffer, _ in
            guard let self = self else { return }
            self.processCapturedBuffer(inputBuffer)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            throw AudioEngineError.engineStartFailed(underlying: error)
        }
        player.play()
    }

    public func stop() {
        player.stop()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Append a server-supplied PCM16 LE @ 24 kHz buffer to the player.
    public func enqueuePlayback(pcm16LE: Data) {
        let sampleCount = pcm16LE.count / 2
        guard sampleCount > 0 else { return }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: captureFormat, frameCapacity: AVAudioFrameCount(sampleCount)) else {
            return
        }
        buffer.frameLength = AVAudioFrameCount(sampleCount)
        let dst = buffer.floatChannelData![0]
        pcm16LE.withUnsafeBytes { rawBuf in
            let int16Ptr = rawBuf.bindMemory(to: Int16.self)
            for i in 0..<sampleCount {
                dst[i] = Float(int16Ptr[i]) / 32768.0
            }
        }
        isPlaying = true
        player.scheduleBuffer(buffer, at: nil, options: [], completionHandler: { [weak self] in
            // When the queue drains, we're back to listening.
            self?.isPlaying = false
        })
    }

    /// Drop everything queued in the player. Used on barge-in.
    public func clearPlayback() {
        player.stop()
        // Re-play so subsequent scheduleBuffer calls actually play.
        player.play()
        isPlaying = false
    }

    // MARK: - Internals

    private func processCapturedBuffer(_ input: AVAudioPCMBuffer) {
        guard let converter = converter else { return }
        let ratio = captureFormat.sampleRate / input.format.sampleRate
        let outFrameCapacity = AVAudioFrameCount(Double(input.frameLength) * ratio + 16)
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: captureFormat, frameCapacity: outFrameCapacity) else { return }
        var error: NSError?
        var fed = false
        _ = converter.convert(to: outBuffer, error: &error) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return input
        }
        if error != nil { return }
        let frames = Int(outBuffer.frameLength)
        guard frames > 0, let chan = outBuffer.floatChannelData?[0] else { return }

        var sumSquares: Float = 0
        var pcm16 = Data(count: frames * 2)
        pcm16.withUnsafeMutableBytes { rawBuf in
            let int16Ptr = rawBuf.bindMemory(to: Int16.self)
            for i in 0..<frames {
                let f = chan[i]
                sumSquares += f * f
                let clamped = max(-1.0, min(1.0, f))
                int16Ptr[i] = Int16(clamped * 32767.0)
            }
        }
        let rms = sqrtf(sumSquares / Float(frames))
        if isPlaying && rms > bargeInRMSThreshold {
            clearPlayback()
            delegate?.audioEngineDidDetectBargeIn(self)
        }
        let base64 = pcm16.base64EncodedString()
        delegate?.audioEngine(self, capturedPCMBase64: base64, rms: rms)
    }
}

// MARK: - Errors

/// Failure modes spoken plainly. Each carries enough context that a log
/// line is sufficient to know what to fix.
public enum AudioEngineError: Error, CustomStringConvertible {
    case audioSessionConfigurationFailed(underlying: Error)
    case inputFormatUnavailable(format: AVAudioFormat)
    case converterCreationFailed(from: AVAudioFormat, to: AVAudioFormat)
    case engineStartFailed(underlying: Error)

    public var description: String {
        switch self {
        case let .audioSessionConfigurationFailed(underlying):
            return "AVAudioSession could not be configured for playAndRecord+voiceChat: \(underlying)"
        case let .inputFormatUnavailable(format):
            return "AVAudioEngine inputNode reported an unusable format (\(format)). Mic permission may be denied or no input device present."
        case let .converterCreationFailed(fromFmt, toFmt):
            return "AVAudioConverter could not be created from \(fromFmt) to \(toFmt). One of the formats is likely unsupported."
        case let .engineStartFailed(underlying):
            return "AVAudioEngine.start() threw: \(underlying)"
        }
    }
}
