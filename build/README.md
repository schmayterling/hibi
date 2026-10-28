# app icon

`icon.png` is the light app icon and `icon-dark.png` is the dark one. each is 1024 by 1024 pixel artwork that fills the canvas, with transparent rounded corners. run `npm run icons` on macos to regenerate `icon-mac.png`, `icon-win.png`, `icon-linux.png`, `icon.icns`, and `icon.ico` from the light icon, the matching `-dark` pngs from the dark icon, and the about panel's `src/renderer/src/assets/app-icon.png` and `app-icon-dark.png`.

installers and the macos app bundle carry the light icon. while the dark appearance is active, the app shows the dark icon at runtime: the dock icon on macos and the window icons on windows and linux.

# tray icons

run `node scripts/tray-icons.mjs` from the repository root to regenerate the tray assets. run `node scripts/tray-icons.mjs --check` to verify that the committed outputs match their sources without rewriting them. the script uses `sharp`, which is already installed as a transitive dependency in the locked dependency tree. it does not add a dependency or launch the desktop app.

the letter is `tray-glyph.png`, the white h cut from the app icon before the app icon became a butterfly. the script derives every tray image from it, so edit that file to change the letter.

`trayTemplate.png` and `trayTemplate@2x.png` contain the same black shape at 16 and 32 pixels. their transparent canvases include one and two pixels of vertical padding, respectively. only the letter contributes opacity, so macos can tint the template for light and dark menu bars.

`tray.ico` contains 16, 24, and 32 pixel images for windows. `tray.png` is the 32 pixel linux image. both use the white letter on the indigo rounded tile defined in `tray-tile.svg`. the tile and its lighter outline keep the letter visible against both light and dark tray backgrounds. these images retain transparent corners.

runtime integration should load the template pair on macos, `tray.ico` on windows, and `tray.png` on linux.
