import SwiftUI
import WebKit

/// 把账号列表、网页池和界面串起来：切换、添加、删除、改名，以及截图、预热、兜底按钮。
@MainActor
final class AppModel: ObservableObject {
    let store = AccountStore()
    private let pool = WebViewPool()
    private weak var container: WebContainerController?

    @Published var showSwitcher = false
    /// 页面里找不到「邀请」按钮时显示的原生按钮
    @Published private(set) var fallbackVisible = false
    /// 正盖着截图：页面里的按钮还没渲染，右上角由原生透明按钮接住点击
    @Published private(set) var covered = false
    /// 已加载在内存里的账号（切过去秒开）
    @Published private(set) var loadedIDs: Set<UUID> = []

    /// 每个账号页面里的替换按钮状态：true 找到了，false 找不到，nil 还没报告
    private var buttonOK: [UUID: Bool] = [:]
    private var fallbackTimer: Task<Void, Never>?
    private var prewarmTask: Task<Void, Never>?
    private var uncoverTask: Task<Void, Never>?

    init() {
        pool.delegate = self
        for a in store.accounts where a.isPinned { pool.setPinned(a.id, true) }
        if store.accounts.isEmpty { store.select(store.add().id) }
        NotificationCenter.default.addObserver(forName: UIResponder.keyboardDidHideNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.container?.resetScroll() }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.trimMemory() }
        }
        SnapshotStore.prune(keeping: Set(store.accounts.map(\.id)))
        // 上次添加后没登录就退出的空账号：清掉（当前账号除外，可能正要登录）
        for a in store.accounts where a.loggedIn == false && a.id != store.currentID { discard(a.id) }
        // 旧版本建的账号没有登录记录：按存储里有没有会话 Cookie 判断，没登录过的同样清掉
        for a in store.accounts where a.loggedIn == nil { checkSession(a.id, discardIfNone: true) }
        #if DEBUG
        // 模拟器里截图检查列表用
        if ProcessInfo.processInfo.arguments.contains("-openSwitcher") { showSwitcher = true }
        // 模拟器里每 10 秒依次切到下一个账号，用来测切换和内存
        if ProcessInfo.processInfo.arguments.contains("-cycle") {
            Task { [weak self] in
                while true {
                    try? await Task.sleep(for: .seconds(10))
                    guard let self, let cur = self.currentID,
                          let i = self.store.accounts.firstIndex(where: { $0.id == cur }) else { return }
                    let next = self.store.accounts[(i + 1) % self.store.accounts.count]
                    print("[cycle] -> \(next.name) warm=\(self.pool.has(next.id))")
                    self.select(next.id)
                }
            }
        }
        #endif
    }

    var currentID: UUID? { store.currentID }

    func attach(_ vc: WebContainerController) {
        container = vc
        if let id = currentID { present(id, cover: SnapshotStore.load(id)) }
    }

    // MARK: 账号操作

    func select(_ id: UUID) {
        guard id != currentID else { return }
        let previous = store.current
        saveSnapshot()
        store.select(id)
        let warm = pool.has(id) && !pool.isLoading(id)
        present(id, cover: warm ? nil : SnapshotStore.load(id))
        // 添加后没登录就切走的空账号：直接删掉
        if let previous, previous.loggedIn == false { discard(previous.id) }
    }

    func addAccount() {
        let a = store.add()
        select(a.id)
    }

    func rename(_ id: UUID, to name: String) {
        store.rename(id, to: name)
        if let a = store.account(id) { pool.setBadge(for: a) }
    }

    func move(from source: IndexSet, to destination: Int) {
        store.moveListed(from: source, to: destination)
    }

    /// 长按菜单「加载」：后台打开并常驻
    func load(_ id: UUID) {
        guard let a = store.account(id) else { return }
        store.setKeepLoaded(id, true)
        pool.setPinned(id, true)
        if !pool.has(id) {
            buttonOK[id] = nil
            pool.prewarm(a)
        }
        refreshLoaded()
    }

    /// 长按菜单「挂起」：取消常驻并释放页面。挂起当前账号时先切到最近用过的另一个账号
    func suspend(_ id: UUID) {
        store.setKeepLoaded(id, false)
        pool.setPinned(id, false)
        if id == currentID {
            guard let other = store.recentOther else { return }
            select(other.id)
        }
        pool.drop(id)
        buttonOK[id] = nil
        refreshLoaded()
    }

    /// 打开账号列表。当前账号如果还没确认登录过，先查一下会话 Cookie（可能刚登录完，页面还没报告）
    func openSwitcher() {
        if let a = store.current, a.loggedIn != true { checkSession(a.id) }
        showSwitcher = true
    }

    private func checkSession(_ id: UUID, discardIfNone: Bool = false) {
        let name = Rules.shared.sessionCookie
        WKWebsiteDataStore(forIdentifier: id).httpCookieStore.getAllCookies { [weak self] cookies in
            let on = cookies.contains { $0.name == name && $0.domain.hasSuffix("muse.ai") }
            MainActor.assumeIsolated {
                guard let self else { return }
                self.store.setLoggedIn(id, on)
                if !on && discardIfNone && id != self.currentID { self.discard(id) }
                if id == self.currentID { self.updateFallback() }
            }
        }
    }

    /// 能否挂起：当前账号要有别的账号可切过去
    func canSuspend(_ id: UUID) -> Bool { id != currentID || store.recentOther != nil }

    /// 删除没登录过的空账号（没有截图、没有排序意义，不需要确认）
    private func discard(_ id: UUID) {
        pool.setPinned(id, false)
        pool.drop(id)
        buttonOK[id] = nil
        store.remove(id)
        SnapshotStore.remove(id)
        refreshLoaded()
        Task {
            try? await Task.sleep(for: .milliseconds(500))
            try? await WKWebsiteDataStore.remove(forIdentifier: id)
        }
    }

    /// 删除账号，连同它的登录数据和截图
    func delete(_ id: UUID) {
        let wasCurrent = id == currentID
        pool.setPinned(id, false)
        pool.drop(id)
        buttonOK[id] = nil
        store.remove(id)
        SnapshotStore.remove(id)
        refreshLoaded()
        Task {
            // webview 释放后数据存储才能删除，稍等一下再删
            try? await Task.sleep(for: .milliseconds(500))
            try? await WKWebsiteDataStore.remove(forIdentifier: id)
        }
        if store.accounts.isEmpty { store.select(store.add().id) }
        if wasCurrent, let next = currentID { present(next, cover: SnapshotStore.load(next)) }
    }

    // MARK: 生命周期

    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .inactive:
            saveSnapshot()
        case .background:
            prewarmTask?.cancel()
            for id in pool.loadedIDs { pool.pauseMedia(id) }
        default:
            break
        }
    }

    private func trimMemory() {
        pool.dropAll(except: currentID)
        refreshLoaded()
    }

    // MARK: 内部

    private func present(_ id: UUID, cover: UIImage?) {
        guard let container, let account = store.account(id) else { return }
        if !pool.has(id) { buttonOK[id] = nil } // 新建的页面要重新报告，不能沿用被淘汰那个页面的状态
        let wv = pool.webView(for: account)
        container.show(wv, cover: cover)
        covered = cover != nil
        container.setLoading(pool.isLoading(id) && cover == nil)
        refreshLoaded()
        updateFallback()
        if !pool.isLoading(id) { setCover(nil); container.setLoading(false); schedulePrewarm() }
    }

    private func saveSnapshot() {
        // 没登录过的账号停在登录页，不值得截图（切走后还会被删掉）
        guard let id = currentID, let container, store.current?.loggedIn != false else { return }
        container.snapshot { image in
            if let image { SnapshotStore.save(image, for: id) }
        }
    }

    private func setCover(_ image: UIImage?) {
        container?.setCover(image)
        covered = image != nil
    }

    private func refreshLoaded() { loadedIDs = pool.loadedIDs }

    /// 当前页加载完、空闲 3 秒后，在后台依次加载：先是常驻账号（每个间隔 2 秒，不和当前页抢网络），
    /// 再预热最近用过的另一个账号。低电量模式下只加载常驻账号。
    private func schedulePrewarm() {
        prewarmTask?.cancel()
        prewarmTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self else { return }
            for a in self.store.accounts where a.isPinned && a.isListed && !self.pool.has(a.id) {
                guard !Task.isCancelled, UIApplication.shared.applicationState == .active else { return }
                self.buttonOK[a.id] = nil
                self.pool.prewarm(a)
                self.refreshLoaded()
                try? await Task.sleep(for: .seconds(2))
            }
            guard !Task.isCancelled,
                  !ProcessInfo.processInfo.isLowPowerModeEnabled,
                  UIApplication.shared.applicationState == .active,
                  let other = self.store.recentOther, !self.pool.has(other.id) else { return }
            self.pool.prewarm(other)
            self.refreshLoaded()
        }
    }

    private func updateFallback() {
        fallbackTimer?.cancel()
        guard let id = currentID else { fallbackVisible = false; return }
        if pool.failed.contains(id) { fallbackVisible = true; return }
        // 新加、还没登录的账号停在登录页，页面里没有头像按钮：直接显示兜底按钮
        if store.account(id)?.loggedIn == false && buttonOK[id] != true { fallbackVisible = true; return }
        switch buttonOK[id] {
        case true?: fallbackVisible = false
        case false?: fallbackVisible = true
        case nil:
            // 页面还没报告（正在加载）。页面自己 30 秒内一定会报告；这里只防脚本根本没跑起来
            fallbackVisible = false
            fallbackTimer = Task { [weak self] in
                try? await Task.sleep(for: .seconds(40))
                guard let self, !Task.isCancelled, self.currentID == id, self.buttonOK[id] == nil else { return }
                self.fallbackVisible = true
            }
        }
    }
}

extension AppModel: WebViewPoolDelegate {
    func pool(_ pool: WebViewPool, didFinishLoading id: UUID) {
        guard id == currentID else { return }
        container?.setLoading(false)
        updateFallback()
        // 页面加载完时 muse.ai 往往还在确认登录状态（会先闪一下登录页），右上角按钮也还没渲染。
        // 截图要等页面报告按钮状态后再揭开（页面最迟 12 秒报告）；加载失败时立刻揭开。
        if pool.failed.contains(id) || buttonOK[id] != nil { uncover(id, after: .milliseconds(150)); return }
        uncover(id, after: .seconds(14))
    }

    /// 揭开截图和加载圈，并开始预热
    private func uncover(_ id: UUID, after delay: Duration) {
        uncoverTask?.cancel()
        uncoverTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled, self.currentID == id else { return }
            self.setCover(nil)
            self.container?.setLoading(false)
            self.schedulePrewarm()
        }
    }

    func pool(_ pool: WebViewPool, processTerminated id: UUID) {
        buttonOK[id] = nil
        guard id == currentID else { return }
        let snap = SnapshotStore.load(id)
        setCover(snap)
        container?.setLoading(snap == nil)
        updateFallback()
    }

    func pool(_ pool: WebViewPool, message: [String: Any], from id: UUID) {
        switch message["type"] as? String {
        case "switcher":
            if id == currentID { openSwitcher() }
        case "button":
            buttonOK[id] = message["ok"] as? Bool ?? false
            if id == currentID {
                updateFallback()
                if !pool.isLoading(id) { uncover(id, after: .milliseconds(150)) }
            }
        case "session":
            store.setLoggedIn(id, message["loggedIn"] as? Bool ?? false)
            if id == currentID { updateFallback() }
        case "dump":
            // 调试用：写到 App 的 Documents，Mac 上用 devicectl 取回
            let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let name = store.account(id)?.name ?? id.uuidString
            try? (message["text"] as? String ?? "").write(to: dir.appendingPathComponent("dump-\(name).txt"),
                                                          atomically: true, encoding: .utf8)
        default:
            break
        }
    }
}
