// JarvisSocket.swift
//
// Tiny WebSocket client over URLSession. Matches the web client's
// protocol exactly:
//   - On open, send `{type:"jarvis.client_hello", userId:"…"}`.
//   - Forward `input_audio_buffer.append` frames upstream as mic captures land.
//   - Receive server events and dispatch via the delegate.
//   - Auto-retry with 1 s backoff up to 3 attempts on transient close.

import Foundation

public protocol JarvisSocketDelegate: AnyObject {
    func socketDidOpen(_ socket: JarvisSocket)
    func socket(_ socket: JarvisSocket, didReceiveEvent event: [String: Any])
    func socket(_ socket: JarvisSocket, didCloseWithCode code: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func socket(_ socket: JarvisSocket, didFailWithError error: Error)
}

public final class JarvisSocket: NSObject, @unchecked Sendable {
    public weak var delegate: JarvisSocketDelegate?

    private let serverURL: URL
    private let userId: String
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var retriesUsed = 0
    private let maxRetries = 3
    private let backoffSeconds: TimeInterval = 1.0
    private var stopped = false

    public init(serverURL: URL, userId: String) {
        self.serverURL = serverURL
        self.userId = userId
    }

    public func connect() {
        stopped = false
        retriesUsed = 0
        openInternal()
    }

    private func openInternal() {
        if session == nil {
            let config = URLSessionConfiguration.default
            config.waitsForConnectivity = false
            session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        }
        var request = URLRequest(url: serverURL)
        // The web client sends X-User-Id only as a non-browser convenience; in
        // browsers it goes via the first `jarvis.client_hello` event. On iOS
        // we have full control of the upgrade headers, so we set BOTH for
        // belt-and-suspenders.
        request.setValue(userId, forHTTPHeaderField: "X-User-Id")
        let task = session!.webSocketTask(with: request)
        self.task = task
        listen()
        task.resume()
    }

    public func close() {
        stopped = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    public func send(_ event: [String: Any]) {
        guard let task = task else { return }
        do {
            let data = try JSONSerialization.data(withJSONObject: event, options: [])
            guard let text = String(data: data, encoding: .utf8) else { return }
            task.send(.string(text)) { [weak self] error in
                if let error = error, let self = self {
                    self.delegate?.socket(self, didFailWithError: error)
                }
            }
        } catch {
            delegate?.socket(self, didFailWithError: error)
        }
    }

    // Recursive receive loop.
    private func listen() {
        task?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case let .failure(error):
                self.delegate?.socket(self, didFailWithError: error)
                self.scheduleRetryIfNeeded()
            case let .success(message):
                switch message {
                case let .string(text):
                    if let data = text.data(using: .utf8),
                       let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                        self.delegate?.socket(self, didReceiveEvent: obj)
                    }
                case .data:
                    // We do not exchange binary frames with the proxy.
                    break
                @unknown default:
                    break
                }
                self.listen()
            }
        }
    }

    private func scheduleRetryIfNeeded() {
        guard !stopped, retriesUsed < maxRetries else { return }
        retriesUsed += 1
        let delay = backoffSeconds * Double(retriesUsed)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, !self.stopped else { return }
            self.openInternal()
        }
    }
}

extension JarvisSocket: URLSessionWebSocketDelegate {
    public func urlSession(_ session: URLSession,
                           webSocketTask: URLSessionWebSocketTask,
                           didOpenWithProtocol protocol: String?) {
        retriesUsed = 0
        delegate?.socketDidOpen(self)
        // Mirror the web client's first event.
        send(["type": "jarvis.client_hello", "userId": userId])
    }

    public func urlSession(_ session: URLSession,
                           webSocketTask: URLSessionWebSocketTask,
                           didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                           reason: Data?) {
        delegate?.socket(self, didCloseWithCode: closeCode, reason: reason)
        scheduleRetryIfNeeded()
    }
}
