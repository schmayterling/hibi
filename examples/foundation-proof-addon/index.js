const DEFAULT_PREFERENCES = Object.freeze({
  tag: 'proof',
  networkUrl: null,
  globalShortcut: false,
})

const SHORTCUT = 'CommandOrControl+Alt+Shift+F11'

function preferencesFrom(snapshot) {
  if (snapshot.status === 'ready') {
    const value = snapshot.value
    return value &&
      typeof value.tag === 'string' &&
      (value.networkUrl === null || typeof value.networkUrl === 'string') &&
      typeof value.globalShortcut === 'boolean'
      ? value
      : null
  }
  if (snapshot.status === 'version-mismatch' && snapshot.storedVersion === 1) {
    const previous = snapshot.value
    if (previous && typeof previous.tag === 'string')
      return {
        tag: previous.tag,
        networkUrl:
          typeof previous.endpoint === 'string' ? previous.endpoint : null,
        globalShortcut: previous.globalShortcut === true,
      }
  }
  return snapshot.status === 'missing' ? DEFAULT_PREFERENCES : null
}

export function completionItems(request) {
  const match = request.before.match(
    /(\[\[[a-z0-9-]*|@[a-z0-9-]*|#[a-z0-9-]*)$/i,
  )
  if (!match) return []
  const token = match[0]
  const link = token.startsWith('[[') || token.startsWith('@')
  const value = link ? '[[proof-note]]' : '#proof'
  const prefix = token.startsWith('@') ? token.slice(1) : token
  const candidate = token.startsWith('@') ? 'proof-note' : value
  if (!candidate.toLowerCase().startsWith(prefix.toLowerCase())) return []
  return [
    {
      label: value,
      detail: link ? 'workspace note' : 'workspace tag',
      insertText: value,
      from: request.selection.head - token.length,
      to: request.selection.head,
    },
  ]
}

export function hoverInfo(request) {
  if (
    request.selectedText === '#proof' ||
    request.before.endsWith('#proof') ||
    request.after.startsWith('#proof')
  )
    return { label: 'Proof tag', detail: 'Local foundation example.' }
  return null
}

export function contextActions(request) {
  if (request.selectedText !== '#proof') return []
  const from = Math.min(request.selection.anchor, request.selection.head)
  const to = Math.max(request.selection.anchor, request.selection.head)
  if (to - from !== '#proof'.length) return []
  return [
    {
      label: 'Capitalize proof tag',
      edit: { from, to, insertText: '#Proof' },
    },
  ]
}

export default ({ React }) => {
  let active = false
  let activation = 0
  let eventCount = 0
  let lastResult = 'Run Capture foundation proof to check this workspace.'
  const disposers = []

  return {
    async start(context) {
      active = true
      const current = ++activation
      const isActive = () => active && activation === current
      eventCount = 0
      const global = await context.storage.global('preferences', 2)
      if (!isActive()) return
      const snapshot = global.snapshot()
      const preferences = preferencesFrom(snapshot)
      if (!preferences)
        throw new Error(
          'Foundation proof preferences need a supported version.',
        )
      if (snapshot.status !== 'ready') {
        const saved = await global.set(
          preferences,
          snapshot.status === 'version-mismatch'
            ? { migrateFromVersion: 1 }
            : undefined,
        )
        if (saved.status !== 'saved')
          throw new Error('Foundation proof preferences could not be saved.')
      }
      if (!isActive()) return

      const panel = context.views.register({
        id: 'results',
        label: 'Foundation proof',
        location: 'panel',
        Content: () => React.createElement('p', null, lastResult),
      })
      disposers.push(() => panel.dispose())

      const changes = await context.workspace.subscribeChanges(() => {
        if (isActive()) eventCount++
      })
      if (!isActive()) {
        changes.dispose()
        return
      }
      disposers.push(() => changes.dispose())

      for (const register of [
        () => context.editor.registerCompletionProvider(completionItems),
        () => context.editor.registerHoverProvider(hoverInfo),
        () => context.editor.registerContextActionProvider(contextActions),
      ]) {
        const dispose = await register()
        if (!isActive()) {
          dispose()
          return
        }
        disposers.push(dispose)
      }

      let pendingCapture = Promise.resolve()
      disposers.push(
        context.commands.register({
          id: 'capture',
          label: 'Capture foundation proof',
          defaultShortcut: 'mod+alt+shift+f11',
          menu: { location: 'app', group: 'foundation-proof' },
          run(invocation) {
            const capture = pendingCapture.then(async () => {
              if (!isActive()) return
              const source = invocation.document
                ? context.documents.readSource(invocation.document)
                : null
              const target =
                invocation.workspace ??
                (await context.workspace.changeSnapshot()).target
              if (!target || !isActive()) return

              const network = preferences.networkUrl
                ? await context.host.network.getText({
                    url: preferences.networkUrl,
                  })
                : null
              if (!isActive()) return

              const edit =
                source?.status === 'read'
                  ? context.documents.applyEdits({
                      requestId: crypto.randomUUID(),
                      target: source.target,
                      changes: [
                        {
                          from: source.source.length,
                          to: source.source.length,
                          expectedText: '',
                          insert: '\n#proof',
                        },
                      ],
                    })
                  : { status: source?.status ?? 'no-document' }
              if (!isActive()) return

              const note = await context.workspace.createText(
                target,
                'proof-note.md',
                '# Foundation proof\n\n#proof\n',
              )
              if (!isActive()) return

              const backlinks = await context.workspace.query({
                target,
                kind: 'backlinks',
                path: 'a.md',
              })
              if (!isActive()) return
              const workspace = await context.storage.workspace(
                {
                  id: target.workspaceId,
                  workspaceGeneration: target.workspaceGeneration,
                },
                'preferences',
                1,
              )
              if (!isActive()) return
              const previous = workspace.snapshot()
              if (previous.status !== 'missing' && previous.status !== 'ready')
                throw new Error(
                  'Foundation proof workspace preferences are unavailable.',
                )
              const workspaceTag =
                previous.status === 'ready' &&
                typeof previous.value?.tag === 'string'
                  ? previous.value.tag
                  : preferences.tag
              const previousRun =
                previous.status === 'ready'
                  ? previous.value?.lastRun?.run
                  : null
              const run =
                Number.isSafeInteger(previousRun) &&
                previousRun >= 0 &&
                Number.isSafeInteger(previousRun + 1)
                  ? previousRun + 1
                  : 1
              const tags = await context.workspace.query({
                target,
                kind: 'tag',
                tag: workspaceTag,
              })
              if (!isActive()) return
              const credentialStatus = await context.host.credentials.status({
                key: 'synthetic-probe',
              })
              if (!isActive()) return
              const credential =
                credentialStatus.ok &&
                credentialStatus.value.persistence !== 'protected'
                  ? await context.host.credentials.store({
                      key: 'synthetic-probe',
                      secret: 'fixture-only-not-a-credential',
                      mode: 'persistent',
                    })
                  : null
              if (!isActive()) return
              const result = {
                run,
                events: eventCount,
                edit: edit.status,
                note: note.ok ? 'created' : note.code,
                backlinks: backlinks.ok ? backlinks.value.items : [],
                tags: tags.ok ? tags.value.items : [],
                network: network
                  ? network.ok
                    ? {
                        status: network.value.status,
                        matchesFixture:
                          network.value.text === 'foundation-proof-ok',
                      }
                    : { code: network.code }
                  : null,
                credential: credential
                  ? credential.ok
                    ? 'unexpectedly-stored'
                    : credential.code
                  : credentialStatus.ok
                    ? credentialStatus.value.persistence
                    : credentialStatus.code,
              }
              const saved = await workspace.set({
                tag: workspaceTag,
                lastRun: result,
              })
              if (!isActive() || saved.status !== 'saved') return
              lastResult = `Proof run ${result.run}: ${result.edit}; ${result.note}.`
              panel.open({ id: 'results', focus: false })
            })
            pendingCapture = capture.catch(() => {})
            return capture
          },
        }),
      )

      if (preferences.globalShortcut) {
        try {
          const dispose = await context.globalShortcuts.register(
            'capture',
            SHORTCUT,
            'capture',
          )
          if (isActive()) disposers.push(dispose)
          else dispose()
        } catch {
          if (isActive())
            context.notify('Foundation proof global shortcut is unavailable.')
        }
      }
    },
    stop() {
      active = false
      activation++
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}
