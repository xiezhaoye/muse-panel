import UIKit
import WebKit

@MainActor
protocol WebViewPoolDelegate: AnyObject {
    func pool(_ pool: WebViewPool, didFinishLoading id: UUID)
    func pool(_ pool: WebViewPool, processTerminated id: UUID)
    func pool(_ pool: WebViewPool, message: [String: Any], from id: UUID)
}

/// 自动保留的 WKWebView 最多 `capacity` 个（含当前），按最近使用淘汰；用户手动「加载」的常驻，不计入也不淘汰。
/// 每个账号一份 WKWebsiteDataStore(forIdentifier: 账号 UUID)，登录状态互相隔离并保存在本机；
/// 淘汰的只是页面进程，登录数据还在，下次打开重新加载即可。
@MainActor
final class WebViewPool: NSObject {
    static let capacity = 2

    weak var delegate: WebViewPoolDelegate?
    private var views: [UUID: WKWebView] = [:]
    /// 最近使用的在后面
    private var order: [UUID] = []
    private var loading: Set<UUID> = []
    /// 常驻的账号（用户手动「加载」）
    private(set) var pinned: Set<UUID> = []
    /// 在后台被系统回收了网页进程的页面：不立刻重载（避免内存紧张时反复重启），等切过去时再重载
    private var needsReload: Set<UUID> = []
    /// 最新的名字和颜色：用户脚本在创建时就定死了，改名后页面重新加载要靠这里补上
    private var badges: [UUID: Account] = [:]

    private static let userAgentSuffix: String = {
        // 补上手机 Safari 的 UA 结尾，避免登录页把内嵌网页当成不受信任的浏览器
        let v = UIDevice.current.systemVersion.split(separator: ".").prefix(2).joined(separator: ".")
        return "Version/\(v) Mobile/15E148 Safari/604.1"
    }()

    /// 最近一次加载失败（断网等）的账号：页面里没有脚本可以报告按钮状态，直接显示兜底按钮
    private(set) var failed: Set<UUID> = []

    func has(_ id: UUID) -> Bool { views[id] != nil }
    func isLoading(_ id: UUID) -> Bool { loading.contains(id) }
    var loadedIDs: Set<UUID> { Set(views.keys) }

    /// 取出（必要时创建并开始加载）账号的 webview，并标记为最近使用。
    func webView(for account: Account) -> WKWebView {
        let id = account.id
        if let wv = views[id] {
            touch(id)
            if needsReload.remove(id) != nil {
                loading.insert(id)
                wv.reload()
            }
            return wv
        }
        let wv = make(account)
        views[id] = wv
        touch(id)
        evict(keeping: id)
        return wv
    }

    /// 后台预热：创建并加载，但排在最久未用的位置，下次需要腾位置时先被淘汰。
    func prewarm(_ account: Account) {
        let id = account.id
        guard views[id] == nil else { return }
        views[id] = make(account)
        order.insert(id, at: 0)
        evict(keeping: id)
    }

    func drop(_ id: UUID) {
        guard let wv = views.removeValue(forKey: id) else { return }
        badges[id] = nil
        failed.remove(id)
        needsReload.remove(id)
        order.removeAll { $0 == id }
        loading.remove(id)
        wv.stopLoading()
        wv.navigationDelegate = nil
        wv.uiDelegate = nil
        wv.configuration.userContentController.removeAllScriptMessageHandlers()
        wv.removeFromSuperview()
    }

    /// 内存警告时调用：释放自动保留的页面，只留当前账号和常驻账号
    func dropAll(except keep: UUID?) {
        for id in views.keys where id != keep && !pinned.contains(id) { drop(id) }
    }

    func setPinned(_ id: UUID, _ on: Bool) {
        if on { pinned.insert(id) } else { pinned.remove(id) }
    }

    func setBadge(for account: Account) {
        badges[account.id] = account
        views[account.id]?.evaluateJavaScript("\(Self.badgeJS(account)); window.__musePanelSetBadge && window.__musePanelSetBadge(window.__musePanelBadge)")
    }

    private static func badgeJS(_ a: Account) -> String {
        let json = (try? JSONSerialization.data(withJSONObject: ["text": a.initial, "color": a.colorHex]))
            .map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        return "window.__musePanelBadge = \(json)"
    }

    func pauseMedia(_ id: UUID) {
        views[id]?.evaluateJavaScript("window.__musePanelPauseMedia && window.__musePanelPauseMedia()")
    }

    private func touch(_ id: UUID) {
        order.removeAll { $0 == id }
        order.append(id)
    }

    private func evict(keeping id: UUID) {
        func autoCount() -> Int { views.keys.filter { !pinned.contains($0) || $0 == id }.count }
        while autoCount() > Self.capacity,
              let victim = order.first(where: { $0 != id && !pinned.contains($0) }) {
            drop(victim)
        }
    }

    private func make(_ account: Account) -> WKWebView {
        let id = account.id
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = WKWebsiteDataStore(forIdentifier: id)
        cfg.applicationNameForUserAgent = Self.userAgentSuffix
        cfg.allowsInlineMediaPlayback = true
        // 媒体必须由用户手势触发才播放：头像视频不会自动循环播放，省电
        cfg.mediaTypesRequiringUserActionForPlayback = .all

        let ucc = cfg.userContentController
        badges[id] = account
        ucc.addUserScript(WKUserScript(source: Self.badgeJS(account),
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addUserScript(WKUserScript(source: Rules.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.add(WeakMessageHandler(self), name: "panel")

        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = true
        wv.isInspectable = true // Mac 上用 Safari「开发」菜单调试
        wv.translatesAutoresizingMaskIntoConstraints = false
        loading.insert(id)
        wv.load(URLRequest(url: Rules.shared.homeURL))
        return wv
    }

    private func id(of webView: WKWebView?) -> UUID? {
        guard let webView else { return nil }
        return views.first { $0.value === webView }?.key
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard let id = id(of: message.webView), let body = message.body as? [String: Any] else { return }
        delegate?.pool(self, message: body, from: id)
    }
}

extension WebViewPool: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let id = id(of: webView) else { return }
        loading.remove(id)
        failed.remove(id)
        if let a = badges[id] { setBadge(for: a) }
        delegate?.pool(self, didFinishLoading: id)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard let id = id(of: webView) else { return }
        loading.remove(id)
        failed.insert(id)
        delegate?.pool(self, didFinishLoading: id)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard let id = id(of: webView) else { return }
        loading.remove(id)
        failed.insert(id)
        delegate?.pool(self, didFinishLoading: id)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // 系统回收了网页进程（多半是内存紧张）：重新加载，登录状态不受影响
        guard let id = id(of: webView) else { return }
        delegate?.pool(self, processTerminated: id)
        if webView.window == nil {
            needsReload.insert(id)
        } else {
            loading.insert(id)
            webView.reload()
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.allow); return
        }
        // 不跳 App Store，也不唤起其他 App（如「在 Muse App 中打开」）
        if ["http", "https", "about", "blob", "data"].contains(scheme) {
            decisionHandler(Rules.shared.blockedHosts.contains(url.host ?? "") ? .cancel : .allow)
        } else {
            decisionHandler(.cancel)
        }
    }

    /// target=_blank 的链接在当前页面打开
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil { webView.load(action.request) }
        return nil
    }
}

/// WKUserContentController 会强引用消息处理者；用弱引用中转，避免 webview 和池互相持有
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var pool: WebViewPool?
    init(_ pool: WebViewPool) { self.pool = pool }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { pool?.receive(message) }
    }
}
