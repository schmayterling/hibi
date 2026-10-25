import { nativeImport } from '../_shared/import-native'
import type { NativeAddon } from '../api'
export default {
  id: 'import-obsidian',
  methods: {},
  ...nativeImport('obsidian'),
} satisfies NativeAddon
