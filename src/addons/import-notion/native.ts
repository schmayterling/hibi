import { nativeImport } from '../_shared/import-native'
import type { NativeAddon } from '../api'
export default {
  id: 'import-notion',
  methods: {},
  ...nativeImport('notion'),
} satisfies NativeAddon
