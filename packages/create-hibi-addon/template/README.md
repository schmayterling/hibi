# __HIBI_NAME_TEXT__

This addon adds **Say hello** to Hibi's command palette.

## Try it

Run `npm run check`, then choose **Install addon…** from Hibi's command palette and select this folder. Review the package, install it, then enable it in **Settings → Addons**. Run **Say hello** from the command palette to display a greeting. Disabling the addon removes its command.

The manifest declares no UI or editor capabilities and loads the addon when its command first runs. Keep the command ID in `hibi-addon.json` and `index.js` in sync.

## Share it

Commit `hibi-addon.json`, `index.js`, and this readme to a public HTTPS Git repository, or put them in a ZIP archive. Do not include `node_modules`.
