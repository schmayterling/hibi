import type { AddonManifest } from '../api'
import { authors } from '../authors'
import soundsLicense from './LICENSE.kbsim.md?raw'
import keybeatsLicense from './LICENSE.keybeats.md?raw'

export default {
  id: 'keybeats',
  name: 'keyBeats',
  version: '1.0.1',
  settings: { icon: 'audio-lines' },
  apiVersion: 2,
  description: 'Play mechanical keyboard sounds while you write.',
  defaultEnabled: false,
  startup: 'background',
  authors: [{ ...authors.may, role: 'Hibi port' }],
  licenses: [
    { id: 'keybeats', name: 'keyBeats', license: 'MIT', text: keybeatsLicense },
    { id: 'kbsim', name: 'Kbsim sounds', license: 'MIT', text: soundsLicense },
  ],
} satisfies AddonManifest
