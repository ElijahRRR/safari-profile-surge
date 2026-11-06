import Foundation

/// 含令牌或安装配置的文件：O_CREAT|O_EXCL|O_NOFOLLOW 0600 临时文件 → fsync → rename，目录 0700。
/// 从不跟随符号链接，从不把文件内容写进错误信息。
enum SecureFile {
    struct Failure: Error, Equatable {
        let message: String
    }

    /// 创建或收紧为 0700 目录。已存在的符号链接或非目录直接拒绝。
    static func ensurePrivateDirectory(_ url: URL) throws {
        let path = url.path
        if mkdir(path, 0o700) == 0 { return }
        guard errno == EEXIST else { throw Failure(message: "无法创建目录 \(url.lastPathComponent)") }
        var info = stat()
        guard lstat(path, &info) == 0 else { throw Failure(message: "无法读取目录 \(url.lastPathComponent)") }
        guard (info.st_mode & S_IFMT) == S_IFDIR else { throw Failure(message: "\(url.lastPathComponent) 不是普通目录") }
        guard info.st_uid == getuid() else { throw Failure(message: "\(url.lastPathComponent) 不属于当前用户") }
        if (info.st_mode & 0o777) != 0o700, chmod(path, 0o700) != 0 {
            throw Failure(message: "无法把目录 \(url.lastPathComponent) 设为仅本人可访问")
        }
    }

    static func writeAtomically(_ data: Data, to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        let temp = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure(message: "无法写入 \(url.lastPathComponent)") }
        var ok = fchmod(fd, 0o600) == 0
        if ok {
            ok = data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> Bool in
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
        }
        if ok { ok = fsync(fd) == 0 }
        close(fd)
        guard ok, rename(temp.path, url.path) == 0 else {
            unlink(temp.path)
            throw Failure(message: "无法写入 \(url.lastPathComponent)")
        }
    }

    /// 只读取属于当前用户的普通文件（不跟随符号链接）；不存在或不符合时返回 nil。
    static func readRegularFile(_ url: URL, maxBytes: Int) -> Data? {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == getuid(),
              info.st_size >= 0, info.st_size <= off_t(maxBytes)
        else { return nil }
        var data = Data(count: Int(info.st_size))
        let complete = data.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) -> Bool in
            var offset = 0
            while offset < buffer.count {
                let count = read(fd, buffer.baseAddress! + offset, buffer.count - offset)
                if count < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                if count == 0 { break }
                offset += count
            }
            return offset == buffer.count
        }
        return complete ? data : nil
    }

    /// 文件权限是否恰好为 0600（测试与自检用）。
    static func permissions(of url: URL) -> mode_t? {
        var info = stat()
        guard lstat(url.path, &info) == 0 else { return nil }
        return info.st_mode & 0o777
    }
}
