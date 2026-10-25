import workerPath from '../_shared/import-worker?modulePath'
import { runImportWorker } from '../_shared/import-worker-client'
import type { NativeAddon } from '../api'
export default {
  id: 'import-bear',
  methods: {},
  import: (files) => runImportWorker(workerPath, 'bear', files),
} satisfies NativeAddon
