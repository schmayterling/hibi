# hibi
[![CodSpeed](https://img.shields.io/endpoint?url=https://codspeed.io/badge.json)](https://app.codspeed.io/schmayterling/hibi?utm_source=badge)

[join the support/developer discord](https://discord.gg/v9r4cABUP2) | [get the latest nightly](https://github.com/schmayterling/hibi/releases) | [read the docs](https://docs.hibi.garden)

hibi is a desktop editor for local notes and documents. write in markdown, latex, (language here you probably know), edit the source, or keep both views side by side and come build the open source app for everything you write.

<img width="2648" height="1664" alt="CleanShot 2026-09-21 at 9 16 14 AM@2x" src="https://github.com/user-attachments/assets/9bac8cf0-c641-4bb6-a5e2-c47fe7b0c7d1" />

## get started

download a build from [releases](https://github.com/schmayterling/hibi/releases) and **back up your notes before using a nightly build**.

>[!NOTE]
> window nightlies are currently ad-hoc signed. which means you **may** get a smartscreen warning, this is currently the case until we get into a stable build.
> 
> macos nightlies are signed properly and you won't get a gatekeeper warning (hopefully).

start typing, open a file, or open a folder as a workspace. confused? read the [user guide](docs/README.md).

roadmaps and discussions are available on the [hibi discord](https://discord.gg/v9r4cABUP2).

[found a bug? report here](https://github.com/schmayterling/issues)

## obsidian compatibility

effort has been done to make hibi compatible with your obsidian vaults, however this is done on a best-effort basis. it is **highly recommended** that you back up your obsidian notes prior to using hibi.

## updating hibi

use the built in updater once you've installed your nightly, for dev builds use `git pull`.

<img width="2656" height="1840" alt="CleanShot 2026-09-26 at 3 01 36 AM@2x" src="https://github.com/user-attachments/assets/f05dcb13-87b8-450c-ade5-3d805b535da1" />

## build from source

Use Node 24 LTS (`nvm use`), or Node 22.18 or later or PNPM if you'd like:

```sh
npm ci
npm run dev
```

for build commands, tests, and addon development, see [developer and agent notes](docs/ai-agents/README.md).

## contributing guidelines and ai policy

see this: [CONTRIBUTING.md](CONTRIBUTING.md)

## license

hibi uses the [GNU General Public License v3.0](LICENSE.md). third-party credits and license texts are available in **Settings → Hibi → Open source licenses**.
