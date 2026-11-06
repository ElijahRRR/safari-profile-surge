import Foundation

enum AdminTransportError: Error, Equatable {
    case notRunning
    case timeout
    case ioFailed
    case responseTooLarge
    case closedWithoutResponse

    var message: String {
        switch self {
        case .notRunning: return "无法连接本机服务：后台服务未运行，请先注册后台服务"
        case .timeout: return "无法连接本机服务：等待应答超时"
        case .ioFailed: return "无法连接本机服务：读写失败"
        case .responseTooLarge: return "无法连接本机服务：应答过大"
        case .closedWithoutResponse: return "无法连接本机服务：服务没有返回结果"
        }
    }
}

/// maintenance.sock（Unix 套接字，0600，位于 0700 数据目录）上的一次 NDJSON 往返。
/// 阻塞式 POSIX 调用放在后台队列执行；只返回原始应答行，解析在调用方完成。从不记录请求或应答。
struct MaintenanceClient: Sendable {
    let socketPath: String
    var timeoutSeconds: Int = 15

    func send(_ line: Data) async -> Result<Data, AdminTransportError> {
        let path = socketPath
        let timeout = timeoutSeconds
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: Self.roundTrip(path: path, line: line, timeoutSeconds: timeout))
            }
        }
    }

    private static func roundTrip(path: String, line: Data, timeoutSeconds: Int) -> Result<Data, AdminTransportError> {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return .failure(.ioFailed) }
        defer { close(fd) }

        var noSigPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: timeoutSeconds, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

        var address = sockaddr_un()
        let pathBytes = Array(path.utf8)
        guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return .failure(.notRunning) }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: pathBytes)
        }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { return .failure(.notRunning) }

        let sent = line.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> Bool in
            var offset = 0
            while offset < buffer.count {
                let written = write(fd, buffer.baseAddress! + offset, buffer.count - offset)
                if written < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                offset += written
            }
            return true
        }
        guard sent else { return .failure(errno == EAGAIN ? .timeout : .ioFailed) }

        var lineBuffer = LineBuffer(maxBytes: AdminProtocol.maxResponseBytes)
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if count < 0 {
                if errno == EINTR { continue }
                return .failure(errno == EAGAIN ? .timeout : .ioFailed)
            }
            let outcome = count == 0 ? lineBuffer.finish() : lineBuffer.append(Data(chunk[0..<count]))
            switch outcome {
            case .line(let response):
                return .success(response)
            case .tooLong:
                return .failure(.responseTooLarge)
            case .empty:
                return .failure(.closedWithoutResponse)
            case .needMore:
                if count == 0 { return .failure(.closedWithoutResponse) }
            }
        }
    }
}
