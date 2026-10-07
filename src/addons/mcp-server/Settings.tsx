import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import {
  Button,
  ControlRow,
  DocumentNotice,
  SettingRow,
  TextInput,
} from '../ui'
import {
  getPreferences,
  newToken,
  setPreferences,
  validPort,
} from './preferences'
import type { ServerStatus } from './types'

export function Settings() {
  const root = useRef<HTMLDivElement>(null)
  const [preferences, setLocal] = useState(getPreferences)
  const [port, setPort] = useState(String(preferences.port))
  const [portError, setPortError] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [copied, setCopied] = useState('')
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const refresh = () => {
      if (!root.current?.checkVisibility()) return
      void window.hibi
        .queryAddon('mcp-server', 'status')
        .then((value) => {
          if (active) setStatus(value as ServerStatus)
        })
        .catch((error) => {
          if (active) setError(errorMessage(error))
        })
    }
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])
  const url = `http://127.0.0.1:${preferences.port}/mcp`
  const command = `claude mcp add --transport http hibi ${url} --header "Authorization: Bearer ${preferences.token}"`
  const savePort = () => {
    const value = Number(port.trim())
    if (!validPort(value)) {
      setPortError('Enter a port between 1024 and 65535.')
      return
    }
    setLocal(setPreferences({ port: value }))
    setPort(String(value))
    setPortError('')
  }
  const copy = (key: string, text: string) =>
    navigator.clipboard.writeText(text).then(
      () => setCopied(key),
      () => setError('Could not copy. Select the text and copy it instead.'),
    )
  const copyButton = (key: string, text: string) => (
    <Button onClick={() => void copy(key, text)}>
      {copied === key ? 'Copied' : 'Copy'}
    </Button>
  )
  return (
    <div ref={root}>
      {status && (
        <DocumentNotice
          variant={status.state === 'error' ? 'warning' : 'default'}
          title={
            status.state === 'running'
              ? 'Server running'
              : status.state === 'error'
                ? 'Server unavailable'
                : 'Server stopped'
          }
          message={
            status.state === 'running'
              ? `AI tools can connect at ${status.url}.`
              : status.message
          }
        />
      )}
      {error && (
        <DocumentNotice
          variant="warning"
          title="MCP server unavailable"
          message={error}
        />
      )}
      <div className="settings-group">
        <SettingRow
          id="mcp-server-port"
          label="Port"
          description={
            portError ||
            'The server listens on this port on this computer only. Press Enter or leave the field to apply it.'
          }
        >
          <TextInput
            id="mcp-server-port"
            style={{ width: 'min(120px, 100%)', flexShrink: 0 }}
            inputMode="numeric"
            spellCheck={false}
            value={port}
            aria-invalid={!!portError}
            onChange={(event) => {
              setPort(event.target.value)
              setPortError('')
            }}
            onBlur={savePort}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                savePort()
              }
            }}
          />
        </SettingRow>
        <SettingRow
          id="mcp-server-url"
          label="Endpoint URL"
          description="Add this address to your AI tool as a streamable HTTP MCP server."
        >
          <ControlRow>
            <TextInput id="mcp-server-url" monospace readOnly value={url} />
            {copyButton('url', url)}
          </ControlRow>
        </SettingRow>
        <SettingRow
          id="mcp-server-token"
          label="Access token"
          description="Clients send this token in the Authorization header. Regenerating it disconnects every client that uses the old token."
        >
          <ControlRow>
            <TextInput
              id="mcp-server-token"
              type={showToken ? 'text' : 'password'}
              monospace
              readOnly
              value={preferences.token}
            />
            <Button onClick={() => setShowToken(!showToken)}>
              {showToken ? 'Hide' : 'Show'}
            </Button>
            {copyButton('token', preferences.token)}
            <Button
              onClick={() => {
                setLocal(setPreferences({ token: newToken() }))
                setCopied('')
              }}
            >
              Regenerate
            </Button>
          </ControlRow>
        </SettingRow>
      </div>
      <h2>Connect Claude Code</h2>
      <div className="settings-group">
        <SettingRow
          id="mcp-server-claude-code"
          label="Setup command"
          description="Run this command in a terminal to add Hibi to Claude Code. It includes your access token, so keep it private."
        >
          <ControlRow>
            <TextInput
              id="mcp-server-claude-code"
              monospace
              readOnly
              value={
                showToken
                  ? command
                  : command.replace(preferences.token, '<access token>')
              }
            />
            {copyButton('command', command)}
          </ControlRow>
        </SettingRow>
      </div>
    </div>
  )
}
