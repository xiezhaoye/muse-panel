import UIKit

/// 每个账号最后一屏的截图，存在 Caches 里。切到未加载的账号、冷启动、网页进程被系统回收时，
/// 先盖一张截图，页面加载好再揭开，用户不会看到白屏。
enum SnapshotStore {
    private static let dir: URL = {
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("snapshots", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    private static func file(_ id: UUID) -> URL { dir.appendingPathComponent("\(id.uuidString).jpg") }

    static func load(_ id: UUID) -> UIImage? { UIImage(contentsOfFile: file(id).path) }

    static func save(_ image: UIImage, for id: UUID) {
        guard let data = image.jpegData(compressionQuality: 0.6) else { return }
        let url = file(id)
        DispatchQueue.global(qos: .utility).async { try? data.write(to: url, options: .atomic) }
    }

    static func remove(_ id: UUID) { try? FileManager.default.removeItem(at: file(id)) }

    /// 删掉不属于任何账号的截图
    static func prune(keeping ids: Set<UUID>) {
        let keep = Set(ids.map { "\($0.uuidString).jpg" })
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        for f in files where !keep.contains(f) { try? FileManager.default.removeItem(at: dir.appendingPathComponent(f)) }
    }
}
