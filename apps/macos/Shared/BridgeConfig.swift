import Foundation

/// 原生桥传输地址。首版只有候选 A：回环 TCP（docs/ARCHITECTURE.md §2，由 P0 native_bridge_ipc 定案）。
struct BridgeEndpoint: Equatable {
    let port: UInt16
}

struct BridgeCredentials {
    let endpoint: BridgeEndpoint
    /// 每次安装随机生成的传输令牌：只在内存与 0600 文件中，从不记录。
    let token: String
}

/// 读取 App Group 容器（或其中的文件）时的问题，不含路径或文件内容。
///
/// macOS 上 containerURL 总会返回形式正确的 URL，即使 App Group 无效（“In macOS, a URL of the expected form is always
/// returned, even if the app group is invalid, so be sure to test that you can access the underlying directory before
/// attempting to use it.”，https://developer.apple.com/documentation/foundation/filemanager/containerurl(forsecurityapplicationgroupidentifier:)），
/// 所以能否访问只能靠实际读写判断，并且要把「没有权限」和「找不到配置」分开报告。
enum BridgeFileProblem: Error, Equatable {
    /// Info.plist 中没有有效的 App Group 标识（构建设置问题）。
    case noAppGroup
    /// 容器或文件不存在（ENOENT）。签名不含该 App Group 时 “the corresponding group directory does not actually exist”（同上页）。
    case missing
    /// 系统拒绝访问（EACCES、EPERM）。macOS 15 起扩展访问群组容器不满足条件时系统不提示，直接拒绝（“This restriction also
    /// applies to app extensions, although in that case the system won’t prompt the user for consent but will instead just
    /// deny the access.”，https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes）。
    case denied
    /// 不是普通文件或目录、是符号链接（ELOOP）、路径中有非目录（ENOTDIR）、超过大小上限或内容格式不正确。
    case invalid
    /// 其他错误（只保留 errno 值）。
    case failed(errno: Int32)

    // P0: native_bridge_ipc —— 拒绝访问时实际得到哪个 errno，Apple 没有写明；EACCES/EPERM 之外的值归入 failed 并在提示中给出，
    // 一律不连接（失败即关闭）。
    static func from(errno code: Int32) -> BridgeFileProblem {
        switch code {
        case ENOENT: return .missing
        case EACCES, EPERM: return .denied
        case ENOTDIR, ELOOP: return .invalid
        default: return .failed(errno: code)
        }
    }

    /// 扩展交给弹窗的错误应答。
    var nativeFailure: NativeFailure {
        switch self {
        case .noAppGroup, .missing, .invalid: return .notConfigured
        case .denied: return .containerDenied
        case .failed(let code): return .configUnreadable(errno: code)
        }
    }

    /// 宿主 App 菜单中的问题提示（宿主 App 自己读取的结果；扩展被拒绝时系统不提示，只有扩展弹窗会显示）。
    var hostProblemText: String {
        switch self {
        case .noAppGroup: return "原生桥无法连接：App 的 Info.plist 中没有 App Group 标识，请检查签名设置后重新构建"
        case .missing: return "原生桥无法连接：App Group 容器中找不到原生桥配置"
        case .denied: return "原生桥无法连接：系统拒绝访问 App Group 容器，请检查 App 与扩展签名的 Team ID 与 App Group 设置"
        case .invalid: return "原生桥无法连接：App Group 容器中的原生桥配置不正确"
        case .failed(let code): return "原生桥无法连接：读取 App Group 容器失败（errno \(code)）"
        }
    }

    /// 宿主 App 菜单「服务状态」中的一行。
    var hostStatusLine: String {
        switch self {
        case .denied: return "原生桥：无法访问 App Group 容器（系统拒绝）"
        case .noAppGroup, .missing, .invalid, .failed: return "原生桥：无法读取原生桥配置"
        }
    }

    /// 启动准备（InstallSetup）失败的说明。
    var setupText: String {
        switch self {
        case .noAppGroup: return "准备原生桥失败：Info.plist 中没有有效的 App Group 标识，请检查签名设置"
        case .missing: return "准备原生桥失败：App Group 容器不存在，请检查签名中的 App Group 设置"
        case .denied: return "准备原生桥失败：系统拒绝访问 App Group 容器，请检查签名的 Team ID 与 App Group 设置"
        case .invalid: return "准备原生桥失败：App Group 容器或其中的原生桥配置不是预期的目录或文件"
        case .failed(let code): return "准备原生桥失败：无法访问 App Group 容器（errno \(code)）"
        }
    }
}

/// App Group 容器中的 bridge.json（{ transport: "tcp", port }）与 bridge.token，由宿主 App 写入、扩展只读。
enum BridgeFiles {
    static let configFileName = "bridge.json"
    static let tokenFileName = "bridge.token"
    /// Info.plist 中的 App Group 标识（$(DEVELOPMENT_TEAM).sfe，与 entitlements 中的 $(TeamIdentifierPrefix)sfe 相同）。
    static let appGroupInfoKey = "SFEAppGroupIdentifier"
    static let maxConfigBytes = 4 * 1024
    static let maxTokenBytes = 256

    static func appGroupIdentifier(bundle: Bundle = .main) -> String? {
        guard let value = bundle.object(forInfoDictionaryKey: appGroupInfoKey) as? String,
              !value.isEmpty, !value.hasPrefix("."), !value.contains("$(")
        else { return nil }
        return value
    }

    // P0: native_bridge_ipc —— 确认 Personal Team 签名下宿主 App（未沙盒）与扩展（沙盒）拿到同一个容器，以扩展往返成功为准。
    // 宿主 App 不满足 macOS 15 的条件时系统可能弹出「访问其他 App 数据」的提示；扩展不满足时系统不提示、直接拒绝，
    // 所以「没有提示」不能证明扩展可以访问（拒绝时弹窗显示 containerDenied）。宿主 App 未沙盒时系统是否自动创建容器目录也在此记录。
    static func containerURL(bundle: Bundle = .main) -> URL? {
        guard let group = appGroupIdentifier(bundle: bundle) else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    }

    // MARK: 纯函数

    static func parseConfig(_ data: Data) -> BridgeEndpoint? {
        guard data.count <= maxConfigBytes,
              let object = JSONLine.decodeObject(data),
              object["transport"] as? String == "tcp",
              let port = JSONLine.integer(object["port"]),
              (1...65535).contains(port)
        else { return nil }
        return BridgeEndpoint(port: UInt16(port))
    }

    static func encodeConfig(_ endpoint: BridgeEndpoint) -> Data {
        // 固定两个字段，编码不会失败
        JSONLine.encode(["transport": "tcp", "port": Int(endpoint.port)] as [String: Any]) ?? Data()
    }

    /// 令牌：32 字节随机数的 base64url（无填充），恰好 43 个字符。
    static func isValidToken(_ token: String) -> Bool {
        let bytes = Array(token.utf8)
        guard bytes.count == 43 else { return false }
        return bytes.allSatisfy { byte in
            switch byte {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"),
                 UInt8(ascii: "a")...UInt8(ascii: "z"),
                 UInt8(ascii: "0")...UInt8(ascii: "9"),
                 UInt8(ascii: "-"), UInt8(ascii: "_"):
                return true
            default:
                return false
            }
        }
    }

    /// 文件内容可带一个结尾换行。
    static func parseToken(_ data: Data) -> String? {
        guard data.count <= maxTokenBytes, var text = String(data: data, encoding: .utf8) else { return nil }
        if text.hasSuffix("\n") { text.removeLast() }
        return isValidToken(text) ? text : nil
    }

    static func base64URL(_ bytes: [UInt8]) -> String {
        Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: 读取（扩展与宿主 App）

    /// 扩展使用：失败时为交给弹窗的错误应答（没有权限与找不到配置分开报告）。
    static func load(bundle: Bundle = .main) -> Result<BridgeCredentials, NativeFailure> {
        loadCredentials(bundle: bundle).mapError(\.nativeFailure)
    }

    static func load(from container: URL) -> Result<BridgeCredentials, NativeFailure> {
        loadCredentials(from: container).mapError(\.nativeFailure)
    }

    static func loadCredentials(bundle: Bundle = .main) -> Result<BridgeCredentials, BridgeFileProblem> {
        guard let container = containerURL(bundle: bundle) else { return .failure(.noAppGroup) }
        return loadCredentials(from: container)
    }

    static func loadCredentials(from container: URL) -> Result<BridgeCredentials, BridgeFileProblem> {
        let endpoint: BridgeEndpoint
        switch readFile(container.appendingPathComponent(configFileName), maxBytes: maxConfigBytes) {
        case .failure(let problem):
            return .failure(problem)
        case .success(let data):
            guard let parsed = parseConfig(data) else { return .failure(.invalid) }
            endpoint = parsed
        }
        switch readFile(container.appendingPathComponent(tokenFileName), maxBytes: maxTokenBytes) {
        case .failure(let problem):
            return .failure(problem)
        case .success(let data):
            guard let token = parseToken(data) else { return .failure(.invalid) }
            return .success(BridgeCredentials(endpoint: endpoint, token: token))
        }
    }

    /// 容器目录能否打开（nil 表示可以）。宿主 App 写入前调用：containerURL 不为 nil 不代表能访问。
    static func checkDirectoryAccess(_ directory: URL) -> BridgeFileProblem? {
        // O_NONBLOCK：路径若被换成 FIFO，open 也不会阻塞
        let fd = open(directory.path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { return BridgeFileProblem.from(errno: errno) }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0 else { return BridgeFileProblem.from(errno: errno) }
        guard (info.st_mode & S_IFMT) == S_IFDIR else { return BridgeFileProblem.invalid }
        return nil
    }

    /// 读取容器中的一个文件：不跟随符号链接，只接受不超过 maxBytes 的普通文件；失败按 errno 分类，从不带出内容。
    static func readFile(_ url: URL, maxBytes: Int) -> Result<Data, BridgeFileProblem> {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { return .failure(BridgeFileProblem.from(errno: errno)) }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0 else { return .failure(BridgeFileProblem.from(errno: errno)) }
        guard (info.st_mode & S_IFMT) == S_IFREG, info.st_size >= 0, info.st_size <= off_t(maxBytes) else {
            return .failure(.invalid)
        }
        var data = Data(count: Int(info.st_size))
        var readErrno: Int32 = 0
        let complete = data.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) -> Bool in
            var offset = 0
            while offset < buffer.count {
                let count = read(fd, buffer.baseAddress! + offset, buffer.count - offset)
                if count < 0 {
                    if errno == EINTR { continue }
                    readErrno = errno
                    return false
                }
                if count == 0 { break }
                offset += count
            }
            return offset == buffer.count
        }
        if readErrno != 0 { return .failure(BridgeFileProblem.from(errno: readErrno)) }
        return complete ? .success(data) : .failure(.invalid)
    }
}
