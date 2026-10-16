import Foundation

struct Account: Codable, Identifiable, Equatable {
    let id: UUID
    var name: String
    var lastUsedAt: Date
    /// 用户在长按菜单里点了「加载」：页面常驻后台，不被自动淘汰，下次启动也自动加载
    var keepLoaded: Bool?

    var isPinned: Bool { keepLoaded == true }

    /// 是否登录过：true 页面检测到登录后的界面；false 新建后还没登录过；nil 旧版本建的、还没检测过。
    /// 没登录过的账号不进列表、不预热，切走时自动删除。
    var loggedIn: Bool?

    var isListed: Bool { loggedIn != false }

    /// 头像上显示的字：名字的第一个字母（大写）或汉字
    var initial: String { name.first.map { String($0).uppercased() } ?? "?" }

    /// 头像底色：按 UUID 固定取色，改名不变色。账号列表和页面右上角共用
    var colorHex: String {
        let palette = ["#007AFF", "#AF52DE", "#FF2D55", "#FF9500", "#30B0C7", "#5856D6", "#34C759", "#A2845E"]
        return palette[Int(id.uuid.0) % palette.count]
    }
}

/// 账号列表和当前账号。存在 Application Support/accounts.json，每次修改整份原子写入。
/// 列表顺序就是显示顺序；登录数据不在这里，在按账号 UUID 区分的 WKWebsiteDataStore 里。
@MainActor
final class AccountStore: ObservableObject {
    @Published private(set) var accounts: [Account] = []
    @Published private(set) var currentID: UUID?

    private struct State: Codable {
        var accounts: [Account]
        var currentID: UUID?
    }

    private let url: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("accounts.json")
    }()

    init() {
        if let data = try? Data(contentsOf: url), let s = try? JSONDecoder().decode(State.self, from: data) {
            accounts = s.accounts
            currentID = s.currentID ?? s.accounts.first?.id
        }
    }

    var current: Account? { accounts.first { $0.id == currentID } }

    func account(_ id: UUID) -> Account? { accounts.first { $0.id == id } }

    /// 除当前账号外，最近用过的、登录过的那个（用来预热，以及挂起当前账号后切过去）
    var recentOther: Account? {
        accounts.filter { $0.id != currentID && $0.isListed }.max { $0.lastUsedAt < $1.lastUsedAt }
    }

    /// 列表里显示的账号（登录过的）
    var listed: [Account] { accounts.filter(\.isListed) }

    @discardableResult
    func add() -> Account {
        let n = (1...).first { i in !accounts.contains { $0.name == "账号 \(i)" } }!
        let a = Account(id: UUID(), name: "账号 \(n)", lastUsedAt: .now, loggedIn: false)
        accounts.append(a)
        save()
        return a
    }

    func select(_ id: UUID) {
        guard let i = accounts.firstIndex(where: { $0.id == id }) else { return }
        accounts[i].lastUsedAt = .now
        currentID = id
        save()
    }

    func rename(_ id: UUID, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let i = accounts.firstIndex(where: { $0.id == id }) else { return }
        accounts[i].name = trimmed
        save()
    }

    func setKeepLoaded(_ id: UUID, _ on: Bool) {
        guard let i = accounts.firstIndex(where: { $0.id == id }) else { return }
        accounts[i].keepLoaded = on ? true : nil
        save()
    }

    /// 页面报告的登录状态。旧账号（nil）第一次检测到未登录，按「从没登录过」处理；登录过的账号之后掉线不改
    func setLoggedIn(_ id: UUID, _ on: Bool) {
        guard let i = accounts.firstIndex(where: { $0.id == id }) else { return }
        let next: Bool? = on ? true : (accounts[i].loggedIn == true ? true : false)
        guard accounts[i].loggedIn != next else { return }
        accounts[i].loggedIn = next
        save()
    }

    /// 在列表（只含登录过的账号）里拖动排序；不显示的账号排在最后
    func moveListed(from source: IndexSet, to destination: Int) {
        var shown = listed
        shown.move(fromOffsets: source, toOffset: destination)
        accounts = shown + accounts.filter { !$0.isListed }
        save()
    }

    func remove(_ id: UUID) {
        accounts.removeAll { $0.id == id }
        if currentID == id { currentID = (listed.isEmpty ? accounts : listed).max { $0.lastUsedAt < $1.lastUsedAt }?.id }
        save()
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(State(accounts: accounts, currentID: currentID)) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
