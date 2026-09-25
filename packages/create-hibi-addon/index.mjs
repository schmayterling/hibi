#!/usr/bin/env node

import { constants } from 'node:fs'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const usage = `Create a Hibi addon

Usage:
  npx create-hibi-addon <directory> [--name <name>] [--author <name>]

From a Hibi checkout:
  npm run create:addon -- <directory>`

const exists = (path) =>
  access(path, constants.F_OK).then(
    () => true,
    () => false,
  )

function title(id) {
  return id
    .split('-')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

function text(value, label) {
  const result = value.trim()
  if (!result || result.length > 100 || /\p{Cc}/u.test(result))
    throw new Error(`${label} must contain 1–100 printable characters.`)
  return result
}

async function create() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      author: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      name: { type: 'string' },
    },
  })
  if (values.help) {
    console.log(usage)
    return
  }
  if (positionals.length !== 1) throw new Error(usage)

  const target = resolve(positionals[0])
  if (await exists(target))
    throw new Error(`Refusing to overwrite existing path: ${target}`)
  const id = basename(target)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id))
    throw new Error(
      'The addon ID must start with a letter and contain at most 48 lowercase letters, numbers, or hyphens.',
    )

  const name = text(values.name ?? title(id), 'Addon name')
  const author = text(values.author ?? 'Your name', 'Author name')
  const escaped = (value) => JSON.stringify(value).slice(1, -1)
  const replacements = new Map([
    ['__HIBI_ID__', escaped(id)],
    ['__HIBI_NAME__', escaped(name)],
    ['__HIBI_AUTHOR__', escaped(author)],
    ['__HIBI_GREETING__', escaped(`Hello from ${name}.`)],
    ['__HIBI_NAME_TEXT__', name],
  ])
  const template = fileURLToPath(new URL('template', import.meta.url))

  await mkdir(target, { recursive: true })
  for (const file of await readdir(template)) {
    let content = await readFile(join(template, file), 'utf8')
    for (const [token, value] of replacements)
      content = content.replaceAll(token, value)
    await writeFile(join(target, file), content)
  }
  console.log(`Created ${name} in ${target}`)
}

create().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
