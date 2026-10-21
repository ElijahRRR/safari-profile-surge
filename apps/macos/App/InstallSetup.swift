import Foundation
import Security

/// 本机路径（宿主 App 未沙盒，主目录即用户主目录）。
enum InstallPaths {
    static var dataDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent("SafariProfileSurge", isDirectory: true)
    }

    static var maintenanceSocket: String {
        dataDirectory.appendingPathComponent("maintenance.sock").path
    }

    static var keychainHelper: URL {
        Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/sfe-keychain", isDirectory: false)
    }

    static var webRoot: URL {
        Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/service/web", isDirectory: true)
    }
}

/// 启动时的安装准备（幂等，每次启动执行）：
/// 1. App Group 容器中的 bridge.json 与 bridge.token（32 字节随机，base64url，0600）——已有且有效时沿用；
/// 2. 数据目录（0700）中的 bridge.token 副本（0600），供 LaunchAgent 启动的服务读取，服务从不访问 App Group 容器；
/// 3. 数据目录中的 install.json（0600）。
/// 令牌从不记录、打印或放进错误信息。
enum InstallSetup {
    struct Failure: Error {
        let message: String
    }

    struct Summary {
        let bridgePort: UInt16
        let tokenCreated: Bool
    }

    static let tokenByteCount = 32

    @discardableResult
    static func run(bundle: Bundle = .main) throws -> Summary {
        guard let container = BridgeFiles.containerURL(bundle: bundle) else {
            throw Failure(message: "准备原生桥失败：无法访问 App Group 容器，请检查签名设置")
        }
        let configURL = container.appendingPathComponent(BridgeFiles.configFileName)
        let tokenURL = container.appendingPathComponent(BridgeFiles.tokenFileName)

        let existingEndpoint = SecureFile.readRegularFile(configURL, maxBytes: BridgeFiles.maxConfigBytes).flatMap(BridgeFiles.parseConfig)
        let existingToken = SecureFile.readRegularFile(tokenURL, maxBytes: BridgeFiles.maxTokenBytes).flatMap(BridgeFiles.parseToken)
        let endpoint = existingEndpoint ?? BridgeEndpoint(port: NativeBridge.defaultPort)

        let token: String
        let tokenCreated: Bool
        if let existingToken {
            token = existingToken
            tokenCreated = false
        } else {
            token = try makeToken()
            tokenCreated = true
        }

        do {
            if existingEndpoint == nil { try SecureFile.writeAtomically(BridgeFiles.encodeConfig(endpoint), to: configURL) }
            if tokenCreated { try SecureFile.writeAtomically(Data(token.utf8), to: tokenURL) }
        } catch {
            throw Failure(message: "准备原生桥失败：无法写入 App Group 容器")
        }

        let dataDirectory = InstallPaths.dataDirectory
        do {
            try SecureFile.ensurePrivateDirectory(dataDirectory)
        } catch let failure as SecureFile.Failure {
            throw Failure(message: "准备数据目录失败：\(failure.message)")
        }

        let serviceTokenURL = dataDirectory.appendingPathComponent(BridgeFiles.tokenFileName)
        let serviceToken = SecureFile.readRegularFile(serviceTokenURL, maxBytes: BridgeFiles.maxTokenBytes).flatMap(BridgeFiles.parseToken)
        if serviceToken != token {
            do {
                try SecureFile.writeAtomically(Data(token.utf8), to: serviceTokenURL)
            } catch {
                throw Failure(message: "准备数据目录失败：无法写入原生桥令牌")
            }
        }

        try writeInstallConfig(dataDirectory: dataDirectory, bridgePort: endpoint.port, bundle: bundle)
        return Summary(bridgePort: endpoint.port, tokenCreated: tokenCreated)
    }

    private static func makeToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: tokenByteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw Failure(message: "准备原生桥失败：无法生成随机令牌") }
        defer { for index in bytes.indices { bytes[index] = 0 } }
        return BridgeFiles.base64URL(bytes)
    }

    private static func writeInstallConfig(dataDirectory: URL, bridgePort: UInt16, bundle: Bundle) throws {
        let url = dataDirectory.appendingPathComponent(InstallConfig.fileName)
        let existing = SecureFile.readRegularFile(url, maxBytes: 64 * 1024).flatMap(JSONLine.decodeObject)
        let fileManager = FileManager.default
        let fields = InstallConfig.Fields(
            surgeCliPath: fileManager.isExecutableFile(atPath: InstallConfig.defaultSurgeCLIPath) ? InstallConfig.defaultSurgeCLIPath : nil,
            keychainHelperPath: InstallPaths.keychainHelper.path,
            nodeVersionPin: bundle.object(forInfoDictionaryKey: "SFENodeVersion") as? String,
            bridgePort: bridgePort,
            webRoot: fileManager.fileExists(atPath: InstallPaths.webRoot.path) ? InstallPaths.webRoot.path : nil
        )
        let merged = InstallConfig.merged(existing: existing, fields: fields)
        guard let data = JSONLine.encode(merged) else { throw Failure(message: "写入安装配置失败：内容格式不正确") }
        do {
            try SecureFile.writeAtomically(data, to: url)
        } catch {
            throw Failure(message: "写入安装配置失败：无法写入 install.json")
        }
    }
}
