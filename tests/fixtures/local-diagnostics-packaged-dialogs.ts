import { dialog } from 'electron'

// Imported before the app, so a start that fails while the app loads writes to
// the log instead of waiting on a modal no one answers.
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
dialog.showErrorBox = (title, content) => console.error(`${title}\n${content}`)
