import SwiftUI
import WebKit

/// 只挂当前账号的 webview。其他留在池里的 webview 从界面上摘下来，WebKit 会停止渲染、降低定时器频率。
final class WebContainerController: UIViewController {
    private(set) var current: WKWebView?
    private let cover = UIImageView()
    private let spinner = UIActivityIndicatorView(style: .medium)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        cover.contentMode = .scaleAspectFill
        cover.clipsToBounds = true
        cover.isHidden = true
        cover.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cover)
        pin(cover)
        spinner.hidesWhenStopped = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    /// 没有截图可盖时（新账号、从没打开过）显示加载指示
    func setLoading(_ loading: Bool) {
        if loading { spinner.startAnimating() } else { spinner.stopAnimating() }
    }

    func show(_ webView: WKWebView, cover image: UIImage?) {
        if webView !== current {
            current?.removeFromSuperview()
            view.insertSubview(webView, belowSubview: cover)
            pin(webView)
            current = webView
            view.backgroundColor = webView.underPageBackgroundColor
        }
        setCover(image)
    }

    /// 盖上或揭开截图；揭开时淡出
    func setCover(_ image: UIImage?) {
        if let image {
            cover.layer.removeAllAnimations()
            cover.image = image
            cover.alpha = 1
            cover.isHidden = false
        } else if !cover.isHidden {
            UIView.animate(withDuration: 0.2, animations: { self.cover.alpha = 0 }) { done in
                if done { self.cover.isHidden = true; self.cover.image = nil }
            }
        }
    }

    /// 收起键盘后把外层滚动位置复原（页面本身是整屏布局，外层不该有滚动偏移）
    func resetScroll() {
        guard let sv = current?.scrollView else { return }
        let top = CGPoint(x: 0, y: -sv.adjustedContentInset.top)
        if sv.contentOffset != top { sv.setContentOffset(top, animated: true) }
    }

    var isCovered: Bool { !cover.isHidden && cover.alpha > 0 }

    /// 当前页面截图（用于下次切回或冷启动时先显示）
    func snapshot(_ completion: @escaping (UIImage?) -> Void) {
        guard let wv = current, wv.bounds.width > 0, !isCovered else { completion(nil); return }
        wv.takeSnapshot(with: nil) { image, _ in completion(image) }
    }

    private func pin(_ v: UIView) {
        NSLayoutConstraint.activate([
            v.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            v.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            v.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            v.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }
}

struct WebContainer: UIViewControllerRepresentable {
    let model: AppModel

    func makeUIViewController(context: Context) -> WebContainerController {
        let vc = WebContainerController()
        model.attach(vc)
        return vc
    }

    func updateUIViewController(_ vc: WebContainerController, context: Context) {}
}
