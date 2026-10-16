import Foundation

/// rules.json：选择器和排版规则。页面改版时只改这份文件。
struct Rules {
    let homeURL: URL
    let blockedHosts: Set<String>
    /// 登录后才有的会话 Cookie 名，用来判断账号是否登录过
    let sessionCookie: String
    /// 原样嵌进注入脚本的 JSON 文本
    let json: String

    static let shared: Rules = {
        let url = Bundle.main.url(forResource: "rules", withExtension: "json")!
        let data = try! Data(contentsOf: url)
        let obj = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        return Rules(
            homeURL: URL(string: obj["homeUrl"] as? String ?? "https://muse.ai/")!,
            blockedHosts: Set(obj["blockedHosts"] as? [String] ?? []),
            sessionCookie: obj["sessionCookie"] as? String ?? "hatch_sess",
            json: String(decoding: data, as: UTF8.self)
        )
    }()

    static let script: String = {
        let url = Bundle.main.url(forResource: "muse-ios", withExtension: "js")!
        let src = try! String(contentsOf: url, encoding: .utf8)
        return src.replacingOccurrences(of: "__RULES__", with: shared.json)
    }()
}
