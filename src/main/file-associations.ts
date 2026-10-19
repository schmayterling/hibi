import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { app, shell } from 'electron'
import {
  DESKTOP_APP_ID,
  type FileAssociationState,
  fileAssociations,
} from '../shared/file-associations'
import { getAddonStates } from './addons'

const execute = promisify(execFile)
const formats = Object.values(fileAssociations)
const desktopId = `${DESKTOP_APP_ID}.desktop`

// Public Launch Services APIs; argv keeps extensions separate from executable code.
const macScript = `ObjC.import('CoreServices');
function run(argv) {
  var mode = argv.shift(), appId = argv.shift(), defaults = [];
  argv.forEach(function(ext) {
    var type = $.UTTypeCreatePreferredIdentifierForTag($.kUTTagClassFilenameExtension, $(ext), null);
    if (mode === 'set') {
      var status = $.LSSetDefaultRoleHandlerForContentType(type, $.kLSRolesAll, $(appId));
      if (status !== 0) throw new Error('Launch Services error ' + status);
    }
    var handler = $.LSCopyDefaultRoleHandlerForContentType(type, $.kLSRolesAll);
    if (ObjC.unwrap(ObjC.castRefToObject(handler)) === appId) defaults.push(ext);
  });
  return JSON.stringify(defaults);
}`

async function macDefaults(mode: 'get' | 'set', extensions: string[]) {
  const { stdout } = await execute(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', '-e', macScript, mode, DESKTOP_APP_ID, ...extensions],
    { timeout: 15000 },
  )
  return JSON.parse(stdout) as string[]
}

export async function getFileAssociations(): Promise<FileAssociationState> {
  const state: FileAssociationState = {
    // Flatpak's sandbox cannot change host defaults; its exported entry offers Open With.
    available: app.isPackaged && !process.env.FLATPAK_ID,
    systemSettings: process.platform === 'win32',
    defaults: [],
  }
  if (!state.available) return state
  if (process.platform === 'darwin') {
    state.defaults = await macDefaults(
      'get',
      formats.flatMap(({ ext }) => ext),
    ).catch(() => [])
  } else if (process.platform === 'linux') {
    const registered = await readFile(
      join(linuxDataHome(), 'applications', desktopId),
      'utf8',
    ).catch(() => '')
    if (
      !registered
        .split('\n')
        .includes(
          `Exec=${desktopExec(process.env.APPIMAGE || process.execPath)}`,
        )
    )
      return state
    const defaults = await Promise.all(
      formats.map(async ({ ext, mimeType }) => {
        const { stdout } = await execute(
          'xdg-mime',
          ['query', 'default', mimeType],
          { timeout: 5000 },
        ).catch(() => ({ stdout: '' }))
        return stdout.trim() === desktopId ? ext : []
      }),
    )
    state.defaults = defaults.flat()
  }
  return state
}

// Desktop entries have both key-value escaping and quoted Exec argument escaping.
export function desktopExec(path: string) {
  if (!isAbsolute(path) || /[\r\n\0]/.test(path))
    throw new Error('Invalid application path.')
  return `"${path
    .replaceAll('\\', '\\\\')
    .replace(/["\x60$]/g, '\\$&')
    .replaceAll('%', '%%')
    .replaceAll('\\', '\\\\')}" %F`
}

function linuxDataHome() {
  const dataHome = process.env.XDG_DATA_HOME
  return dataHome && isAbsolute(dataHome)
    ? dataHome
    : join(homedir(), '.local/share')
}

async function registerLinuxApplication() {
  const executable = process.env.APPIMAGE || process.execPath
  const exec = desktopExec(executable)
  const data = linuxDataHome()
  const applications = join(data, 'applications')
  const icons = join(data, 'icons/hicolor/256x256/apps')
  const mime = join(data, 'mime/packages')
  await Promise.all(
    [applications, icons, mime].map((path) => mkdir(path, { recursive: true })),
  )
  await copyFile(
    join(process.resourcesPath, 'icons/icon-linux.png'),
    join(icons, `${DESKTOP_APP_ID}.png`),
  )
  await writeFile(
    join(applications, desktopId),
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=hibi',
      'Comment=Document editor',
      `Exec=${exec}`,
      `Icon=${DESKTOP_APP_ID}`,
      'Terminal=false',
      'Categories=Office;TextEditor;',
      `MimeType=${formats.map(({ mimeType }) => mimeType).join(';')};`,
      '',
    ].join('\n'),
  )
  await writeFile(
    join(mime, `${DESKTOP_APP_ID}.xml`),
    `<?xml version="1.0" encoding="UTF-8"?>\n<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">\n${formats.map(({ name, ext, mimeType }) => `<mime-type type="${mimeType}"><comment>${name} document</comment>${mimeType === 'text/plain' ? '' : '<sub-class-of type="text/plain"/>'}${ext.map((value) => `<glob pattern="*.${value}"/>`).join('')}</mime-type>`).join('\n')}\n</mime-info>\n`,
  )
  await execute('update-mime-database', [join(data, 'mime')], {
    timeout: 15000,
  })
  await execute('update-desktop-database', [applications], { timeout: 15000 })
}

export async function setFileAssociation(value: unknown): Promise<void> {
  if (typeof value !== 'string' || !Object.hasOwn(fileAssociations, value))
    throw new Error('Unknown document format.')
  if (!app.isPackaged) throw new Error('Install Hibi to manage file defaults.')
  if (process.env.FLATPAK_ID)
    throw new Error(
      'Choose Hibi in your system settings or your file manager’s Open With menu.',
    )
  if (
    value !== 'text' &&
    !getAddonStates().some(({ id, enabled }) => id === value && enabled)
  )
    throw new Error('Enable this format in Settings → Addons first.')
  const format = fileAssociations[value as keyof typeof fileAssociations]
  if (process.platform === 'win32') {
    await shell.openExternal(
      `ms-settings:defaultapps?registeredAppUser=${DESKTOP_APP_ID}`,
    )
  } else if (process.platform === 'darwin') {
    try {
      const defaults = await macDefaults('set', format.ext)
      if (!format.ext.every((ext) => defaults.includes(ext)))
        throw new Error('Not applied.')
    } catch {
      throw new Error(
        'Could not change the default app. In Finder, select a file, choose Get Info → Open with → Hibi → Change All.',
      )
    }
  } else if (process.platform === 'linux') {
    try {
      await registerLinuxApplication()
      await execute('xdg-mime', ['default', desktopId, format.mimeType], {
        timeout: 10000,
      })
      const { stdout } = await execute(
        'xdg-mime',
        ['query', 'default', format.mimeType],
        { timeout: 5000 },
      )
      if (stdout.trim() !== desktopId) throw new Error('Not applied.')
    } catch {
      throw new Error(
        'Could not change the default app. Install xdg-utils, shared-mime-info and desktop-file-utils, then try again or choose Hibi in your file manager’s Open With settings.',
      )
    }
  } else throw new Error('File defaults are unavailable on this platform.')
}
