import Foundation
import Synchronization

public protocol WebSocketTasking: AnyObject {
    var state: URLSessionTask.State { get }
    var response: URLResponse? { get }
    func resume()
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void)
    func receive() async throws -> URLSessionWebSocketTask.Message
    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
}

extension WebSocketTasking {
    public var response: URLResponse? {
        nil
    }
}

extension URLSessionWebSocketTask: WebSocketTasking {}

/// Orders an operation owner's retirement with the transport's synchronous enqueue.
/// Retirement rejects future frames without cancelling requests already dispatched.
public final class WebSocketRequestAdmission: @unchecked Sendable {
    private let lock = NSLock()
    private var active = true
    private var observers: [UUID: AsyncStream<Void>.Continuation] = [:]

    public init() {}

    public var isActive: Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.active
    }

    public func performIfActive(_ enqueue: () -> Bool) -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.active && enqueue()
    }

    public func retire() {
        self.lock.lock()
        self.active = false
        let observers = self.observers.values
        self.observers.removeAll()
        self.lock.unlock()
        observers.forEach { $0.finish() }
    }

    public func retirement() -> AsyncStream<Void> {
        AsyncStream { continuation in
            let id = UUID()
            self.lock.lock()
            if self.active { self.observers[id] = continuation } else { continuation.finish() }
            self.lock.unlock()
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.lock()
                self.observers[id] = nil
                self.lock.unlock()
            }
        }
    }
}

/// Carries the native request owner's completion across transports that retain their own RPC state.
public final class WebSocketRequestLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    private var onFinish: (@Sendable () -> Void)?

    private let admission: WebSocketRequestAdmission?

    public init(admission: WebSocketRequestAdmission? = nil) {
        self.admission = admission
    }

    var requiresSynchronousEnqueue: Bool {
        self.admission != nil
    }

    // periphery:ignore - External transports use this to order send admission with cancellation.
    /// Enqueue the request while holding the same lock that orders its retirement.
    /// The actions must only enqueue work; running I/O here would block cancellation.
    public func performIfActive(
        _ action: () -> Void,
        onFinish: @escaping @Sendable () -> Void) -> Bool
    {
        if let admission {
            return admission.performIfActive { self.enqueueIfUnfinished(action, onFinish: onFinish) }
        }
        return self.enqueueIfUnfinished(action, onFinish: onFinish)
    }

    private func enqueueIfUnfinished(_ action: () -> Void, onFinish: @escaping @Sendable () -> Void) -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        guard !self.finished else { return false }
        action()
        self.onFinish = onFinish
        return true
    }

    public func finish() {
        self.lock.lock()
        guard !self.finished else { self.lock.unlock()
            return
        }
        self.finished = true
        let action = self.onFinish
        self.onFinish = nil
        self.lock.unlock()
        action?()
    }
}

// periphery:ignore - Native transports implement caller-owned request lifetime handling.
public protocol WebSocketRequestSending: WebSocketTasking {
    // periphery:ignore - The erased request adapter dispatches through this optional transport seam.
    func sendRequest(_ message: URLSessionWebSocketTask.Message, lifetime: WebSocketRequestLifetime) async throws
}

public struct WebSocketTaskBox: @unchecked Sendable {
    /// Bounds a ping whose pong handler URLSession may never invoke. Long enough that a
    /// slow-but-live link still pongs, short enough that a wedged keepalive recovers.
    public static let pingTimeout: Duration = .seconds(10)

    public let task: any WebSocketTasking
    public init(task: any WebSocketTasking) {
        self.task = task
    }

    public var state: URLSessionTask.State {
        self.task.state
    }

    public var response: URLResponse? {
        self.task.response
    }

    public func resume() {
        self.task.resume()
    }

    /// URLSessionWebSocketTask cancellation can lose a race with its HTTP 101: the task completes
    /// as canceled, then Foundation opens the upgraded socket anyway. Nothing in URLSession (task
    /// cancel, session invalidation or reset) reclaims that socket, and its descriptor outlives
    /// the peer's close. Callers keep it unused through socket generations and admission; the
    /// Gateway closes its end at the preauth handshake timeout.
    public func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        self.task.cancel(with: closeCode, reason: reason)
    }

    public func send(_ message: URLSessionWebSocketTask.Message) async throws {
        try await self.task.send(message)
    }

    public func sendRequest(
        _ message: URLSessionWebSocketTask.Message,
        lifetime: WebSocketRequestLifetime) async throws
    {
        if let transport = self.task as? any WebSocketRequestSending {
            try await transport.sendRequest(message, lifetime: lifetime)
        } else if let task = self.task as? URLSessionWebSocketTask {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let admitted = lifetime.performIfActive {
                    task.send(message) { error in
                        ThrowingContinuationSupport.resumeVoid(continuation, error: error)
                    }
                } onFinish: {}
                if !admitted { continuation.resume(throwing: CancellationError()) }
            }
        } else {
            guard !lifetime.requiresSynchronousEnqueue else { throw CancellationError() }
            try await self.task.send(message)
        }
    }

    public func receive() async throws -> URLSessionWebSocketTask.Message {
        try await self.task.receive()
    }

    public func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        self.task.receive(completionHandler: completionHandler)
    }

    public func sendPing(timeout: Duration = WebSocketTaskBox.pingTimeout) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let didResume = Mutex(false)
            let finish: @Sendable (Error?) -> Void = { error in
                let first = didResume.withLock { resumed in
                    guard !resumed else { return false }
                    resumed = true
                    return true
                }
                if first { ThrowingContinuationSupport.resumeVoid(continuation, error: error) }
            }
            // URLSession drops the pong handler entirely when the task is cancelled or
            // closed mid-flight, which orphans this continuation and wedges the keepalive
            // loop forever on an await that can never return. The deadline guarantees the
            // continuation always resumes; the gate keeps that resume exactly once.
            let deadline = Task {
                do {
                    try await Task.sleep(for: timeout)
                } catch {
                    // Cancelled because a pong arrived first; that callback owns the resume.
                    // Swallowing this error instead would race the gate and report a healthy
                    // ping as timed out.
                    return
                }
                finish(URLError(.timedOut))
            }
            self.task.sendPing { error in
                deadline.cancel()
                // URLSession can race ping callbacks with cancellation; only the first
                // pong result owns this checked continuation or Swift traps the app.
                finish(error)
            }
        }
    }
}

public protocol WebSocketSessioning: AnyObject {
    func makeWebSocketTask(url: URL) -> WebSocketTaskBox
    func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox
}

extension WebSocketSessioning {
    /// Compatibility path for existing session conformers. URLSession and pinning sessions
    /// override this requirement so operator headers remain attached to the upgrade request.
    public func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        guard let url = request.url else { preconditionFailure("WebSocket request URL is required") }
        return self.makeWebSocketTask(url: url)
    }
}

extension URLSession: WebSocketSessioning {
    public func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.makeWebSocketTask(request: URLRequest(url: url))
    }

    public func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        let task = self.webSocketTask(with: request)
        // Avoid "Message too long" receive errors for large snapshots / history payloads.
        task.maximumMessageSize = 16 * 1024 * 1024 // 16 MB
        return WebSocketTaskBox(task: task)
    }
}

public struct WebSocketSessionBox: @unchecked Sendable {
    public let session: any WebSocketSessioning

    public init(session: any WebSocketSessioning) {
        self.session = session
    }
}
