import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const missing = (error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error
  return null
}

export function validateWorkspaceName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    !name ||
    name.startsWith('.') ||
    name === 'node_modules' ||
    /[\\/<>:"|?*]|\p{Cc}/u.test(name) ||
    /[. ]$/.test(name) ||
    Buffer.byteLength(name) > 255 ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw new Error(
      'Choose a file or folder name without slashes or reserved characters.',
    )
}

/** Resolve one workspace-relative entry without following symbolic links. */
export async function resolveWorkspaceEntry(
  base: string,
  value: unknown,
  allowMissing = false,
  allowRoot = false,
): Promise<string> {
  if (allowRoot && value === '') return base
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    isAbsolute(value)
  )
    throw new Error('Choose a file or folder inside this workspace.')
  const parts = value.split('/')
  let path = base
  for (const [index, part] of parts.entries()) {
    validateWorkspaceName(part)
    path = join(path, part)
    const stat = await lstat(path).catch(missing)
    if (!stat && allowMissing && index === parts.length - 1) return path
    if (!stat)
      throw Object.assign(
        new Error(
          'This path is missing or contains a symbolic link. Choose the original file or folder.',
        ),
        { code: 'ENOENT' },
      )
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 && !stat.isDirectory())
    )
      throw new Error(
        'This path is missing or contains a symbolic link. Choose the original file or folder.',
      )
  }
  return path
}
