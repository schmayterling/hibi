# Building the app

Create an unpacked application for your platform with:

```sh
npm run package
```

Create distributable packages with:

```sh
npm run dist
```

Build output goes to `release/`. Packaging settings live in `electron-builder.yml`.

On Linux, `npm run dist` creates an AppImage, a Debian package, and a Flatpak bundle. The Flatpak build needs `flatpak` and `flatpak-builder`, plus Flathub as a user remote so it can download the pinned runtime:

```sh
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
```

Pull request and `main` checks only build the unpacked app. Installers are built by the nightly and release workflow, which also installs and briefly launches the Debian and Flatpak packages on x64 and arm64.

## Nightly builds

The **nightly** GitHub Actions workflow builds Linux AppImage, Debian, and Flatpak packages for x64 and arm64, a Windows installer, and macOS Intel and Apple Silicon packages. It runs checks before publishing a prerelease with download hashes and a changelog. Run it manually from Actions when you need a new build; unchanged revisions still build. See [releases and nightly builds](releases.md) for publication rules.

Windows and Linux packages are unsigned. macOS packages use Developer ID signing and notarization from repository secrets.

## Update icons

Replace `build/icon.png`, then run `npm run icons` on macOS. Commit the generated platform icons with the source image so local and release builds use the same artwork.
