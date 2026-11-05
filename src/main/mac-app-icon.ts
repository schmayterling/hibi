import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// Public NSWorkspace API, like Finder's Get Info icon. Paths stay in argv, not code.
// This adds Finder metadata outside Contents. Ordinary codesign verification passes,
// but --strict rejects that metadata; this is an explicit prototype tradeoff.
const script = `ObjC.import('AppKit');
function run(argv) {
  var image = $();
  if (argv[1]) {
    image = $.NSImage.alloc.initWithContentsOfFile(argv[1]);
    if (image.isNil()) throw new Error('Could not read the app icon.');
  }
  if (!$.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, argv[0], 0))
    throw new Error('Could not update the installed app icon.');
}`

export async function setMacAppIcon(bundle: string, icon: string | null) {
  await execute(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', '-e', script, bundle, icon ?? ''],
    { timeout: 10000 },
  )
}
