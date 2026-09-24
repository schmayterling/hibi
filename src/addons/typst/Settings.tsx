import { useState } from 'react'
import { SettingRow, Toggle } from '../ui'
import { setSystemCompiler, systemCompilerEnabled } from './preferences'

export function Settings() {
  const [system, setSystem] = useState(systemCompilerEnabled)
  return (
    <div className="settings-group">
      <SettingRow
        id="typst-system-compiler"
        label="Use system Typst"
        description="Use your installed Typst for previews and PDF export. Choose its executable in Settings → Dependencies."
      >
        <Toggle
          id="typst-system-compiler"
          checked={system}
          onChange={(event) => {
            setSystem(event.target.checked)
            setSystemCompiler(event.target.checked)
          }}
        />
      </SettingRow>
    </div>
  )
}
