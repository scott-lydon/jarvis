// JarvisView.swift
//
// SwiftUI surface: status pill, capability chip, big mic button, debug
// pane. Mirrors the web client's structure so onboarding between web and
// iOS is a single visual model.
//
// Style note: keep the view tree shallow; everything beyond cosmetics
// lives in the view model.

import SwiftUI

public struct JarvisView: View {
    @StateObject private var vm = JarvisViewModel()
    @State private var showSettings = false

    public init() {}

    public var body: some View {
        ZStack {
            background.ignoresSafeArea()
            VStack(spacing: 24) {
                topBar
                Spacer()
                statusPill
                Text(vm.caption)
                    .foregroundStyle(.secondary)
                    .font(.callout)
                    .multilineTextAlignment(.center)
                micButton
                Spacer()
                debugPane
            }
            .padding(24)
        }
        .sheet(isPresented: $showSettings) {
            JarvisSettingsView(initialURL: UserDefaults.standard.jarvisServerURL) { newURL in
                vm.setServerURL(newURL)
            }
        }
    }

    private var background: some View {
        LinearGradient(colors: [Color(.sRGB, red: 0.043, green: 0.047, blue: 0.063, opacity: 1),
                                Color.black],
                       startPoint: .top, endPoint: .bottom)
    }

    private var topBar: some View {
        HStack {
            Text("Jarvis")
                .font(.title3.weight(.semibold))
                .kerning(1.2)
            Spacer()
            Text(vm.capabilities.isEmpty ? "capabilities: loading…" : "capabilities: \(vm.capabilities.joined(separator: ", "))")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Color.white.opacity(0.06), in: Capsule())
                .lineLimit(1)
                .truncationMode(.tail)
            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .foregroundStyle(.secondary)
            }
            .accessibilityLabel("Settings")
        }
    }

    private var statusPill: some View {
        Text(vm.status.rawValue.uppercased())
            .font(.caption.weight(.semibold))
            .kerning(1.5)
            .padding(.horizontal, 14).padding(.vertical, 6)
            .background(Color.white.opacity(0.06), in: Capsule())
            .foregroundStyle(statusColor)
    }

    private var statusColor: Color {
        switch vm.status {
        case .idle: return .secondary
        case .listening: return Color(red: 0.36, green: 0.83, blue: 0.62)
        case .thinking, .speaking: return Color(red: 1.0, green: 0.62, blue: 0.0)
        case .error: return Color(red: 1.0, green: 0.36, blue: 0.36)
        }
    }

    private var micButton: some View {
        Button {
            switch vm.status {
            case .idle:
                vm.start()
            default:
                vm.stop()
            }
        } label: {
            HStack(spacing: 12) {
                Circle()
                    .fill(Color(red: 1.0, green: 0.62, blue: 0.0))
                    .frame(width: 10, height: 10)
                Text(vm.status == .idle ? "Tap to talk" : "Tap to stop")
                    .font(.headline)
            }
            .padding(.horizontal, 28).padding(.vertical, 18)
            .foregroundStyle(.white)
            .background(.thinMaterial, in: Capsule())
            .overlay(Capsule().stroke(Color.orange.opacity(vm.status == .idle ? 0.4 : 0.9), lineWidth: 1.5))
        }
        .buttonStyle(.plain)
    }

    private var debugPane: some View {
        DisclosureGroup("debug") {
            VStack(alignment: .leading, spacing: 12) {
                Group {
                    Text("connection: \(vm.connectionState)").font(.caption.monospaced())
                    Text("user: \(vm.activeUserId)").font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                }
                .foregroundStyle(.secondary)
                if !vm.lastToolResult.isEmpty {
                    Text("last tool result").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    ScrollView { Text(vm.lastToolResult).font(.caption2.monospaced()).foregroundStyle(.white.opacity(0.8)).frame(maxWidth: .infinity, alignment: .leading) }
                        .frame(maxHeight: 220)
                        .padding(8)
                        .background(Color.black.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .padding(.top, 6)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(10)
        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    }
}

/// Settings sheet — flips the server URL between local-dev and Render
/// without rebuilding. Conforms to the CLAUDE.md modal-overflow rule
/// (bounded height, scrollable body, sticky header via the OS).
public struct JarvisSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var urlText: String
    private let onSave: (URL) -> Void

    public init(initialURL: URL, onSave: @escaping (URL) -> Void) {
        _urlText = State(initialValue: initialURL.absoluteString)
        self.onSave = onSave
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section("Server URL") {
                    TextField("ws://host:port/realtime", text: $urlText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Text("Use ws:// for local dev (port 3000) and wss:// for the Render deploy.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("User ID (Keychain)") {
                    Text(Keychain.jarvisUserId).font(.caption.monospaced()).foregroundStyle(.secondary)
                    Button("Mint a fresh user ID") {
                        Keychain.setJarvisUserId(UUID().uuidString.lowercased())
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if let url = URL(string: urlText) {
                            onSave(url)
                        }
                        dismiss()
                    }
                }
            }
        }
    }
}
