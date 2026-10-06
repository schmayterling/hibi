# Create Hibi addon

Create a standalone Hibi addon with a command that displays a greeting. Requires Node.js 22.18 or later.

From a Hibi source checkout, run:

```sh
npm run create:addon -- hello --name "Hello" --author "Your name"
```

After this package is published to npm, you can use:

```sh
npx create-hibi-addon hello --name "Hello" --author "Your name"
```

The destination must not exist. The creator writes the addon manifest, JavaScript entry, readme, and a syntax-check script. It does not install dependencies or require the private, types-only `@hibi/addon-sdk` package.

Run `npm run check` inside the generated folder, then choose **Install addon…** in Hibi, review the package, and enable it in **Settings → Addons**. Run **Say hello** from the command palette.

See [creating your first addon](https://docs.hibi.garden/development/addons/creating-your-first-addon) for the manual source-addon guide and [sideloading and sharing](https://docs.hibi.garden/development/addons/sideloading) for packaging and optional SDK type checking.
