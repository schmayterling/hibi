import { nativeImport } from '../_shared/import-native'
import type { NativeAddon } from '../api'
export default {
  id: 'import-bear',
  methods: {},
  ...nativeImport('bear'),
} satisfies NativeAddon
