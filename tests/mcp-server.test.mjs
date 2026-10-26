import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  waitForAppState,
  waitForDocumentEditor,
} from './electron.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

const toolNames = [
  'create_document',
  'edit_document',
  'move_document',
  'trash_document',
  'list_documents',
  'read_document',
  'search_documents',
  'get_active_document',
]
const editingDisabled =
  'Editing is turned off. Turn on Allow edits in the MCP Server settings in Hibi.'

test('bundled MCP server serves a real HTTP client and preserves workspace edits', {
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-mcp-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  const saved = 'Saved text.'
  const closed = 'alpha beta gamma\nrepeat repeat\n'
  const files = {
    'active.md': saved,
    'closed.md': closed,
    'move.md': 'move this document\n',
    'trash.md': 'trash this document\n',
    'notes-other.md': 'outside the notes folder\n',
    'notes/path-needle.md': 'a path match only\n',
    'notes/topic.md':
      'first line\nNeedle in second line\nthird line\nneedle on fourth\n',
    '.secret.md': 'hidden secret',
    'ignored.md': 'ignored secret',
    '.hibi/ignore': 'ignored.md\n',
  }
  let app
  t.after(async () => {
    if (app) {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await app.close()
    }
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(workspace, 'notes'), { recursive: true })
  await mkdir(join(workspace, '.hibi'))
  for (const [path, text] of Object.entries(files))
    await writeFile(join(workspace, path), text)
  await writeFile(join(root, 'outside.md'), 'outside secret')
  const port = await freePort()
  const url = `http://127.0.0.1:${port}/mcp`
  let token = 'mcp-test-0123456789abcdefghijklmnopqrstuvwxyz'
  app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
  }, workspace)
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(
    (preferences) => {
      localStorage.setItem(
        'mcp-server:preferences',
        JSON.stringify(preferences),
      )
    },
    { port, token, allowEdits: false },
  )
  await page.getByRole('button', { name: /toggle workspace sidebar/i }).click()
  await page.evaluate(() => window.hibi.openWorkspace())
  await page.getByRole('treeitem', { name: 'active.md', exact: true }).click()
  await page.locator('.tiptap').getByText(saved, { exact: true }).waitFor()
  await waitForDocumentEditor(app, page)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  await page.locator('#addon-mcp-server').click()
  await waitForAsync(page, async () =>
    (await window.hibi.getAddonStates()).some(
      (addon) => addon.id === 'mcp-server' && addon.enabled,
    ),
  )
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.queryAddon('mcp-server', 'status')).state ===
      'running',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.queryAddon('mcp-server', 'status')))
      .url,
    url,
  )

  const request = (
    message,
    { method = 'POST', headers = {}, endpoint = url } = {},
  ) => {
    const allHeaders = new Headers({
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
    })
    for (const [key, value] of Object.entries(headers)) {
      if (value === null) allHeaders.delete(key)
      else allHeaders.set(key, value)
    }
    return fetch(endpoint, {
      method,
      headers: allHeaders,
      body:
        method === 'GET'
          ? undefined
          : typeof message === 'string'
            ? message
            : JSON.stringify(message),
      signal: AbortSignal.timeout(10000),
    })
  }
  let nextId = 0
  const rpc = async (method, params = {}) => {
    const id = ++nextId
    const response = await request({ jsonrpc: '2.0', id, method, params })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^application\/json/)
    const reply = await response.json()
    assert.equal(reply.jsonrpc, '2.0')
    assert.equal(reply.id, id)
    assert.equal(reply.error, undefined, JSON.stringify(reply.error))
    return reply.result
  }
  const tool = (name, args = {}) => rpc('tools/call', { name, arguments: args })
  const textOf = (result, isError = false) => {
    assert.equal(result.isError, isError, JSON.stringify(result))
    assert.equal(result.content.length, 1)
    assert.equal(result.content[0].type, 'text')
    return result.content[0].text
  }
  const jsonOf = (result) => JSON.parse(textOf(result))
  const searchFirst = async (args) => {
    let cursor = args.cursor,
      result
    do {
      result = jsonOf(
        await tool('search_documents', {
          ...args,
          ...(cursor ? { cursor } : {}),
        }),
      )
      cursor = result.nextCursor
    } while (!result.matches.length && cursor)
    return result
  }
  const onDisk = (path) => readFile(join(workspace, path), 'utf8')

  await t.test(
    'transport guards reject unauthorized and malformed requests',
    async () => {
      const ping = { jsonrpc: '2.0', id: 'guard', method: 'ping' }
      for (const [headers, status] of [
        [{ Authorization: null }, 401],
        [{ Authorization: 'Bearer wrong-token' }, 401],
        [{ Origin: 'https://foreign.example' }, 403],
        [{ 'Content-Type': 'text/plain' }, 415],
        [{ 'MCP-Protocol-Version': 'unsupported' }, 400],
      ]) {
        const response = await request(ping, { headers })
        assert.equal(response.status, status, JSON.stringify(headers))
        assert.equal(await response.text(), '')
      }
      // Fetch derives Host from the URL, ignoring a caller's Host header.
      const badHost = await request(ping, {
        endpoint: `http://localhost.:${port}/mcp`,
      })
      assert.equal(badHost.status, 403)
      assert.equal(await badHost.text(), '')
      const get = await request(undefined, { method: 'GET' })
      assert.equal(get.status, 405)
      assert.equal(get.headers.get('allow'), 'POST')
      assert.equal(await get.text(), '')
      for (const [message, code] of [
        ['{', -32700],
        [[ping], -32600],
      ]) {
        const response = await request(message)
        assert.equal(response.status, 200)
        const reply = await response.json()
        assert.equal(reply.jsonrpc, '2.0')
        assert.equal(reply.id, null)
        assert.equal(reply.error.code, code)
      }
    },
  )

  await t.test(
    'initialize negotiates versions, accepts notifications and lists all eight tools',
    async () => {
      const version = await app.evaluate(({ app }) => app.getVersion())
      for (const requested of [
        '2025-03-26',
        '2025-06-18',
        '2025-11-25',
        '2099-01-01',
      ]) {
        const result = await rpc('initialize', {
          protocolVersion: requested,
          capabilities: {},
          clientInfo: { name: 'hibi-e2e', version: '1.0.0' },
        })
        assert.equal(
          result.protocolVersion,
          requested === '2099-01-01' ? '2025-11-25' : requested,
        )
        assert.deepEqual(result.serverInfo, { name: 'hibi', version })
        assert.deepEqual(result.capabilities, { tools: {} })
      }
      const notification = await request({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      })
      assert.equal(notification.status, 202)
      assert.equal(await notification.text(), '')
      assert.deepEqual(await rpc('ping'), {})
      const { tools } = await rpc('tools/list')
      assert.deepEqual(
        tools.map(({ name }) => name).sort(),
        [...toolNames].sort(),
      )
      for (const definition of tools) {
        assert.equal(definition.inputSchema.type, 'object')
        assert.equal(
          definition.annotations.readOnlyHint,
          !toolNames.slice(0, 4).includes(definition.name),
        )
      }
    },
  )

  await page.getByRole('button', { name: 'Back to app' }).click()
  await waitForDocumentEditor(app, page)
  await t.test(
    'read tools filter folders and private paths and search numbered lines',
    async () => {
      const listing = jsonOf(await tool('list_documents'))
      assert.deepEqual(
        [...listing.documents].sort(),
        Object.keys(files)
          .filter((path) => !path.startsWith('.') && path !== 'ignored.md')
          .sort(),
      )
      assert.equal(listing.truncated, false)
      assert.deepEqual(
        jsonOf(
          await tool('list_documents', { folder: 'notes' }),
        ).documents.sort(),
        ['notes/path-needle.md', 'notes/topic.md'],
      )
      assert.equal(
        textOf(await tool('read_document', { path: 'notes/topic.md' })),
        files['notes/topic.md'],
      )
      for (const path of [
        '.secret.md',
        'ignored.md',
        '../outside.md',
        'notes/../../outside.md',
      ])
        assert.ok(textOf(await tool('read_document', { path }), true))
      let search = await searchFirst({ query: 'NEEDLE' })
      const matches = [...search.matches]
      while (search.nextCursor) {
        search = jsonOf(
          await tool('search_documents', {
            query: 'NEEDLE',
            cursor: search.nextCursor,
          }),
        )
        matches.push(...search.matches)
      }
      search = { ...search, matches }
      assert.equal(search.truncated, false)
      const first = await searchFirst({
        query: 'NEEDLE',
        limit: 1,
        searchId: 'native-pagination',
      })
      assert.equal(first.matches.length, 1)
      assert.ok(first.nextCursor)
      const paths = first.matches.map((match) => match.path)
      let next = first.nextCursor
      while (next) {
        const page = jsonOf(
          await tool('search_documents', {
            query: 'NEEDLE',
            limit: 1,
            cursor: next,
          }),
        )
        paths.push(...page.matches.map((match) => match.path))
        next = page.nextCursor
      }
      assert.deepEqual(paths.sort(), ['notes/path-needle.md', 'notes/topic.md'])
      const cancelled = await searchFirst({
        query: 'NEEDLE',
        limit: 1,
        searchId: 'native-cancellation',
      })
      assert.ok(cancelled.nextCursor)
      assert.deepEqual(
        jsonOf(
          await tool('search_documents', {
            query: 'NEEDLE',
            searchId: 'native-cancellation',
            cancel: true,
          }),
        ).matches,
        [],
      )
      const stale = jsonOf(
        await tool('search_documents', {
          query: 'NEEDLE',
          cursor: cancelled.nextCursor,
        }),
      )
      assert.equal(stale.stale, true)
      assert.equal(stale.truncated, true)
      assert.deepEqual(stale.matches, [])
      const savedPage = await searchFirst({ query: 'NEEDLE', limit: 1 })
      assert.ok(savedPage.nextCursor)
      const sequence = await page.evaluate(
        async () => (await window.hibi.getWorkspaceChangeSnapshot()).sequence,
      )
      await writeFile(
        join(workspace, 'notes/topic.md'),
        `${files['notes/topic.md']}\n`,
      )
      await waitForAsync(
        page,
        async (before) =>
          (await window.hibi.getWorkspaceChangeSnapshot()).sequence > before,
        sequence,
      )
      const afterSave = jsonOf(
        await tool('search_documents', {
          query: 'NEEDLE',
          cursor: savedPage.nextCursor,
        }),
      )
      assert.equal(afterSave.stale, true)
      assert.equal(afterSave.truncated, true)
      assert.deepEqual(afterSave.matches, [])
      assert.deepEqual(
        search.matches.sort((a, b) => a.path.localeCompare(b.path)),
        [
          { path: 'notes/path-needle.md', lines: [] },
          {
            path: 'notes/topic.md',
            lines: [
              { line: 2, text: 'Needle in second line' },
              { line: 4, text: 'needle on fourth' },
            ],
          },
        ],
      )
    },
  )

  await t.test(
    'show-all-files permits native search without expanding mcp visibility',
    async () => {
      await page.evaluate(() =>
        window.hibi.updateWorkspaceSettings({
          action: 'show-all-files',
          enabled: true,
        }),
      )
      try {
        const paths = await page.evaluate(async () => {
          const { target } = await window.hibi.getWorkspaceChangeSnapshot()
          const paths = []
          let cursor
          do {
            const result = await window.hibi.queryWorkspaceReferences({
              target,
              kind: 'search-text',
              query: 'hidden secret',
              ...(cursor ? { cursor } : {}),
            })
            if (!result.ok) throw new Error(result.message)
            paths.push(...result.value.items)
            cursor = result.value.nextCursor
          } while (cursor)
          return paths
        })
        assert.ok(paths.includes('.secret.md'))
        assert.deepEqual(
          (await searchFirst({ query: 'hidden secret' })).matches,
          [],
        )
      } finally {
        await page.evaluate(() =>
          window.hibi.updateWorkspaceSettings({
            action: 'show-all-files',
            enabled: false,
          }),
        )
      }
    },
  )

  const draft = 'Unsaved local draft.'
  await t.test(
    'active and document reads include unsaved editor text',
    async () => {
      const active = jsonOf(await tool('get_active_document'))
      assert.deepEqual(active, {
        name: 'active.md',
        path: 'active.md',
        text: saved,
        truncated: false,
      })
      await replaceRichText(
        page,
        page.getByRole('textbox', { name: 'Document editor', exact: true }),
        draft,
      )
      await waitForAppState(
        page,
        async () =>
          (await window.hibi.getDocument()).markdown === 'Unsaved local draft.',
      )
      assert.deepEqual(jsonOf(await tool('get_active_document')), {
        name: 'active.md',
        path: 'active.md',
        text: draft,
        truncated: false,
      })
      assert.equal(
        textOf(await tool('read_document', { path: 'active.md' })),
        draft,
      )
      assert.equal(await onDisk('active.md'), saved)
    },
  )

  await t.test(
    'all write tools reject edits while editing is disabled',
    async () => {
      for (const [name, args] of [
        ['create_document', { path: 'disabled.md', text: 'blocked' }],
        [
          'edit_document',
          {
            path: 'closed.md',
            edits: [{ oldText: 'alpha', newText: 'blocked' }],
          },
        ],
        ['move_document', { path: 'move.md', destination: 'disabled-move.md' }],
        ['trash_document', { path: 'trash.md' }],
      ])
        assert.equal(textOf(await tool(name, args), true), editingDisabled)
      await assert.rejects(onDisk('disabled.md'), { code: 'ENOENT' })
      await assert.rejects(onDisk('disabled-move.md'), { code: 'ENOENT' })
      for (const path of ['closed.md', 'move.md', 'trash.md'])
        assert.equal(await onDisk(path), files[path])
    },
  )

  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^mcp server$/i }).click()
  await page.getByRole('checkbox', { name: 'Allow edits', exact: true }).check()
  // Flush the settings IPC before making the first write request.
  await page.evaluate(() => window.hibi.queryAddon('mcp-server', 'status'))
  await page.getByRole('button', { name: 'Back to app' }).click()
  await waitForDocumentEditor(app, page)

  await t.test('create never overwrites an existing document', async () => {
    const created = jsonOf(
      await tool('create_document', {
        path: 'notes/created.md',
        text: 'created text\n',
      }),
    )
    assert.equal(created.path, 'notes/created.md')
    assert.equal(created.persisted, true)
    assert.equal(await onDisk('notes/created.md'), 'created text\n')
    assert.match(
      textOf(
        await tool('create_document', {
          path: 'notes/created.md',
          text: 'overwrite',
        }),
        true,
      ),
      /already exists/i,
    )
    assert.equal(await onDisk('notes/created.md'), 'created text\n')
  })

  await t.test(
    'closed-file edits persist atomically and reject ambiguous or overlapping replacements',
    {
      skip:
        process.platform === 'win32' &&
        'Private workspace replacements are not available on Windows.',
    },
    async () => {
      for (const [edits, message] of [
        [[{ oldText: 'repeat', newText: 'once' }], /matches more than once/],
        [
          [
            { oldText: 'alpha beta', newText: 'x' },
            { oldText: 'beta gamma', newText: 'y' },
          ],
          /Edits overlap/,
        ],
      ]) {
        assert.match(
          textOf(
            await tool('edit_document', { path: 'closed.md', edits }),
            true,
          ),
          message,
        )
        assert.equal(await onDisk('closed.md'), closed)
      }
      jsonOf(
        await tool('edit_document', {
          path: 'closed.md',
          edits: [
            { oldText: 'gamma', newText: 'GAMMA' },
            { oldText: 'alpha', newText: 'ALPHA' },
          ],
        }),
      )
      assert.equal(
        await onDisk('closed.md'),
        'ALPHA beta GAMMA\nrepeat repeat\n',
      )
      assert.equal(
        textOf(await tool('read_document', { path: 'closed.md' })),
        await onDisk('closed.md'),
      )
    },
  )

  await t.test(
    'open-file edits remain unsaved and undo preserves the local draft',
    async () => {
      const edited = jsonOf(
        await tool('edit_document', {
          path: 'active.md',
          edits: [{ oldText: 'local draft', newText: 'MCP draft' }],
        }),
      )
      assert.equal(edited.path, 'active.md')
      assert.equal(edited.unsaved, true)
      await waitForAppState(
        page,
        async () =>
          (await window.hibi.getDocument()).markdown === 'Unsaved MCP draft.',
      )
      assert.equal(
        await page
          .getByRole('textbox', { name: 'Document editor', exact: true })
          .innerText(),
        'Unsaved MCP draft.',
      )
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).dirty,
        true,
      )
      assert.equal(await onDisk('active.md'), saved)
      assert.equal(
        textOf(await tool('read_document', { path: 'active.md' })),
        'Unsaved MCP draft.',
      )
      assert.equal(
        await page
          .locator('.tiptap')
          .evaluate((element) => element.editor.commands.undo()),
        true,
      )
      await waitForAppState(
        page,
        async () =>
          (await window.hibi.getDocument()).markdown === 'Unsaved local draft.',
      )
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).dirty,
        true,
      )
      assert.equal(await onDisk('active.md'), saved)
    },
  )

  await t.test(
    'move and trash work on closed files and reject open tabs',
    async () => {
      const moved = jsonOf(
        await tool('move_document', {
          path: 'move.md',
          destination: 'notes/moved.md',
        }),
      )
      assert.equal(moved.path, 'move.md')
      assert.equal(moved.destinationPath, 'notes/moved.md')
      await assert.rejects(onDisk('move.md'), { code: 'ENOENT' })
      assert.equal(await onDisk('notes/moved.md'), files['move.md'])
      jsonOf(await tool('trash_document', { path: 'trash.md' }))
      await assert.rejects(onDisk('trash.md'), { code: 'ENOENT' })
      assert.match(
        textOf(
          await tool('move_document', {
            path: 'active.md',
            destination: 'notes/active.md',
          }),
          true,
        ),
        /Close this document in Hibi before moving it\./,
      )
      assert.match(
        textOf(await tool('trash_document', { path: 'active.md' }), true),
        /Close this document in Hibi before moving it to the trash\./,
      )
      await assert.rejects(onDisk('notes/active.md'), { code: 'ENOENT' })
      assert.equal(await onDisk('active.md'), saved)
      assert.equal(jsonOf(await tool('get_active_document')).text, draft)
    },
  )

  await t.test(
    'regenerating the token revokes the old token immediately on the same port',
    async () => {
      await clickMenu(app, 'Settings')
      await page.getByRole('tab', { name: /^mcp server$/i }).click()
      await page
        .getByRole('button', { name: 'Regenerate', exact: true })
        .click()
      await page.evaluate(() => window.hibi.queryAddon('mcp-server', 'status'))
      const old = await request({
        jsonrpc: '2.0',
        id: 'revoked',
        method: 'ping',
      })
      assert.equal(old.status, 401)
      assert.equal(await old.text(), '')
      const next = await page
        .getByLabel('Access token', { exact: true })
        .inputValue()
      assert.notEqual(next, token)
      token = next
      assert.equal(
        await page.getByLabel('Endpoint URL', { exact: true }).inputValue(),
        url,
      )
      assert.deepEqual(await rpc('ping'), {})
    },
  )
})
