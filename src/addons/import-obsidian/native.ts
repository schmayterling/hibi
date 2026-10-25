import workerPath from '../_shared/import-worker?modulePath'
import { runImportWorker } from '../_shared/import-worker-client'
import type { NativeAddon } from '../api'
export default {
  id: 'import-obsidian',
  methods: {},
  import: (files) => runImportWorker(workerPath, 'obsidian', files),
} satisfies NativeAddon
