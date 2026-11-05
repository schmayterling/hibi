export const RECOVERY_CHANNELS = {
  list: 'recovery:list',
  restore: 'recovery:restore',
  discard: 'recovery:discard',
  later: 'recovery:later',
  settings: 'recovery:settings',
  preview: 'recovery:preview-settings',
  setSettings: 'recovery:set-settings',
} as const

/** Days a copy nobody claimed stays after it was first offered; 0 keeps it until the size limit needs the room. */
export const recoveryDays = [7, 14, 30, 90, 365, 0] as const
export const recoveryMegabytes = [128, 256, 512, 1024, 4096] as const
/** Past this many at launch, the rest wait in the recovery prompt. */
export const RECOVERY_OPEN_LIMIT = 20

export type RecoverySettings = Readonly<{
  keep: boolean
  days: (typeof recoveryDays)[number]
  megabytes: (typeof recoveryMegabytes)[number]
  openAtLaunch: boolean
}>
export const defaultRecoverySettings: RecoverySettings = {
  keep: true,
  days: 30,
  megabytes: 512,
  openAtLaunch: false,
}

const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
/** Anything but an allowed value is its default, so a damaged file deletes nothing early. */
export function parseRecoverySettings(value: unknown): RecoverySettings {
  const { keep, days, megabytes, openAtLaunch } = record(value)
  return {
    keep: keep !== false,
    days:
      recoveryDays.find((allowed) => allowed === days) ??
      defaultRecoverySettings.days,
    megabytes:
      recoveryMegabytes.find((allowed) => allowed === megabytes) ??
      defaultRecoverySettings.megabytes,
    openAtLaunch: openAtLaunch === true,
  }
}

/** Text an earlier run left unsaved, as the recovery prompt shows it. */
export type RecoveryCopy = Readonly<{
  id: string
  name: string
  /** The note's folder; null for a note never saved. */
  folder: string | null
  time: number
  bytes: number
  /** Whether the note's file still holds the text these edits began from. */
  state: 'unchanged' | 'changed' | 'missing' | 'untitled'
  preview: string
}>
export type RecoveryWaiting = Readonly<{
  copies: readonly RecoveryCopy[]
  /** Copies only a newer version of Hibi can read; they stay as they are. */
  newer: number
  openAtLaunch: boolean
}>
