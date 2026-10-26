import { LockKeyhole } from 'lucide-react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { exportOptions } from '../addons/documentation/options'
import { Button, TextInput } from '../ui/Controls'
import type { LockedSite, SiteData } from './data'
import { startSite } from './main'
import { base64Bytes, decodeSiteMedia, siteMediaRecords } from './media'
import './site.css'

declare global {
  interface Window {
    __HIBI_WORKSPACE__?: SiteData | LockedSite
  }
}
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing site root.')
const root = createRoot(rootElement)
const data =
  window.__HIBI_WORKSPACE__ ??
  (JSON.parse(document.getElementById('workspace-data')?.textContent ?? '{}') as
    | SiteData
    | LockedSite)
async function openSite(data: SiteData, key?: CryptoKey) {
  await decodeSiteMedia(data, siteMediaRecords(), key)
  data.options = exportOptions(data.options, data.name, data.appearance)
  data.routing ??= 'hash'
  startSite(data, root)
}
function Unlock({ data }: { data: LockedSite }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <main className="site-unlock">
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          setBusy(true)
          setError('')
          try {
            if (!crypto.subtle)
              throw new Error('Open this file locally or serve it over HTTPS.')
            const material = await crypto.subtle.importKey(
              'raw',
              new TextEncoder().encode(password),
              'PBKDF2',
              false,
              ['deriveKey'],
            )
            const key = await crypto.subtle.deriveKey(
              {
                name: 'PBKDF2',
                salt: base64Bytes(data.salt),
                iterations: data.iterations,
                hash: 'SHA-256',
              },
              material,
              { name: 'AES-GCM', length: 256 },
              false,
              ['decrypt'],
            )
            const decoded = await crypto.subtle.decrypt(
              { name: 'AES-GCM', iv: base64Bytes(data.iv) },
              key,
              base64Bytes(data.ciphertext),
            )
            setPassword('')
            await openSite(JSON.parse(new TextDecoder().decode(decoded)), key)
          } catch (error) {
            setError(
              error instanceof Error &&
                (error.message.includes('HTTPS') ||
                  error.message.includes('SVG'))
                ? error.message
                : 'Incorrect password or damaged export.',
            )
            setBusy(false)
          }
        }}
      >
        <LockKeyhole size={28} aria-hidden />
        <h1>Protected site</h1>
        <label htmlFor="site-password">Password</label>
        <TextInput
          id="site-password"
          type="password"
          required
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={busy}
        />
        {error && <p role="alert">{error}</p>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
      </form>
    </main>
  )
}
if ('encrypted' in data) root.render(<Unlock data={data} />)
else
  void openSite(data).catch((error) =>
    root.render(
      <p role="alert">
        {error instanceof Error && error.message.includes('SVG')
          ? error.message
          : 'This export is damaged or incomplete.'}
      </p>,
    ),
  )
