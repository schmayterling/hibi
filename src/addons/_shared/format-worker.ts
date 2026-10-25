import { spawn } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LatexPackageTask } from '../math/packages'
import type { FormatResult, FormatSpec } from './format-specs'

export type FormatJob = {
  spec: FormatSpec
  source: string
  scratch: string
  entry: string
  run: boolean
  tools?: boolean
  toolPaths: Record<string, string | null>
  latexCache?: string
  packages?: LatexPackageTask
}
const limit = 20 * 1024 * 1024
const searchPath = [
  ...new Set([
    ...(process.env.PATH ?? '').split(delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/miniconda3/bin',
    '/Library/TeX/texbin',
  ]),
].filter(isAbsolute)

let toolPaths: Record<string, string | null> = {}
let stopEsbuild: (() => void) | undefined
async function tool(name: string) {
  const path = toolPaths[name]
  if (path) return path
  throw new Error(
    `Install ${name} or choose its executable in Settings → Dependencies.`,
  )
}

async function command(
  name: string,
  args: string[],
  cwd: string,
  input?: string,
  environment?: Record<string, string>,
) {
  let executable = await tool(name)
  let verbatim = false
  if (process.platform === 'win32' && executable.endsWith('.cmd')) {
    if ([executable, ...args].some((value) => /["\r\n%!?^&|<>()]/.test(value)))
      throw new Error(
        'Quarto cannot run with special characters in this file path on Windows. Rename the affected files or folders, then try again.',
      )
    args = [
      '/d',
      '/s',
      '/c',
      `"${[executable, ...args].map((value) => `"${value}"`).join(' ')}"`,
    ]
    executable =
      process.env.ComSpec ??
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    verbatim = true
  }
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      detached: process.platform !== 'win32',
      stdio: 'pipe',
      env: { ...process.env, PATH: searchPath.join(delimiter), ...environment },
    })
    if (child.pid) process.parentPort.postMessage({ child: child.pid })
    let stdout = '',
      stderr = '',
      size = 0
    const collect = (chunk: Buffer, error: boolean) => {
      size += chunk.byteLength
      if (size > limit) {
        child.kill('SIGKILL')
        reject(new Error('Compiler output exceeds 20 MiB.'))
      } else if (error) stderr += chunk.toString()
      else stdout += chunk.toString()
    }
    child.stdout.on('data', (chunk) => collect(chunk, false))
    child.stderr.on('data', (chunk) => collect(chunk, true))
    child.stdin.on('error', () => {})
    child.once('error', reject)
    child.once('close', () =>
      process.parentPort.postMessage({ closedChild: child.pid }),
    )
    child.once('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(
              (stderr || stdout || `${name} stopped (${code}).`).slice(-6000),
            ),
          ),
    )
    child.stdin.end(input)
  })
}

async function output(path: string) {
  if ((await stat(path)).size > 64 * 1024 * 1024)
    throw new Error('Compiled output exceeds 64 MiB.')
  return readFile(path)
}

async function preview(job: FormatJob): Promise<FormatResult> {
  const { source, spec } = job
  if (spec.reader === 'html') return { html: source }
  if (spec.reader === 'mdx') {
    const [
      { createProcessor },
      { default: remarkGfm },
      { toHtml },
      { toHast },
    ] = await Promise.all([
      import('@mdx-js/mdx'),
      import('remark-gfm'),
      import('hast-util-to-html'),
      import('mdast-util-to-hast'),
    ])
    const tree = createProcessor({ remarkPlugins: [remarkGfm] }).parse(source)
    type Node = {
      type: string
      value?: string | undefined
      children?: Node[] | undefined
      position?:
        | {
            start: { offset?: number | undefined }
            end: { offset?: number | undefined }
          }
        | undefined
    }
    const inert = (node: Node): Node => {
      if (node.type.startsWith('mdx'))
        return {
          type: /Text/.test(node.type) ? 'inlineCode' : 'code',
          value: source.slice(
            node.position?.start.offset,
            node.position?.end.offset,
          ),
        }
      if (node.children) node.children = node.children.map(inert)
      return node
    }
    inert(tree)
    return { html: toHtml(toHast(tree)!) }
  }
  if (spec.reader === 'mdsvex') {
    const { compile: compileMdsvex } = await import('mdsvex')
    const result = await compileMdsvex(source, {
      filename: job.entry,
      highlight: false,
    })
    if (!result) throw new Error('MDsveX could not parse this document.')
    return { html: result.code }
  }
  if (spec.reader === 'markdoc') {
    const { default: Markdoc } = await import('@markdoc/markdoc')
    const ast = Markdoc.parse(source)
    const errors = Markdoc.validate(ast).filter(
      (item) => item.error.level === 'critical',
    )
    if (errors.length)
      throw new Error(errors.map((item) => item.error.message).join('\n'))
    return { html: Markdoc.renderers.html(Markdoc.transform(ast)) }
  }
  return {
    html: await command(
      'pandoc',
      [
        '--sandbox',
        '--from',
        spec.reader,
        '--to',
        'html5',
        '--standalone',
        '--metadata=pagetitle:Hibi document',
        '--mathml',
        '--syntax-highlighting=none',
      ],
      job.scratch,
      source,
    ),
  }
}

async function componentSource(source: string, path: string) {
  if (/\.mdx$/i.test(path)) {
    const [{ compile: compileMdx }, { default: remarkGfm }] = await Promise.all(
      [import('@mdx-js/mdx'), import('remark-gfm')],
    )
    return String(
      await compileMdx({ value: source, path }, { remarkPlugins: [remarkGfm] }),
    )
  }
  if (/\.svx$/i.test(path)) {
    const { compile: compileMdsvex } = await import('mdsvex')
    const result = await compileMdsvex(source, {
      filename: path,
      highlight: false,
    })
    if (!result) throw new Error('MDsveX could not compile this document.')
    source = result.code
  }
  const [{ compile: compileSvelte }] = await Promise.all([
    import('svelte/compiler'),
    // @ts-expect-error Svelte's legacy flag module has no declaration file.
    import('svelte/internal/flags/legacy'),
  ])
  return compileSvelte(source, {
    filename: path,
    generate: 'server',
    css: 'injected',
  }).js.code
}

async function runComponent(job: FormatJob): Promise<FormatResult> {
  // Only explicit Run reaches this function. No document code executes during preview.
  process.chdir(dirname(job.entry))
  const { build, stop } = await import('esbuild')
  stopEsbuild = stop
  const runtimeImports = {
    react: () => import('react'),
    'react/jsx-runtime': () => import('react/jsx-runtime'),
    svelte: () => import('svelte'),
    // @ts-expect-error Svelte's generated server runtime has no declaration file.
    'svelte/internal/server': () => import('svelte/internal/server'),
    'svelte/server': async () => ({
      render: (await import('svelte/server')).render,
    }),
  }
  const runtimes: Record<string, object> = {}
  Object.assign(globalThis, { __hibiDocumentRuntime: runtimes })
  const bundled = await build({
    stdin: {
      contents: await componentSource(job.source, job.entry),
      sourcefile: job.entry,
      resolveDir: dirname(job.entry),
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    jsx: 'automatic',
    plugins: [
      {
        name: 'document-components',
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(react(?:\/jsx-runtime)?|svelte(?:\/internal\/server|\/server)?)$/,
            },
            async (args) => {
              runtimes[args.path] ??=
                await runtimeImports[args.path as keyof typeof runtimeImports]()
              return { path: args.path, namespace: 'hibi-runtime' }
            },
          )
          builder.onLoad(
            { filter: /.*/, namespace: 'hibi-runtime' },
            (args) => ({
              contents:
                Object.keys(runtimes[args.path]!)
                  .filter(
                    (name) =>
                      name !== 'default' && /^[a-zA-Z_$][\w$]*$/.test(name),
                  )
                  .map(
                    (name, index) =>
                      `const runtime${index}=globalThis.__hibiDocumentRuntime[${JSON.stringify(args.path)}][${JSON.stringify(name)}];export {runtime${index} as ${name}};`,
                  )
                  .join('\n') +
                `\nexport default globalThis.__hibiDocumentRuntime[${JSON.stringify(args.path)}];`,
              loader: 'js',
            }),
          )
          builder.onLoad({ filter: /\.(mdx|svx|svelte)$/ }, async (args) => ({
            contents: await componentSource(
              await readFile(args.path, 'utf8'),
              args.path,
            ),
            loader: 'js',
            resolveDir: dirname(args.path),
          }))
          builder.onResolve(
            { filter: /^svelte\/internal\/flags\/legacy$/ },
            (args) => ({ path: args.path, namespace: 'hibi-legacy' }),
          )
          builder.onLoad({ filter: /.*/, namespace: 'hibi-legacy' }, () => ({
            contents: '',
            loader: 'js',
          }))
          builder.onResolve({ filter: /^[\w@]/ }, (args) => {
            const path = createRequire(args.importer || job.entry).resolve(
              args.path,
            )
            return { path, external: !isAbsolute(path) }
          })
        },
      },
    ],
  })
  const modulePath = join(job.scratch, 'document.mjs')
  await writeFile(modulePath, bundled.outputFiles[0]!.text)
  const module = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
  if (job.spec.engine === 'mdx') {
    const [React, { renderToStaticMarkup }] = await Promise.all([
      import('react'),
      import('react-dom/server'),
    ])
    return { html: renderToStaticMarkup(React.createElement(module.default)) }
  }
  const { render: renderSvelte } = await import('svelte/server')
  const rendered = renderSvelte(module.default)
  return { html: rendered.head + rendered.body }
}

async function run(job: FormatJob): Promise<FormatResult> {
  const cwd = dirname(job.entry)
  if (job.spec.engine === 'mdx' || job.spec.engine === 'mdsvex')
    return runComponent(job)
  if (job.spec.engine === 'latex') {
    await command(
      'tectonic',
      ['-X', 'compile', '--untrusted', '--outdir', job.scratch, job.entry],
      cwd,
      undefined,
      latexEnvironment(job),
    )
    return {
      pdf: await output(
        join(job.scratch, basename(job.entry).replace(/\.tex$/i, '.pdf')),
      ),
    }
  }
  if (job.spec.engine === 'quarto') {
    await command(
      'quarto',
      [
        'render',
        job.entry,
        '--to',
        'html',
        '--embed-resources',
        '--execute',
        '--output',
        'rendered.html',
        '--output-dir',
        job.scratch,
      ],
      cwd,
    )
  } else if (job.spec.engine === 'rmarkdown') {
    await command(
      'Rscript',
      [
        '--vanilla',
        '-e',
        'a <- commandArgs(TRUE); rmarkdown::render(a[1], output_format="html_document", output_file="rendered.html", output_dir=a[2], knit_root_dir=a[3], quiet=TRUE, envir=new.env())',
        job.entry,
        job.scratch,
        cwd,
      ],
      cwd,
    )
  } else return preview(job)
  return {
    html: (await output(join(job.scratch, 'rendered.html'))).toString('utf8'),
  }
}

function latexEnvironment(job: FormatJob) {
  if (!job.latexCache)
    throw new Error('The LaTeX download folder is unavailable.')
  return { TECTONIC_CACHE_DIR: job.latexCache, TECTONIC_UNTRUSTED_MODE: '1' }
}

process.parentPort.once(
  'message',
  async ({ data: job }: { data: FormatJob }) => {
    try {
      toolPaths = job.toolPaths
      searchPath.unshift(
        ...Object.values(toolPaths)
          .filter((path): path is string => !!path)
          .map(dirname),
      )
      if (job.packages) {
        const { latexPackages } = await import('../math/packages')
        const environment = latexEnvironment(job)
        const packages = await latexPackages(
          job.packages,
          job.scratch,
          environment.TECTONIC_CACHE_DIR,
          (args) =>
            command('tectonic', args, job.scratch, undefined, environment),
        )
        process.parentPort.postMessage({ result: { packages } })
      } else if (job.tools) {
        const names = Object.keys(toolPaths)
        const status = await Promise.all(
          names.map(async (name) => {
            try {
              const path = await tool(name)
              return `${name}: ${path}`
            } catch (error) {
              return (error as Error).message
            }
          }),
        )
        process.parentPort.postMessage({
          result: {
            diagnostics:
              status.join('\n') ||
              'Ready. Hibi includes the tools for this format.',
          },
        })
      } else {
        const result = await (job.run ? run(job) : preview(job))
        if (result.html && Buffer.byteLength(result.html) > limit)
          throw new Error('Rendered document exceeds 20 MiB.')
        process.parentPort.postMessage({ result })
      }
    } catch (error) {
      process.parentPort.postMessage({
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      stopEsbuild?.()
    }
  },
)
