import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parseVimConfig } from '../src/addons/vim/config.ts'
import { electron, openInDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('Vim configs import mode-specific mappings and leaders without interpreting scripts', () => {
  const result = parseVimConfig(
    String.raw`
let mapleader = " "
let maplocalleader = ','
nnoremap <silent> <leader>w :w<CR>
inoremap jk <Esc>
vnoremap <Tab> >gv
nmap <localleader>p @a
map Q gq
nnoremap Q dd
nnoremap <expr> x Dangerous()
nnoremap <buffer> y dd
if 0
  nnoremap Z dd
endif
function! Never()
  nnoremap F dd
endfunction
cmap XX dangerous
nnoremap a b | !touch /tmp/should-not-exist
source other.vim
`,
    false,
  )
  assert.deepEqual(result.mappings.slice(0, 4), [
    { mode: 'normal', lhs: '<Space>w', rhs: ':w<CR>', recursive: false },
    { mode: 'insert', lhs: 'jk', rhs: '<Esc>', recursive: false },
    { mode: 'visual', lhs: '<Tab>', rhs: '>gv', recursive: false },
    { mode: 'normal', lhs: ',p', rhs: '@a', recursive: true },
  ])
  assert.equal(result.mappings.filter((m) => m.lhs === 'Q').length, 3)
  assert.equal(
    result.mappings.find((m) => m.lhs === 'Q' && m.mode === 'normal').rhs,
    'dd',
  )
  assert.equal(result.skipped.length, 6)
  const scriptBlocks = parseVimConfig(
    `func! Example()
nnoremap x dd
endf
lua << EOF
nnoremap y dd
EOF
inoremap kk <Esc>`,
    false,
  )
  assert.deepEqual(
    scriptBlocks.mappings.map((mapping) => mapping.lhs),
    ['kk'],
  )
})

test('Neovim configs parse literal calls, aliases, options and multiline strings without execution', () => {
  const result = parseVimConfig(
    `
vim.g.mapleader = ' '
local map = vim.keymap.set
local opts = { silent = true, remap = true }
map({'n', 'x'}, '<leader>d', 'dd', opts)
vim.api.nvim_set_keymap('i', 'jk', '<Esc>', { noremap = true })
vim.keymap.set('n', 'ö', [[i💖<Esc>]])
vim.keymap.set('n', '<leader>w', '<cmd>w<CR>')
vim.keymap.set('n', 'F', function() os.execute('never') end)
vim.keymap.set('n', 'L', vim.lsp.buf.definition)
vim.keymap.set('n', 'E', 'expr()', { expr = true })
vim.keymap.set('n', 'B', 'dd', { buffer = 0 })
vim.keymap.set('n', 'P', '<Plug>(plugin)')
vim.keymap.set('__proto__', 'C', 'dd')
vim.keymap.set('n', 'T', '<Cmd>Telescope find_files<CR>')
if false then vim.keymap.set('n', 'D', 'dd') end
os.execute('never')
`,
    true,
  )
  assert.equal(result.mappings.length, 5)
  assert.equal(result.mappings[0].recursive, true)
  assert.equal(result.mappings[1].mode, 'visual')
  assert.equal(result.mappings[2].recursive, false)
  assert.equal(result.mappings[3].rhs, 'i💖<Esc>')
  assert.equal(result.mappings[4].rhs, ':w<CR>')
  assert.equal(result.skipped.length, 8)
  assert.throws(() => parseVimConfig('vim.keymap.set(', true))
  const changedOptions = parseVimConfig(
    `local opts = {}
opts['expr'] = true
vim.keymap.set('n', 'x', 'expression()', opts)`,
    true,
  )
  assert.equal(changedOptions.mappings.length, 0)
  assert.equal(changedOptions.skipped.length, 1)
  const lowercaseKeys = parseVimConfig(
    'inoremap jj <esc>\nnnoremap <c-s> :w<cr>',
    false,
  )
  assert.equal(lowercaseKeys.mappings[0].rhs, '<Esc>')
  assert.equal(lowercaseKeys.mappings[1].lhs, '<C-s>')
  assert.equal(lowercaseKeys.mappings[1].rhs, ':w<CR>')
})

test('experimental config remaps preserve editing, macro registers and defaults across reloads', {
  timeout: 60000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-vim-config-'))
  const profile = join(folder, 'profile')
  const configHome = join(folder, 'config')
  await mkdir(profile)
  await mkdir(join(configHome, 'nvim'), { recursive: true })
  await writeFile(join(profile, 'addons.json'), JSON.stringify({ vim: true }))
  const configPath = join(configHome, 'nvim', 'init.lua')
  const config = `vim.g.mapleader = ' '
vim.keymap.set('n', '<Space>', '<Nop>')
vim.keymap.set('i', 'jk', '<Esc>')
vim.keymap.set('n', '<leader>p', '@a')
vim.keymap.set('n', 'H', '0')
vim.keymap.set('n', '<leader>w', '<cmd>w<CR>')
vim.keymap.set('n', 'F', function() error('Do not execute config') end)
error('Do not execute config')
`
  await writeFile(configPath, config)
  const note = join(folder, 'note.md')
  await writeFile(note, 'alpha\nbeta\ngamma')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await app.evaluate(({ dialog }, note) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [note] })
  }, note)
  await openInDocumentEditor(app, page, () => clickMenu(app, 'Open…'))
  await page.getByRole('button', { name: /^source view$/i }).click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await page.locator('[data-vim-plugin]').waitFor()
  const read = async () =>
    (await page.evaluate(() => window.hibi.getDocument())).markdown
  const settings = async () => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: /^vim$/i, exact: true }).click()
  }
  const back = () =>
    page.getByRole('button', { name: /^back to app$/i }).click()
  // Record a macro before importing. The importer must not reset Vim state.
  await source.pressSequentially('ggqaA')
  await page.keyboard.type('!')
  await page.keyboard.press('Escape')
  await source.press('q')
  await settings()
  const toggle = page.getByRole('checkbox', { name: /use vim\/neovim config/i })
  assert.equal(await toggle.isChecked(), false)
  await page
    .locator('.document-notice[data-variant="warning"]')
    .filter({ hasText: /experimental/i })
    .waitFor()
  await toggle.check()
  const detected = await page.evaluate(() =>
    window.hibi.queryAddon('vim', 'config'),
  )
  assert.equal(detected.path, configPath)
  assert.equal(detected.mappings.length, 5)
  await page.getByRole('status').filter({ hasText: '5 mappings' }).waitFor()
  await page.getByText(configPath, { exact: true }).waitFor()
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/vim-config.png' })
  await back()
  await source.press('j')
  await source.press('Space')
  await source.press('p')
  assert.match(await read(), /beta!/)
  await source.press('i')
  await page.keyboard.type('text')
  await source.pressSequentially('jk')
  await page
    .getByRole('status')
    .filter({ hasText: /vim · normal/i })
    .waitFor()
  assert.ok(!(await read()).includes('jk'))
  await source.pressSequentially(' w')
  await page
    .getByRole('tab', { name: 'note.md', exact: true })
    .getByRole('status', { name: /unsaved changes/i })
    .waitFor({ state: 'hidden' })
  assert.equal(await readFile(note, 'utf8'), await read())
  await settings()
  await toggle.uncheck()
  await back()
  await source.pressSequentially('G@a')
  assert.match(await read(), /gamma!/)
  await source.press('i')
  await source.pressSequentially('jk')
  assert.ok((await read()).includes('jk'))
  await source.press('Escape')
  await settings()
  await toggle.check()
  const custom = join(folder, 'keymaps.vim')
  await writeFile(
    custom,
    'inoremap zz <Esc>\nnnoremap <Space>p @a\nnnoremap Q I\nnmap R Q\n',
  )
  await app.evaluate(({ dialog }, custom) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [custom],
    })
  }, custom)
  await page.getByRole('button', { name: /choose config/i }).click()
  await page.getByText(custom, { exact: true }).waitFor()
  await page.getByRole('status').filter({ hasText: '4 mappings' }).waitFor()
  await back()
  await source.press('R')
  await page
    .getByRole('status')
    .filter({ hasText: /vim · insert/i })
    .waitFor()
  await source.pressSequentially('zz')
  await page
    .getByRole('status')
    .filter({ hasText: /vim · normal/i })
    .waitFor()
  await settings()
  await writeFile(custom, 'inoremap xx <Esc>\n')
  await page.getByRole('button', { name: /^reload$/i }).click()
  await page.getByRole('status').filter({ hasText: '1 mapping' }).waitFor()
  await back()
  await source.press('i')
  await source.pressSequentially('zzxx')
  await page
    .getByRole('status')
    .filter({ hasText: /vim · normal/i })
    .waitFor()
  assert.ok((await read()).includes('zz'))
  assert.equal(await readFile(configPath, 'utf8'), config)
  assert.equal(
    JSON.parse(await readFile(join(profile, 'vim-config.json'), 'utf8')),
    custom,
  )
  // Restart renderer: preference and the native selected-file grant survive.
  await page.reload()
  await page.getByRole('button', { name: /^source view$/i }).click()
  await page.locator('[data-vim-plugin]').waitFor()
  await source.press('i')
  await source.pressSequentially('xx')
  await page
    .getByRole('status')
    .filter({ hasText: /vim · normal/i })
    .waitFor()
  assert.deepEqual(errors, [])
})
