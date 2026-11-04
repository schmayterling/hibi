# Editor width

Enable **Editor width** in **Settings → Addon Manager** to show a slider alongside the other status bar items at the bottom of the editor.

Drag the slider to adjust the editing width. The default is 800 pixels, with limits of 320 and 1600 pixels. Changes apply immediately in Normal, Source, and side-by-side views, including split documents. You can also focus the slider and use the arrow keys, Home, or End.

Turn off **Width cap** beside the slider to use the full pane width. The slider is disabled while the cap is off. Turning the cap back on restores your chosen width.

Open **Editor width** in Settings to change **Minimum width**, **Maximum width**, and **Width unit**. Use any CSS length unit supported by Hibi, such as `px`, `rem`, `ch`, `vw`, or `%`. The unit applies to both limits and the chosen width. Changes save when you leave a field or press Enter, and the chosen width stays within the new limits.

Pixel widths stay fixed when you resize a sidebar; the editor only becomes narrower when the available pane cannot fit it. Relative units follow CSS sizing: for example, `%` follows the pane width and `vw` follows the window width.

Hibi remembers the width, limits, unit, and cap state on this device and applies them to all documents. Disabling the addon restores the usual full width. Both controls follow your status bar visibility setting under **Settings → Appearance**.

Inspired by [Editor Width Slider for Obsidian](https://community.obsidian.md/plugins/editor-width-slider).
