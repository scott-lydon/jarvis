// JarvisAppMain.swift
//
// SwiftUI app entry point. Imports the `Jarvis` library and hosts the
// single root view. The split into Jarvis (library) + JarvisApp
// (executable) keeps unit tests buildable without the @main attribute
// fighting the test bundle.

import SwiftUI
import Jarvis

@main
struct JarvisApp: App {
    var body: some Scene {
        WindowGroup {
            JarvisView()
                // Force English regardless of device locale (the server
                // session is hard-pinned to English by F5).
                .environment(\.locale, Locale(identifier: "en_US"))
                .preferredColorScheme(.dark)
        }
    }
}
