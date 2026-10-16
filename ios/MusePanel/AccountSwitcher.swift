import SwiftUI

/// 底部弹出的账号列表：点一下切换，左滑删除，长按改名，编辑模式下拖动排序。
struct AccountSwitcher: View {
    @ObservedObject var model: AppModel
    @ObservedObject var store: AccountStore
    @Environment(\.dismiss) private var dismiss

    @State private var renaming: Account?
    @State private var newName = ""
    @State private var deleting: Account?
    @State private var editMode: EditMode = .inactive

    init(model: AppModel) {
        self.model = model
        self.store = model.store
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(store.listed) { a in
                        row(a)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                model.select(a.id)
                                dismiss()
                            }
                            .contextMenu {
                                if a.isPinned || model.loadedIDs.contains(a.id) {
                                    Button("挂起", systemImage: "pause.circle") { model.suspend(a.id) }
                                        .disabled(!model.canSuspend(a.id))
                                } else {
                                    Button("加载", systemImage: "arrow.down.circle") { model.load(a.id) }
                                }
                                Button("改名", systemImage: "pencil") { startRename(a) }
                                Button("删除", systemImage: "trash", role: .destructive) { deleting = a }
                            }
                            .swipeActions {
                                Button("删除", role: .destructive) { deleting = a }
                                Button("改名") { startRename(a) }.tint(.orange)
                            }
                    }
                    .onMove { model.move(from: $0, to: $1) }
                }
                Section {
                    Button {
                        model.addAccount()
                        dismiss()
                    } label: {
                        Label("添加账号", systemImage: "plus.circle.fill")
                    }
                }
            }
            .environment(\.editMode, $editMode)
            .navigationTitle("账号")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(editMode.isEditing ? "完成排序" : "排序") {
                        withAnimation { editMode = editMode.isEditing ? .inactive : .active }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) { Button("完成") { dismiss() } }
            }
            .alert("改名", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("名字", text: $newName)
                Button("取消", role: .cancel) {}
                Button("保存") { if let a = renaming { model.rename(a.id, to: newName) } }
            }
            .confirmationDialog(
                "删除「\(deleting?.name ?? "")」？",
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                titleVisibility: .visible
            ) {
                Button("删除账号和登录数据", role: .destructive) { if let a = deleting { model.delete(a.id) } }
            } message: {
                Text("这台手机上该账号的登录状态会被清除，之后需要重新登录。")
            }
        }
    }

    private func row(_ a: Account) -> some View {
        let isCurrent = a.id == store.currentID
        return HStack(spacing: 12) {
            Text(a.initial)
                .font(.headline)
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(Circle().fill(Color(hex: a.colorHex)))
            VStack(alignment: .leading, spacing: 2) {
                Text(a.name).font(.body)
                if a.isPinned {
                    HStack(spacing: 3) {
                        Image(systemName: "pin.fill").imageScale(.small)
                        Text("常驻")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                } else if model.loadedIDs.contains(a.id) && !isCurrent {
                    Text("已加载").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if isCurrent {
                Image(systemName: "checkmark").foregroundStyle(.tint).fontWeight(.semibold)
            }
        }
        .padding(.vertical, 2)
    }

    private func startRename(_ a: Account) {
        newName = a.name
        renaming = a
    }
}

extension Color {
    init(hex: String) {
        let v = UInt64(hex.dropFirst(), radix: 16) ?? 0
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}
