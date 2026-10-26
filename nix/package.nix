{ lib, buildNpmPackage, fetchFromGitHub, makeWrapper, makeDesktopItem
, copyDesktopItems, autoPatchelfHook, stdenv, nodejs_24, electron_44
, version ? "0.1.0"
}:

let
  electron = electron_44;

  # scripts/docs.mjs normally clones hibigarden/docs at ./docs-revision.
  # No network in the sandbox, so fetch that revision here and hand it
  # over through HIBI_DOCS_SOURCE (read as plain files, no git needed).
  docs = fetchFromGitHub {
    owner = "hibigarden";
    repo = "docs";
    rev = lib.fileContents ../docs-revision;
    hash = "sha256-dk66ES0xh5DSFdj4qwuxGz2MZ99LmsX/1xuqEy3/mm8=";
  };

  mimeTypes = [
    "text/plain" "text/markdown" "text/x-mdx" "text/x-tex" "text/x-rst"
    "text/x-asciidoc" "text/org" "text/x-typst" "text/html" "text/x-mediawiki"
    "text/x-r-markdown" "text/x-quarto" "text/x-mdsvex" "text/x-markdoc"
    "text/x-djot" "text/x-textile" "text/x-creole" "text/x-mermaid"
    "text/x-bbcode" "x-scheme-handler/hibi"
  ];
in
buildNpmPackage {
  pname = "hibi";
  inherit version;

  src = lib.cleanSource ./..;

  nodejs = nodejs_24;
  npmDepsHash = "sha256-pqY7N0NDKzPTaFbogida0dqCW+pLyB5g4UIp6mx997Q=";
  # npmConfigHook runs `npm rebuild`, which fires the root postinstall
  # (install-electron downloads -> fetch failed). Skip it; deps are prebuilt.
  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [ makeWrapper copyDesktopItems autoPatchelfHook ];
  # typst-ts-node-compiler ships a prebuilt napi .node linked to libstdc++
  buildInputs = [ stdenv.cc.cc.lib ];

  # electron from nixpkgs is already linked against the store; only patch
  # the npm prebuilts (typst napi), not the electron binary itself.
  dontAutoPatchelf = true;

  env = {
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
    HIBI_DOCS_SOURCE = "${docs}";
  };

  # npm ci runs with --ignore-scripts, so postinstall never happens.
  # Only the vim patch changes app behaviour; the other two are dev/macOS.
  preBuild = ''
    node scripts/patch-vim.mjs
  '';

  npmBuildScript = "build:app";

  # Let electron-builder lay out a real packaged app, but against nixpkgs'
  # electron instead of a downloaded one. That keeps app.isPackaged true,
  # process.resourcesPath/icons in place, and the fuses applied.
  postBuild = ''
    cp -r ${electron.dist} electron-dist
    chmod -R u+w electron-dist
    npm exec electron-builder -- \
      --linux dir \
      -c.electronDist=electron-dist \
      -c.electronVersion=${electron.version}
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/hibi
    cp -r release/linux-unpacked/. $out/share/hibi

    install -Dm644 build/icon-linux.png \
      $out/share/icons/hicolor/512x512/apps/com.ryanaque.hibi.png

    # the bundled chrome-sandbox is not setuid in the store; without this
    # chromium traps (SIGILL). same as nixpkgs electron wrapper does.
    makeWrapper $out/share/hibi/hibi $out/bin/hibi \
      --set CHROME_DEVEL_SANDBOX ${electron}/libexec/electron/chrome-sandbox \
      --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations}}"

    # musl variant of the typst prebuilt is never loaded on glibc
    rm -rf $out/share/hibi/resources/app.asar.unpacked/node_modules/@myriaddreamin/typst-ts-node-compiler-linux-x64-musl

    runHook postInstall
  '';

  postFixup = ''
    autoPatchelf $out/share/hibi/resources/app.asar.unpacked
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "com.ryanaque.hibi";
      desktopName = "hibi";
      comment = "Desktop editor for local notes and documents";
      exec = "hibi %U";
      icon = "com.ryanaque.hibi";
      categories = [ "Office" ]; # same as electron-builder.yml / Obsidian
      mimeTypes = mimeTypes;
      startupWMClass = "hibi";
    })
  ];

  meta = {
    description = "Desktop editor for local markdown/latex notes and documents";
    homepage = "https://github.com/schmayterling/hibi";
    license = lib.licenses.gpl3Only;
    platforms = [ "x86_64-linux" ];
    mainProgram = "hibi";
  };
}
