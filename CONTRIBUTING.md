# contributing to hibi

contributions are greatly appreciated! hibi is a free, open-source writing app built around speed, customization, and keeping control of your files. think vscode for writing: one place to write, edit, preview, and organize things around your workflow.

## before you start

**hibi is alpha software.** bugs, crashes, rough performance, and incomplete addons are expected. please report them so we can track and fix them. if you need something stable, now probably isn't the right time.

the current focus is getting the foundations right: **speed, modularity, and proper addon and api support come first.** addons are extremely experimental. you can build them and submit prs now, but expect things to break as the app and its apis evolve. breaking-change alerts for addon developers are planned; don't assume every update is compatible.

hibi is a passion project and a hobby. feature requests and prs are welcome, but there is no promised implementation or review schedule. please respect the maintainer's time and don't demand immediate work. sponsoring the project helps support development, and contributing a pr is welcome too.

## ways to help

you can fix bugs, improve performance, write or correct documentation, build addons, improve accessibility, or help reproduce issues. you don't need to contribute code to be useful.

website contributions belong in the [website repository](https://github.com/hibigarden/site). app changes belong here.

### bugs and feature requests

search the [issues](https://github.com/schmayterling/hibi/issues) before opening a new one. for a bug, include:

- your operating system and hibi version, nightly build, or commit.
- steps to reproduce it, what you expected, and what happened.
- relevant enabled addons and whether the issue still happens with them disabled, when practical.
- screenshots, logs, or a small sample file if they help explain the problem. remove private information before sharing.

for slow behavior, describe the operation and the size of the file or workspace involved. the [diagnostics guide](https://docs.hibi.garden/#page=features%2Fdiagnostics.md) can help you gather useful details.

for a feature request, explain the problem you want to solve and how the feature would fit your writing workflow. an issue starts a discussion; it doesn't reserve a place on the roadmap. for a large change or a new core feature, opening an issue first can save work if the approach needs discussion. small fixes can go straight to a pr.

## working on the app

start with the [user guide](https://docs.hibi.garden/#page=README.md), then the [development guides](https://docs.hibi.garden/#page=development%2FREADME.md) and [development instructions](docs/ai-agents/AGENTS.md).

fork the repository, clone your fork, and create a branch for your change. use the node version in [.nvmrc](.nvmrc), currently 24. the minimum supported version is 22.18.0.

from your checkout, run:

```sh
nvm use
npm ci
npm run dev
```

if you don't use nvm, install the matching node version with your preferred tool and skip `nvm use`. the development app uses a separate data profile. see [running the development build](https://docs.hibi.garden/#page=development%2Fcore%2Frunning-the-development-build.md) for reload behavior and production previews.

keep each pr focused on one problem. follow nearby code and reuse existing helpers before adding new dependencies or abstractions. keep core code, the renderer, shared ui, and addons separate. preserve unsaved edits, external-file change checks, and path validation in the main process. workspace files must never be executed as addon code.

update documentation when behavior changes. user help belongs in `docs/`, contributor guides in `docs/development/`, and every addon needs a user-facing `README.md`. keep personal notes, private addons, and secrets out of commits.

## building addons

start with [creating your first addon](https://docs.hibi.garden/#page=development%2Faddons%2Fcreating-your-first-addon.md), then use the [addon guides](https://docs.hibi.garden/#page=development%2Faddons%2FREADME.md) and [api reference](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2FREADME.md).

you can submit an addon directly to this repository if you want it included in hibi; you don't need to maintain it in your own repository first. include its readme, explain what it does, and test enabling, using, and disabling it. see [testing your addon](https://docs.hibi.garden/#page=development%2Faddons%2Ftesting-your-addon.md).

preserve public api compatibility where possible. a breaking sdk change needs an api version bump and addon migrations. explain the breakage and migration in the pr. after changing a public api, update its source documentation and regenerate the reference:

```sh
npm run docs
npm run docs:check
```

## testing and performance

test the behavior you changed and add a focused regression check when practical. before submitting, run:

```sh
npm run check
```

this checks formatting, generated references, documentation links, ui copy, types, production builds, and tests. the [testing guide](https://docs.hibi.garden/#page=development%2Fcore%2Ftesting-changes.md) covers focused checks and interface verification.

performance and code quality matter in pr review. for changes affecting core code or default-enabled addons, run `npm run bench` and include relevant before-and-after results. for startup, typing, or other desktop behavior, follow the [performance guide](https://docs.hibi.garden/#page=development%2Fcore%2Fmeasuring-performance.md) and use the relevant desktop benchmarks. describe your machine, workload, and measurement method so results can be compared.

for interface changes, try the affected flow in the app and include screenshots or a short recording when useful. state which checks you ran and what you couldn't verify. don't present an untested change or a single timing sample as proof that everything works or got faster.

## ai contributions

ai-assisted contributions are allowed. you still need to understand what you're submitting, review the code, and test it yourself. be ready to explain why the change works and respond to review feedback. the same performance and code-quality expectations apply to every pr.

## opening a pr

describe the problem, what changed, and why. link any related issue, include your test results and relevant performance measurements, and call out known limitations or breaking changes. keep unrelated refactors and formatting changes out of the diff so the change is easier to review.

reviews happen when time allows. a pr may need changes, wait for other work, or be declined if it doesn't fit the project. please be patient; the maintainer has a life outside hibi too.

## getting help

join the [discord](https://discord.gg/v9r4cABUP2) for community help. ask in `#support` and ping `@i like helping people`, rather than posting support requests in general. for moderation issues, ping `@imagine being a mod`.

please still file bugs in [github issues](https://github.com/schmayterling/hibi/issues) so they can be tracked beyond a chat conversation.
