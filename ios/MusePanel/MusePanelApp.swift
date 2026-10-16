import SwiftUI

@main
struct MusePanelApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .onChange(of: scenePhase) { _, phase in model.scenePhaseChanged(phase) }
        }
    }
}

struct RootView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        WebContainer(model: model)
            .ignoresSafeArea(edges: .bottom)
            .overlay(alignment: .topTrailing) {
                if model.covered && !model.fallbackVisible {
                    // 盖着截图时，截图里的头像还不能点：在同一位置放一个透明按钮
                    Color.clear
                        .frame(width: 52, height: 52)
                        .contentShape(Rectangle())
                        .onTapGesture { model.openSwitcher() }
                        .padding(.top, 2)
                        .padding(.trailing, 2)
                }
                if model.fallbackVisible {
                    // 页面里找不到「邀请」按钮（改版、登录页等）时的兜底入口
                    Button { model.openSwitcher() } label: {
                        Image(systemName: "person.2.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .frame(width: 36, height: 36)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .accessibilityLabel("切换账号")
                    .padding(.top, 6)
                    .padding(.trailing, 10)
                    .transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: model.fallbackVisible)
            .sheet(isPresented: $model.showSwitcher) {
                AccountSwitcher(model: model)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
    }
}
