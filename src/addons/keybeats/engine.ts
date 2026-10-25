import { Volume2, VolumeX } from 'lucide-react'
import type { AddonContext, EditorKeyEvent } from '../api'
import { getPreferences, setPreferences, settingsEvent } from './preferences'
import { profiles } from './profiles'

// URLs stay in this lazy module. Only the selected keyboard is fetched/decoded.
const urls = import.meta.glob<string>('./sounds/**/*.mp3', {
  eager: true,
  query: '?url&no-inline',
  import: 'default',
})
export function startKeybeats(context: AddonContext) {
  const audio = new AudioContext({ latencyHint: 'interactive' })
  const gain = audio.createGain()
  gain.connect(audio.destination)
  const voices = new Set<AudioBufferSourceNode>()
  const held = new Set<string>()
  let preferences = getPreferences()
  let samples = new Map<string, AudioBuffer>()
  let generation = 0
  let playback = 0
  let disposed = false
  let blurred = false
  let awake = false
  let idle: ReturnType<typeof setTimeout> | undefined
  let suspension = Promise.resolve()
  const eligible = () =>
    !disposed &&
    !preferences.muted &&
    !!preferences.volume &&
    !document.hidden &&
    !blurred
  const action = context.toolbar.register({
    id: 'mute',
    label: 'Mute keyboard sounds',
    icon: Volume2,
    onClick: () => setPreferences({ muted: !getPreferences().muted }),
  })
  const silence = () => {
    playback++
    held.clear()
    for (const voice of voices) voice.stop()
    voices.clear()
  }
  function pause() {
    awake = false
    clearTimeout(idle)
    silence()
    suspension = audio.suspend().catch(() => {})
  }
  async function load() {
    const run = ++generation
    samples = new Map()
    pause()
    const profile =
      profiles.find((entry) => entry.id === preferences.profile) ?? profiles[0]
    try {
      const paths = [
        ...new Set([
          ...Object.values(profile.press),
          ...Object.values(profile.release),
        ]),
      ]
      const entries = await Promise.all(
        paths.map(async (path) => {
          const url = urls[`./sounds/${path}`]
          if (!url) throw new Error('Sound unavailable.')
          const response = await fetch(url)
          if (!response.ok) throw new Error('Sound unavailable.')
          const buffer = await audio.decodeAudioData(
            await response.arrayBuffer(),
          )
          return [path, buffer] as const
        }),
      )
      if (!disposed && generation === run) samples = new Map(entries)
    } catch {
      if (!disposed && generation === run)
        context.notify(
          'Could not load this keyboard sound. Choose another keyboard.',
        )
    }
  }
  function configure() {
    const previous = preferences.profile
    preferences = getPreferences()
    gain.gain.value = preferences.muted ? 0 : preferences.volume
    if (preferences.muted || !preferences.volume) pause()
    action.update({
      label: preferences.muted
        ? 'Unmute keyboard sounds'
        : 'Mute keyboard sounds',
      icon: preferences.muted ? VolumeX : Volume2,
      pressed: preferences.muted,
    })
    if (previous !== preferences.profile) void load()
  }
  async function play(event: EditorKeyEvent) {
    if (event.phase === 'up' && !held.delete(event.code)) return
    if (!eligible() || event.repeat) return
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      [
        'Shift',
        'Control',
        'Meta',
        'Alt',
        'CapsLock',
        'Dead',
        'Process',
      ].includes(event.key)
    )
      return
    if (event.phase === 'down') {
      if (held.has(event.code)) return
      held.add(event.code)
    }
    const profile =
      profiles.find((entry) => entry.id === preferences.profile) ?? profiles[0]
    const map: Record<string, string> =
      event.phase === 'down' ? profile.press : profile.release
    const key = event.key === ' ' ? 'SPACE' : event.key.toUpperCase()
    const generic = Object.keys(map).filter((key) => key.startsWith('GENERIC'))
    const path =
      map[key] ?? map[generic[Math.floor(Math.random() * generic.length)] ?? '']
    const buffer = path ? samples.get(path) : undefined
    if (!buffer || audio.state === 'closed') return
    const run = playback
    awake = true
    clearTimeout(idle)
    idle = setTimeout(pause, 10000)
    await suspension
    if (run !== playback || !eligible()) return
    if (audio.state !== 'running') await audio.resume()
    if (disposed) return
    // A resume may settle after mute, blur, or the idle timer.
    if (!awake) {
      pause()
      return
    }
    if (run !== playback || !eligible()) return
    if (voices.size >= 32) {
      const oldest = voices.values().next().value
      oldest?.stop()
      if (oldest) voices.delete(oldest)
    }
    const voice = audio.createBufferSource()
    voice.buffer = buffer
    voice.connect(gain)
    voices.add(voice)
    voice.onended = () => {
      voices.delete(voice)
      voice.disconnect()
    }
    voice.start()
  }
  const unsubscribe = context.editor.onKeyEvent((event) => {
    void play(event).catch(() => {})
  })
  const leave = () => {
    blurred = true
    pause()
  }
  const enter = () => {
    blurred = false
  }
  const visibility = () => {
    if (document.hidden) pause()
  }
  // Leaving the editor may swallow a keyup (for example Tab into a dialog).
  const focus = () => {
    if (!document.activeElement?.closest('.tiptap, .cm-content')) pause()
  }
  window.addEventListener(settingsEvent, configure)
  window.addEventListener('blur', leave)
  window.addEventListener('focus', enter)
  document.addEventListener('visibilitychange', visibility)
  document.addEventListener('focusin', focus)
  configure()
  void load()
  return () => {
    disposed = true
    generation++
    unsubscribe()
    action.dispose()
    pause()
    window.removeEventListener(settingsEvent, configure)
    window.removeEventListener('blur', leave)
    window.removeEventListener('focus', enter)
    document.removeEventListener('visibilitychange', visibility)
    document.removeEventListener('focusin', focus)
    gain.disconnect()
    samples.clear()
    void audio.close().catch(() => {})
  }
}
