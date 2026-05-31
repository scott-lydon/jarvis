# Jarvis iOS (Slice 10)

SwiftUI client for the Jarvis voice loop. Mirrors the web client's behaviour
(status pill, capability chip, mic button, debug pane) but uses AVAudioEngine
for capture and playback so audio quality matches what an on-site frontline
worker would expect on iPhone hardware.

## Layout

```
Package.swift              SwiftPM manifest — targets: Jarvis (library),
                           JarvisApp (executable @main), JarvisTests.
Sources/
  Jarvis/                  Reusable library, importable from JarvisApp.
    AudioEngineCoordinator.swift   AVAudioEngine capture + playback + barge-in.
    JarvisConfig.swift             UserDefaults / Keychain seams.
    JarvisSocket.swift             URLSessionWebSocketTask client.
    JarvisView.swift               SwiftUI surface + settings sheet.
    JarvisViewModel.swift          @MainActor view model.
  JarvisApp/               Executable with @main entry point.
    JarvisAppMain.swift            @main App scene.
    Info.plist                     Mic permission + ATS exception for localhost.
Tests/
  JarvisTests/JarvisConfigTests.swift   Plain XCTest, no UI deps.
```

## Building

```bash
cd ios/Jarvis
swift build                              # library + executable
swift test                               # JarvisTests
xcodebuild -scheme JarvisApp \
  -destination 'platform=iOS Simulator,name=iPhone 15'
```

Or open `Package.swift` in Xcode and run the `JarvisApp` scheme.

## Pointing at a different server

Open the gear icon in the upper right, paste a different server URL
(e.g. `wss://jarvis-deploy.onrender.com/realtime`), tap Save. The value
is persisted in `UserDefaults` under key `jarvis.serverURL`.

## How it talks to the server

Exactly the same protocol as the web client:

1. WebSocket upgrade to `<serverURL>` with header `X-User-Id`.
2. On open, send `{type: "jarvis.client_hello", userId}` mirroring web.
3. Mic captures → resample to 24 kHz mono → Int16 LE → base64 →
   `input_audio_buffer.append` frames.
4. Server forwards `response.audio.delta` events (already renamed from
   GA's `response.output_audio.delta` by the proxy) — base64 → Int16 →
   `AVAudioPlayerNode.scheduleBuffer`.
5. Barge-in: when the mic RMS > 0.04 and the player is playing, clear
   the playback queue and emit `jarvis.barge_in` upstream.

## Notes

- The `JarvisApp` target sets `NSMicrophoneUsageDescription` so the first
  `getUserMedia`-equivalent prompts the user with a clear explanation.
- The `NSAppTransportSecurity` exception is scoped to `localhost` and
  `127.0.0.1` only; production talks to the HTTPS Render endpoint.
- User identity lives in Keychain under service
  `com.frontieraudio.jarvis`, account `user.id`, so reinstalls preserve
  cross-session memory.
