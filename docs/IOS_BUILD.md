# iOS and IPA build

The iOS app uses the existing React/Vite UI inside Tauri 2. Directly playable audio URLs and local files are delegated to the native iOS player, which configures an `AVAudioSession` for playback and exposes lock-screen/Control Center metadata and transport controls. `src-tauri/Info.ios.plist` enables only the `audio` background mode.

> iOS project generation, code signing, device installation, Archive, and IPA export require macOS with Xcode. They cannot be completed natively on Windows.

## 1. Install prerequisites on macOS

Install Xcode from the App Store, launch it once, accept its license, and install the requested platform components. Install Node.js 18 or newer and Rust stable, then install the Tauri iOS prerequisites described in the official Tauri documentation.

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
npm install
```

## 2. Generate and sync the iOS project

Run this once on macOS from the repository root:

```bash
npm run ios:init
```

After JavaScript, Rust, plugin, or native configuration changes, run a device development build to sync and validate the project:

```bash
npm run ios:dev
```

The generated Xcode workspace is under `src-tauri/gen/apple`. Open the `.xcworkspace` file rather than an individual `.xcodeproj` if both are present.

## 3. Signing and device configuration

In Xcode, select the app target and open **Signing & Capabilities**:

1. Select your Apple Developer **Team**.
2. Keep **Automatically manage signing** enabled unless your organization supplies manual profiles.
3. Change the Bundle Identifier from `com.hotdogdot.app` if that identifier is not registered to your team. Keep it unique and update `identifier` in `src-tauri/tauri.conf.json` to match.
4. Confirm that the deployment target is iOS 14.0 or newer.
5. Confirm **Background Modes → Audio, AirPlay, and Picture in Picture** is present with audio playback enabled. Do not enable unrelated modes.

The app does not request microphone, camera, contacts, or location permissions. Do not add those usage descriptions unless a real feature starts using them.

## 4. App icon and launch screen

The source icons are in `src-tauri/icons`. Tauri populates the generated iOS asset catalog during `ios:init`. Replace these source images before regenerating if branding changes. The generated iOS launch screen and the CSS safe-area layout handle the notch, Dynamic Island, and home indicator.

## 5. Run on an iPhone

Connect and trust the iPhone, enable Developer Mode if Xcode requests it, select the physical device as the run destination, then press **Run**. For a command-line development build:

```bash
npm run ios:dev
```

Test play, pause, seek, next/previous, interruption recovery, Bluetooth/headphone removal, app switching, and screen locking on a physical device. Simulator testing does not fully validate audio interruptions or lock-screen behavior.

## 6. Archive and export an IPA

1. In Xcode select **Any iOS Device (arm64)** as the destination.
2. Choose **Product → Archive**.
3. In Organizer select the archive, then **Distribute App**.
4. Choose App Store Connect, Ad Hoc, Development, or Enterprise according to your provisioning profile.
5. Follow Xcode's signing validation and export/upload flow. Ad Hoc and Development exports can produce an `.ipa`; App Store Connect normally uploads the archive directly.

The optional `APPLE_DEVELOPMENT_TEAM` environment variable can be used by CI or Tauri tooling, but the Team can also be selected directly in Xcode. Never commit certificates, private keys, provisioning profiles, or App Store Connect API private keys.

## Native playback architecture

YouTube tracks use a lazy Rust loopback proxy. The proxy starts only on first playback, keeps the Lavalink password inside Rust, requests the AAC-compatible `itag=140` stream for AVPlayer, and returns a short-lived `127.0.0.1` URL to the native player. `NSAllowsLocalNetworking` permits only that loopback handoff; remote traffic still requires HTTPS. The proxy is never required for app launch, so socket or network failure falls back to WebView playback instead of terminating the process.

The custom XcodeGen template at `src-tauri/ios/project.yml` is authoritative. It embeds Swift standard libraries and adds `/usr/lib/swift` to `LD_RUNPATH_SEARCH_PATHS`, which is required by `tauri-plugin-native-audio` on an iOS 14 deployment target. Do not patch the generated `src-tauri/gen/apple/project.yml`; regenerate it with `npx tauri ios init --ci`.

For launch diagnostics, capture the device console and filter for `[BOOT]`. Expected order: Rust entry, plugin registration, setup callback, WebView ready, JavaScript entry, React mounting.
