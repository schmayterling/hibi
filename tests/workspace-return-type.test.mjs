import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

test('native workspace headers reject entries access while explicit snapshots retain it', async (t) => {
  await mkdir('out', { recursive: true })
  const directory = await mkdtemp(resolve('out/workspace-types-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'consumer.ts')
  await writeFile(
    source,
    `
    import { getWorkspace, refreshWorkspace, loadWorkspace, openWorkspace, openRecentWorkspace, notifyWorkspaceContent } from '../../src/main/workspace.ts'
    import { workspaceAction } from '../../src/main/workspace-actions.ts'
    import type { WorkspaceActionResult } from '../../src/shared/workspace.ts'
    async function replies() {
      const refreshed = await refreshWorkspace()
      // @ts-expect-error refresh defaults to a header
      refreshed?.entries
      const loaded = await loadWorkspace('/tmp/notes')
      // @ts-expect-error load defaults to a header
      loaded?.entries
      const notified = await notifyWorkspaceContent(null)
      // @ts-expect-error notification defaults to a header
      notified?.entries
      const action = await workspaceAction({} as never, {})
      // @ts-expect-error actions default to a header
      action?.workspace?.entries
      const opened = await openWorkspace({} as never)
      // @ts-expect-error open defaults to a header
      opened?.entries
      const recent = await openRecentWorkspace('notes')
      // @ts-expect-error recent open defaults to a header
      recent?.entries
      const explicit = await refreshWorkspace(null, false)
      // @ts-expect-error explicit false is still a header
      explicit?.entries
      const include: boolean = Math.random() > 0.5
      const dynamic = getWorkspace(undefined, include)
      // @ts-expect-error entries need a known full-tree request
      dynamic?.entries
      const snapshots: (WorkspaceState | null)[] = [
        await refreshWorkspace(null, true), await loadWorkspace('/tmp/notes', false, true),
        await notifyWorkspaceContent(null, true), await openWorkspace({} as never, true),
        await openRecentWorkspace('notes', true),
      ]
      const fullAction: WorkspaceActionResult | null = await workspaceAction({} as never, {}, true)
      return [snapshots.map(state => state?.entries), fullAction?.workspace?.entries]
    }
    void replies
    import type { WorkspaceState } from '../../src/shared/workspace.ts'
    const header = getWorkspace()
    if (header) {
      header.name.toLowerCase()
      // @ts-expect-error native headers do not expose tree entries
      header.entries
    }
    const explicitHeader = getWorkspace(undefined, false)
    // @ts-expect-error explicit headers do not expose tree entries
    explicitHeader?.entries
    const full: WorkspaceState | null = getWorkspace(undefined, true)
    full?.entries.map(entry => entry.path)
  `,
  )
  const config = join(directory, 'tsconfig.json')
  await writeFile(
    config,
    JSON.stringify({
      extends: '../../tsconfig.node.json',
      files: [source],
    }),
  )
  const result = await promisify(execFile)(process.execPath, [
    resolve('node_modules/typescript/bin/tsc'),
    '--noEmit',
    '-p',
    config,
  ]).catch((error) => error)
  assert.equal(result.code, undefined, result.stdout || result.stderr)
})
