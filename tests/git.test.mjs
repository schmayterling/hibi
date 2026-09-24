import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const execute = promisify(execFile)
test('git addon stages, commits, switches, pulls and pushes only to a disposable local remote', {
  timeout: 60000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-git-'))
  const root = join(temp, 'workspace'),
    remote = join(temp, 'remote.git'),
    peer = join(temp, 'peer')
  const git = async (cwd, ...args) =>
    (
      await execute(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'commit.gpgSign=false',
          ...args,
        ],
        { cwd },
      )
    ).stdout.trim()
  await git(temp, 'init', '--bare', remote)
  await git(temp, 'init', '-b', 'main', root)
  await git(root, 'config', 'user.name', 'hibi test')
  await git(root, 'config', 'user.email', 'hibi@example.test')
  await writeFile(join(root, 'note.md'), 'initial')
  await mkdir(join(root, 'guides'))
  await writeFile(join(root, 'guides', 'nested.md'), 'nested')
  await writeFile(join(root, 'guides', 'removed.md'), 'remove later')
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'initial')
  await git(root, 'remote', 'add', 'origin', remote)
  await git(root, 'push', '-u', 'origin', 'main')
  await git(root, 'branch', 'other')
  await git(temp, 'clone', '-b', 'main', remote, peer)
  await git(peer, 'config', 'user.name', 'hibi peer')
  await git(peer, 'config', 'user.email', 'peer@example.test')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async (_window, options) => ({
      canceled: false,
      filePaths: [
        options.properties.includes('openDirectory') ? root : `${root}/note.md`,
      ],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, root)
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await pressShortcut(app, `${mod}+Shift+o`)
  await page.getByRole('button', { name: /new workspace file/i }).waitFor()
  await pressShortcut(app, `${mod}+o`)
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.textContent === 'initial',
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-git').click()
  await page.waitForFunction(() => document.querySelector('#addon-git').checked)
  await page.getByRole('button', { name: /^back to app$/i }).click()
  assert.equal(
    await page.locator('[data-status-id="git.repository"]').count(),
    0,
  )
  const openGit = async () => {
    const picker = page.getByRole('button', { name: /sidebar views/i })
    if (!(await picker.isVisible()))
      await page
        .getByRole('button', { name: /toggle workspace sidebar/i })
        .click()
    await picker.click()
    await page.getByRole('menuitem', { name: /^git$/i, exact: true }).click()
  }
  const invoke = (method, input) =>
    page.evaluate(
      ({ method, input }) => window.hibi.invokeAddon('git', method, input),
      { method, input },
    )
  assert.equal((await invoke('state')).branch, 'main')
  await writeFile(join(root, 'note.md'), 'local change')
  const hook = join(root, '.git', 'hooks', 'pre-commit')
  await writeFile(hook, '#!/bin/sh\ntouch hook-ran\n')
  await chmod(hook, 0o755)
  await git(root, 'config', 'core.fsmonitor', 'touch fsmonitor-ran')
  await git(root, 'config', 'diff.external', 'touch diff-ran')
  assert.match(await invoke('diff', 'note.md'), /\+local change/)
  await invoke('stage', 'note.md')
  assert.equal((await invoke('state')).files[0].index, 'M')
  await invoke('unstage', 'note.md')
  assert.equal((await invoke('state')).files[0].worktree, 'M')
  await invoke('stage', 'note.md')
  await openGit()
  const panel = page.getByRole('complementary', { name: /^git$/i, exact: true })
  await panel.getByRole('button', { name: /^commit changes$/i }).click()
  let commitDialog = page.getByRole('dialog', { name: /^commit changes$/i })
  await commitDialog.getByLabel(/commit message/i).fill('local commit')
  await page.keyboard.press('Escape')
  await commitDialog.waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.getByRole('button', { name: /toggle workspace sidebar/i }).click()
  await page.waitForFunction(
    () => document.querySelector('.app')?.dataset.sidebar === 'false',
  )
  await openGit()
  await panel.getByRole('button', { name: /^commit changes$/i }).click()
  commitDialog = page.getByRole('dialog', { name: /^commit changes$/i })
  assert.equal(
    await commitDialog.getByLabel(/commit message/i).inputValue(),
    'local commit',
  )
  await commitDialog
    .getByRole('button', { name: /^commit$/i, exact: true })
    .click()
  await commitDialog.waitFor({ state: 'hidden' })
  await panel.getByText(/^working tree clean$/i).waitFor()
  assert.equal(await panel.getByRole('textbox').count(), 0)
  assert.equal(
    await panel.getByRole('heading', { name: /changes/i }).count(),
    0,
  )
  await panel.getByRole('button', { name: /^push/i }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.invokeAddon('git', 'state')).ahead === 0,
  ).catch(async () => {
    // The native operation lock may still be held while push is finishing.
    await panel
      .getByText(/^working…$/i, { exact: true })
      .waitFor({ state: 'hidden' })
    assert.equal((await invoke('state')).ahead, 0)
  })
  assert.equal(
    await git(remote, 'log', '-1', '--format=%s', 'main'),
    'local commit',
  )
  await panel.getByLabel(/git branch/i).selectOption('refs/heads/other')
  await panel
    .getByText(/^working…$/i, { exact: true })
    .waitFor({ state: 'hidden' })
  assert.equal((await invoke('state')).branch, 'other')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'initial',
  )
  await panel.getByLabel(/git branch/i).selectOption('refs/heads/main')
  await panel
    .getByText(/^working…$/i, { exact: true })
    .waitFor({ state: 'hidden' })
  await git(peer, 'pull', '--ff-only')
  await writeFile(join(peer, 'note.md'), 'remote change')
  await git(peer, 'add', 'note.md')
  await git(peer, 'commit', '-m', 'remote change')
  await git(peer, 'push')
  await panel.getByRole('button', { name: /^pull/i }).click()
  await panel
    .getByText(/^working…$/i, { exact: true })
    .waitFor({ state: 'hidden' })
  assert.equal(await readFile(join(root, 'note.md'), 'utf8'), 'remote change')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'remote change',
  )
  await page.getByRole('button', { name: /sidebar views/i }).click()
  await page
    .getByRole('menuitem', { name: /^workspace$/i, exact: true })
    .click()
  await panel.waitFor({ state: 'hidden' })
  await page.evaluate(() => {
    window.gitBusyChanges = 0
    window.gitBusyObserver = new MutationObserver((entries) => {
      if (
        entries.some(
          (entry) => entry.target.getAttribute('aria-busy') === 'true',
        )
      )
        window.gitBusyChanges++
    })
    window.gitBusyObserver.observe(document.querySelector('.app'), {
      attributes: true,
      attributeFilter: ['aria-busy'],
    })
  })
  await writeFile(join(root, 'guides', 'nested.md'), 'modified nested file')
  const guides = page.getByRole('treeitem', { name: /^guides$/i, exact: true })
  await guides.locator('.sidebar-decoration').waitFor()
  assert.equal(await guides.getAttribute('aria-expanded'), 'false')
  await guides.click()
  const nested = page.getByRole('treeitem', {
    name: /^nested\.md$/i,
    exact: true,
  })
  await nested
    .locator('.sidebar-decoration')
    .filter({ hasText: /M/i })
    .waitFor()
  await git(root, 'add', 'guides/nested.md')
  await page.waitForFunction(
    () =>
      document
        .getElementById('sidebar-guides/nested.md')
        ?.getAttribute('aria-description') === 'Git: modified (staged)',
  )
  assert.equal(
    await page.evaluate(() => {
      window.gitBusyObserver.disconnect()
      return window.gitBusyChanges
    }),
    0,
  )
  await nested.click()
  await guides.click()
  await writeFile(join(root, 'guides', 'new.md'), 'untracked file')
  await page.waitForFunction(() =>
    document
      .getElementById('sidebar-guides')
      ?.getAttribute('aria-description')
      ?.includes('2 changed files'),
  )
  assert.equal(
    await guides.getAttribute('aria-expanded'),
    'false',
    'background decorations must not reopen a collapsed folder',
  )
  await guides.click()
  await page
    .getByRole('treeitem', { name: /^new\.md$/i, exact: true })
    .locator('.sidebar-decoration')
    .filter({ hasText: /U/i })
    .waitFor()
  await rm(join(root, 'guides', 'removed.md'))
  await page.waitForFunction(() =>
    document
      .getElementById('sidebar-guides')
      ?.getAttribute('aria-description')
      ?.includes('3 changed files'),
  )
  await page
    .getByRole('treeitem', { name: /^removed\.md$/i, exact: true })
    .waitFor({ state: 'hidden' })
  await mkdir('test-results', { recursive: true })
  await page.screenshot({
    path: 'test-results/git-explorer.png',
    animations: 'disabled',
  })
  await page.getByRole('treeitem', { name: /^note\.md$/i, exact: true }).click()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-git').click()
  await page.waitForFunction(
    () => !document.querySelector('.workspace-sidebar .sidebar-decoration'),
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.queryAddon('git', 'decorations')),
    /Enable this addon in Settings → Addons first\./,
  )
  await page.locator('#addon-git').click()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await nested.locator('.sidebar-decoration').waitFor()
  await assert.rejects(
    page.evaluate(() => window.hibi.queryAddon('git', 'stage', 'note.md')),
    /This addon does not support the requested action\./,
  )
  await page
    .getByRole('textbox', { name: /document editor/i })
    .fill('unsaved edits')
  const note = page.getByRole('treeitem', { name: /^note\.md$/i, exact: true })
  await note.locator('.sidebar-dirty').waitFor()
  assert.equal(await note.locator('.sidebar-decoration').count(), 0)
  await assert.rejects(invoke('switch', 'refs/heads/other'), /Save your edits/)
  await assert.rejects(invoke('pull'), /Save your edits/)
  await assert.rejects(
    invoke('stage', '../outside.md'),
    /This file has no changes\. Refresh Git status\./,
  )
  await writeFile(join(root, '.gitattributes'), 'secret.md filter=secret\n')
  await writeFile(join(root, 'secret.md'), 'private text')
  await git(root, 'config', 'filter.secret.clean', 'touch filter-ran')
  await assert.rejects(invoke('stage', 'secret.md'), /external Git filter/)
  await git(root, 'config', 'protocol.ext.allow', 'always')
  await git(
    root,
    'remote',
    'set-url',
    'origin',
    'ext::sh -c touch% remote-helper-ran',
  )
  await assert.rejects(invoke('push'), /not allowed/)
  for (const file of [
    'hook-ran',
    'fsmonitor-ran',
    'diff-ran',
    'filter-ran',
    'remote-helper-ran',
  ])
    await assert.rejects(access(join(root, file)), file)
  const previousWorkspace = await page.evaluate(() =>
    window.hibi.getWorkspace(),
  )
  const otherRoot = join(temp, 'other', 'workspace')
  await mkdir(join(otherRoot, 'guides'), { recursive: true })
  await writeFile(join(otherRoot, 'guides', 'nested.md'), 'not a repository')
  await app.evaluate(({ dialog }, otherRoot) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [otherRoot],
    })
  }, otherRoot)
  await pressShortcut(app, `${mod}+Shift+o`)
  await waitForAsync(
    page,
    async (previousId) => (await window.hibi.getWorkspace()).id !== previousId,
    previousWorkspace.id,
  )
  await page.waitForFunction(
    () => !document.querySelector('.workspace-sidebar .sidebar-decoration'),
  )
  assert.equal(
    await page.evaluate(() => window.hibi.queryAddon('git', 'decorations')),
    null,
  )
  await openGit()
  await panel.getByText(/^no repository$/i).waitFor()
  assert.equal(await panel.getByRole('alert').count(), 0)
  assert.equal(await panel.getByText(/Error invoking remote method/).count(), 0)
})
