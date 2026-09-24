# hibi
[![CodSpeed](https://img.shields.io/endpoint?url=https://codspeed.io/badge.json)](https://app.codspeed.io/schmayterling/hibi?utm_source=badge)

[join the support/developer discord](https://discord.gg/v9r4cABUP2) | [get the latest nightly](https://github.com/schmayterling/hibi/releases) | [read the docs](https://docs.hibi.garden)

hibi is a desktop editor for local notes and documents. write in Markdown, edit the source, or keep both views side by side and come build the open source app for everything you write.

<img width="2648" height="1664" alt="CleanShot 2026-09-21 at 9 16 14 AM@2x" src="https://github.com/user-attachments/assets/9bac8cf0-c641-4bb6-a5e2-c47fe7b0c7d1" />

## get started

>[!NOTE]
> nightlies are currently ad-hoc signed. which means you **may** get a smartscreen/gatekeeper warning, this is currently the case until we get into a stable build.

download a build from [releases](https://github.com/schmayterling/hibi/releases) and back up your notes before using a nightly build.

start typing, open a file, or open a folder as a workspace and **use `cmd+K` on macOS or `ctrl+K` on Windows and Linux to find commands and settings**.

read the [user guide](docs/README.md) for editing, settings, workspaces, and exports.


## build from source

Use Node 24 LTS (`nvm use`), or Node 22.18 or later:

```sh
npm ci
npm run dev
```

for build commands, tests, and addon development, see [developer and agent notes](docs/ai-agents/README.md).

## contributing guidelines

see this: [CONTRIBUTING.md](CONTRIBUTING.md)

## ai contribution policy

allowed, i mean what did u expect but lets try to keep code quality great, hibi is constantly being benchmarked for performance so you will know if your pr is slowing down hibi

## license

hibi uses the [GNU General Public License v3.0](LICENSE.md). third-party credits and license texts are available in **Settings → Hibi → Open source licenses**.
