import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  GitBranch,
  GitCommitHorizontal,
  Minus,
  Plus,
  RefreshCw,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import type { AddonContext } from '../api'
import {
  Button,
  ControlRow,
  IconButton,
  Panel,
  PanelMessage,
  Select,
  TextArea,
} from '../ui'
import type { GitFile, GitState, GitStatus } from './types'
import './git.css'

function CommitForm({
  draft,
  commit,
  close,
}: {
  draft: { message: string }
  commit: (message: string) => Promise<void>
  close: () => void
}) {
  const [message, setMessage] = useState(draft.message)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <form
      className="git-commit"
      onSubmit={async (event) => {
        event.preventDefault()
        if (busy || !message.trim()) return
        setBusy(true)
        setError('')
        try {
          await commit(message)
          draft.message = ''
          close()
        } catch (error) {
          setError(errorMessage(error))
        } finally {
          setBusy(false)
        }
      }}
    >
      <label htmlFor="git-message">Commit message</label>
      <TextArea
        id="git-message"
        autoFocus
        rows={4}
        value={message}
        maxLength={8000}
        disabled={busy}
        placeholder="Describe your changes…"
        onChange={(event) => {
          draft.message = event.target.value
          setMessage(event.target.value)
        }}
      />
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={busy || !message.trim()}>
        {busy ? 'Committing…' : 'Commit'}
      </Button>
    </form>
  )
}

export function GitPanel({
  context,
  draft,
}: {
  context: AddonContext
  draft: { message: string }
}) {
  const [state, setState] = useState<GitState | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null)
  const run = useCallback(
    async (method: string, input?: unknown) => {
      setBusy(true)
      setError('')
      try {
        if (method === 'state') {
          const result = await context.native.query<GitStatus>('status')
          setState(result.state)
          setNotice(result.notice)
        } else setState(await context.native.invoke<GitState>(method, input))
        setDiff(null)
      } catch (error) {
        setError(errorMessage(error))
      } finally {
        setBusy(false)
      }
    },
    [context],
  )
  useEffect(() => {
    void run('state')
  }, [run])
  async function preview(file: GitFile) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      setDiff({
        path: file.path,
        text: await context.native.invoke<string>('diff', file.path),
      })
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  async function openCommit() {
    const workspace = await context.workspace.get()
    context.dialogs.open({
      title: 'Commit changes',
      content: ({ close }) => (
        <CommitForm
          draft={draft}
          close={() => close(null)}
          commit={async (message) => {
            if ((await context.workspace.get())?.id !== workspace?.id)
              throw new Error(
                'The workspace changed. Reopen the commit dialog for this repository.',
              )
            setState(await context.native.invoke<GitState>('commit', message))
            setDiff(null)
          }}
        />
      ),
    })
  }
  if (!state)
    return (
      <Panel className="git-panel">
        <PanelMessage
          icon={error ? <CircleAlert size={32} /> : <GitBranch size={32} />}
          title={
            error
              ? 'Git unavailable'
              : busy
                ? 'Reading repository…'
                : 'No repository'
          }
          role={error ? 'alert' : 'status'}
          loading={busy}
        >
          {error || notice}
        </PanelMessage>
      </Panel>
    )
  return (
    <Panel className="git-panel">
      <div className="git-branch">
        <h3>Branch</h3>
        <Select
          aria-label="Git branch"
          disabled={busy || !state}
          value={state ? `refs/heads/${state.branch}` : ''}
          onChange={(event) => void run('switch', event.target.value)}
        >
          {state && !state.branches.includes(`refs/heads/${state.branch}`) && (
            <option value={`refs/heads/${state.branch}`}>{state.branch}</option>
          )}
          {state?.branches.map((branch) => (
            <option key={branch} value={branch}>
              {branch.replace(/^refs\/(heads|remotes)\//, '')}
            </option>
          ))}
        </Select>
      </div>
      <ControlRow className="git-actions">
        <IconButton
          aria-label="Refresh Git"
          title="Refresh Git"
          disabled={busy}
          onClick={() => void run('state')}
        >
          <RefreshCw size={14} />
        </IconButton>
        <IconButton
          aria-label={`Pull${state?.behind ? ` (${state.behind})` : ''}`}
          title="Pull"
          disabled={busy || !state}
          onClick={() => void run('pull')}
        >
          <ArrowDown size={14} />
          {state?.behind ? <span>{state.behind}</span> : null}
        </IconButton>
        <IconButton
          aria-label={`Push${state?.ahead ? ` (${state.ahead})` : ''}`}
          title="Push"
          disabled={busy || !state}
          onClick={() => void run('push')}
        >
          <ArrowUp size={14} />
          {state?.ahead ? <span>{state.ahead}</span> : null}
        </IconButton>
        <IconButton
          aria-label="Commit changes"
          title="Commit staged changes"
          disabled={
            busy ||
            !state.files.some((file) => ![' ', '?'].includes(file.index))
          }
          onClick={() => void openCommit()}
        >
          <GitCommitHorizontal size={14} />
        </IconButton>
      </ControlRow>
      {busy && <p role="status">Working…</p>}
      {error && <p role="alert">{error}</p>}
      {state && (
        <>
          {!state.files.length && (
            <PanelMessage icon={<Check size={32} />} title="Working tree clean">
              All changes are committed.
            </PanelMessage>
          )}
          {!!state.files.length && (
            <section className="git-files" aria-label="Changed files">
              <div className="git-section-header">
                <p className="git-section-label">
                  Changes · {state.files.length}
                </p>
                <Button
                  disabled={
                    busy ||
                    !state.files.some(
                      (file) => file.worktree !== ' ' || file.index === '?',
                    )
                  }
                  onClick={() => void run('stageAll')}
                >
                  Stage all
                </Button>
              </div>
              {state.files.map((file) => (
                <div className="git-file" key={file.path}>
                  <Button
                    variant="row"
                    type="button"
                    disabled={busy}
                    aria-pressed={diff?.path === file.path}
                    title={file.path}
                    onClick={() => void preview(file)}
                  >
                    <code>
                      {file.index}
                      {file.worktree}
                    </code>
                    <span>{file.path.split('/').at(-1)}</span>
                  </Button>
                  <IconButton
                    aria-label={`Stage ${file.path}`}
                    title="Stage"
                    disabled={
                      busy || (file.worktree === ' ' && file.index !== '?')
                    }
                    onClick={() => void run('stage', file.path)}
                  >
                    <Plus size={14} />
                  </IconButton>
                  <IconButton
                    aria-label={`Unstage ${file.path}`}
                    title="Unstage"
                    disabled={busy || [' ', '?'].includes(file.index)}
                    onClick={() => void run('unstage', file.path)}
                  >
                    <Minus size={14} />
                  </IconButton>
                </div>
              ))}
            </section>
          )}
          {diff && (
            <section aria-label={`Diff for ${diff.path}`}>
              <pre className="git-diff">{diff.text}</pre>
            </section>
          )}
        </>
      )}
    </Panel>
  )
}
