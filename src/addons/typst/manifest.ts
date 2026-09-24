import notice from '../../../docs/licenses/typst-assets.md?raw'
import { fileAssociations } from '../../shared/file-associations'
import type { AddonManifest } from '../api'
import { authors } from '../authors'

export default {
  id: 'typst',
  name: 'Typst',
  kind: 'extension',
  version: '1.0.3',
  settings: { icon: 'type' },
  apiVersion: 2,
  description: 'Write Typst documents with live previews and PDF export.',
  dependencies: [
    {
      id: 'typst',
      name: 'Typst',
      command: 'typst',
      homepage: 'https://typst.app/open-source/',
      reason:
        'Optional system compiler for previews and PDF export. Use Typst 0.15 or newer for variable fonts.',
      optional: true,
      install: { brew: { package: 'typst' }, winget: 'Typst.Typst' },
    },
  ],
  defaultEnabled: false,
  fileExtensions: fileAssociations.typst.ext,
  authors: [authors.may],
  licenses: [
    {
      id: 'typst-assets',
      name: 'Typst bundled fonts and assets',
      license: 'see notices',
      text: notice,
    },
  ],
} satisfies AddonManifest
