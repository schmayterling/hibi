import workerPath from '../_shared/import-worker?modulePath'
import { runImportWorker } from '../_shared/import-worker-client'
import type { NativeAddon } from '../api'
export default {
  id: 'import-notion',
  methods: {},
  import: (files) => runImportWorker(workerPath, 'notion', files),
} satisfies NativeAddon
