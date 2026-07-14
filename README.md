# Horizon

[Getting started](#getting-started) |
[LanternSol dev tooling](#lanternsol-dev-tooling) |
[Staying up to date with Horizon changes](#staying-up-to-date-with-horizon-changes) |
[Developer tools](#developer-tools) |
[Contributing](#contributing) |
[License](#license)

Horizon is the flagship of a new generation of first party Shopify themes. It incorporates the latest Liquid Storefronts features, including [theme blocks](https://shopify.dev/docs/storefronts/themes/architecture/blocks/theme-blocks/quick-start?framework=liquid).

- **Web-native in its purest form:** Themes run on the [evergreen web](https://www.w3.org/2001/tag/doc/evergreen-web/). We leverage the latest web browsers to their fullest, while maintaining support for the older ones through progressive enhancement—not polyfills.
- **Lean, fast, and reliable:** Functionality and design defaults to "no" until it meets this requirement. Code ships on quality. Themes must be built with purpose. They shouldn't support each and every feature in Shopify.
- **Server-rendered:** HTML must be rendered by Shopify servers using Liquid. Business logic and platform primitives such as translations and money formatting don't belong on the client. Async and on-demand rendering of parts of the page is OK, but we do it sparingly as a progressive enhancement.
- **Functional, not pixel-perfect:** The Web doesn't require each page to be rendered pixel-perfect by each browser engine. Using semantic markup, progressive enhancement, and clever design, we ensure that themes remain functional regardless of the browser.

## Getting started

We recommend using the Skeleton Theme as a starting point for a theme development project. [Learn more on Shopify.dev](https://shopify.dev/themes/getting-started/create).

To create a new theme project based on Horizon:

```sh
git clone https://github.com/Shopify/horizon.git
```

Install the [Shopify CLI](https://shopify.dev/docs/storefronts/themes/tools/cli) to connect your local project to a Shopify store. Learn about the [theme developer tools](https://shopify.dev/docs/storefronts/themes/tools) available, and the suggested [developer tools](#developer-tools) below.

Please note that the `main` branch may include code for features not yet released. You may encounter Liquid API properties that are not publicly documented, but will be when the feature is officially rolled out.

### Shopify Theme Store development

If you're building a theme for the Shopify Theme Store, then do not use Horizon as a starting point. Themes based on, derived from, or incorporating Horizon are not eligible for submission to to the Shopify Theme Store. Use the [Skeleton Theme](https://github.com/Shopify/skeleton-theme) instead.

## LanternSol dev tooling

This fork ships a small `lanternsol` CLI that runs the Shopify dev server **and** an automatic asset optimizer together.

Drop raw design exports (from Figma, screen recordings, etc.) into a local `figma/` folder and they are converted to web-optimized formats on the fly:

| You drop | You get in `figma/converted/` |
| --- | --- |
| An image (`.png`, `.jpg`, `.gif`, `.heic`, …) | An optimized `.webp` |
| A video (`.mov`, `.mp4`, `.mkv`, …) | An optimized `.webm` (VP9 + Opus) |

Originals are never modified, and the whole `figma/` folder is ignored by both git (`.gitignore`) and the theme uploader (`.shopifyignore`), so nothing here is ever committed or pushed to the store.

### One-time setup (per machine)

```sh
# 1. Conversion engines (ffmpeg → video/webm, webp/cwebp → image/webp)
brew install ffmpeg webp

# 2. Local dependencies
npm install

# 3. Make `lanternsol` available globally (symlinks to this repo)
npm link
```

Because `npm link` uses a symlink, edits to the tooling take effect immediately with no reinstall.

### Daily use

```sh
lanternsol theme dev
```

This does two things in one process:

1. Starts `shopify theme dev` (same output you're used to).
2. Watches `figma/`, creating it (and `figma/converted/`) if needed, and converts every file that lands in it.

Conversion progress is printed inline alongside the Shopify output, e.g.:

```
[figma] detected  hero.png
[figma] converting hero.png → converted/hero.webp  (image)…
[figma] ✓ done  converted/hero.webp  (2.4 MB → 480 KB, -80%)
```

Press `Ctrl+C` to stop — both the watcher and the Shopify dev server shut down together. If `shopify theme dev` exits on its own, the watcher stops too.

Any other command is passed straight through to the Shopify CLI, so `lanternsol theme push`, `lanternsol theme pull`, etc. all work as expected.

> **Note:** `lanternsol` uses [`ffmpeg`](https://ffmpeg.org/) for video and [`cwebp`/`gif2webp`](https://developers.google.com/speed/webp/docs/using) (the `webp` package) for images — Homebrew's `ffmpeg` bottle ships without a WebP encoder, so both are required. If either is missing, the watcher still runs but the affected conversions are skipped with a warning. VP9 video encoding is CPU-intensive, so large videos can take a while to convert.
>
> **Troubleshooting:** if image conversions fail and `cwebp -version` aborts with a `libtiff.6.dylib` (dyld) error, run `brew install libtiff` to repair the dependency.

To run only the watcher (without the Shopify dev server): `npm run figma:watch`.

## Staying up to date with Horizon changes

Say you're building a new theme off Horizon but you still want to be able to pull in the latest changes, you can add a remote `upstream` pointing to this Horizon repository.

1. Navigate to your local theme folder.
2. Verify the list of remotes and validate that you have both an `origin` and `upstream`:

```sh
git remote -v
```

3. If you don't see an `upstream`, you can add one that points to Shopify's Horizon repository:

```sh
git remote add upstream https://github.com/Shopify/horizon.git
```

4. Pull in the latest Horizon changes into your repository:

```sh
git fetch upstream
git pull upstream main
```

## Developer tools

There are a number of really useful tools that the Shopify Themes team uses during development. Horizon is already set up to work with these tools.

### Shopify CLI

[Shopify CLI](https://shopify.dev/docs/storefronts/themes/tools/cli) helps you build Shopify themes faster and is used to automate and enhance your local development workflow. It comes bundled with a suite of commands for developing Shopify themes—everything from working with themes on a Shopify store (e.g. creating, publishing, deleting themes) or launching a development server for local theme development.

You can follow this [quick start guide for theme developers](https://shopify.dev/docs/themes/tools/cli) to get started.

### Theme Check

We recommend using [Theme Check](https://github.com/shopify/theme-check) as a way to validate and lint your Shopify themes.

We've added Theme Check to Horizon's [list of VS Code extensions](/.vscode/extensions.json) so if you're using Visual Studio Code as your code editor of choice, you'll be prompted to install the [Theme Check VS Code](https://marketplace.visualstudio.com/items?itemName=Shopify.theme-check-vscode) extension upon opening VS Code after you've forked and cloned Horizon.

You can also run it from a terminal with the following Shopify CLI command:

```bash
shopify theme check
```

You can follow the [theme check documentation](https://shopify.dev/docs/storefronts/themes/tools/theme-check) for more details.

#### Shopify/theme-check-action

Horizon runs [Theme Check](#Theme-Check) on every commit via [Shopify/theme-check-action](https://github.com/Shopify/theme-check-action).

## Contributing

We are not accepting contributions to Horizon at this time.

## License

Copyright (c) 2025-present Shopify Inc. See [LICENSE](/LICENSE.md) for further details.
