# macOS app icon appearance prototype

Related issue: https://github.com/schmayterling/hibi/issues/876. Companion user guide: https://github.com/hibigarden/docs/pull/37.

Appearance has an independent macOS App icon preference. Existing profiles default to following the app and do not receive a custom file icon until a choice is explicitly saved. Windows and Linux keep their existing runtime icon behavior.

The saved value is `app`, `system`, `light`, or `dark` in `app-icon.json` under the current user-data directory. Main validates it and controls all paths. The renderer cannot name an app bundle or icon file. Writes and native changes are serialized; quitting waits for pending work. An unsuccessful preference write leaves the effective setting unchanged. If applying the installed icon fails after saving, the UI reports the failure while retaining the saved choice.

On macOS, system appearance is read independently of `nativeTheme.themeSource`, using `AppleInterfaceStyle` and its distributed notification. Follow system removes the custom file icon. The installed Icon Composer asset then handles system icon appearance while the app is closed on macOS 26+. Earlier versions retain a light `.icns` fallback. macOS's icon appearance setting can differ from the running app's light/dark system appearance.

Other modes use the public `NSWorkspace.setIcon` API through a fixed JavaScript for Automation program. Both paths are passed as argv to `/usr/bin/osascript`, never interpolated into executable source. Only packaged builds change file icons, and only on the bundle containing their own running executable. Development and native tests never customize Electron's bundle. Follow app appearance leaves the last resolved icon in place while closed. Updates/reinstalls can clear the custom icon; launch reapplies a saved choice.

## Release blocker: strict signature verification

This approach adds Finder metadata and an `Icon\r` file outside `Contents`. It does not rewrite signed resources. On disposable ad-hoc-signed apps and the local packaged app, ordinary `codesign --verify --deep` succeeds after setting an icon, but `codesign --verify --strict` rejects the Finder metadata. Returning to Follow system clears the metadata and restores strict verification.

Keep this change a draft until the maintainer accepts this tradeoff or replaces the persistence mechanism. Developer ID signing, notarization, Gatekeeper, and updater behavior with a customized bundle require verification before release. These were not established by ad-hoc local testing.

## Packaging and verification

`mac.icon` points to `build/hibi.icon`. Its light/dark bitmap layers use the existing unpadded artwork, with glass effects disabled. `npm run icons` refreshes its copied assets alongside the existing exports. electron-builder compiles it with `actool` from Xcode 26 or newer and supplies a legacy `.icns` fallback. macOS packaging runners need that toolchain; other platforms do not compile the asset.

Use isolated profiles and disposable app bundles for testing:

- `node --test tests/app-icon.test.mjs tests/mac-app-icon.test.mjs tests/addon-stop.test.mjs` checks mode independence, actual runtime icon input, settings persistence, invalid input, failed atomic writes, the public native custom-icon API, signature behavior, reset, and shutdown.
- `npm run check` is the full repository gate.
- For a local ad-hoc package, use `npx electron-builder --dir -c.mac.identity=- -c.mac.forceCodeSigning=false -c.mac.notarize=false -c.mac.hardenedRuntime=false`. The last override is only for local testing: an ad-hoc main executable cannot pass hardened runtime library validation against Electron's signed framework. Production packaging retains the committed hardened-runtime setting.

In environments that export `ELECTRON_RUN_AS_NODE`, unset it for Electron launch commands. Never launch tests against the installed app or a normal user profile.
