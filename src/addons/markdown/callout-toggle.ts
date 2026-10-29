/** Shared, view-only disclosure control for both document engines. */
export function updateCalloutToggle(
  button: HTMLButtonElement,
  title: string,
  expanded: boolean,
  toggle: () => void,
) {
  button.setAttribute('aria-expanded', String(expanded))
  // The name stays put while aria-expanded announces the state.
  button.setAttribute('aria-label', `Toggle callout: ${title}`)
  button.onclick = toggle
}

export function calloutToggle(
  title: string,
  expanded: boolean,
  toggle: () => void,
) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'github-alert-toggle'
  button.contentEditable = 'false'
  // Keep the caret and focus in the text, like a task checkbox.
  button.addEventListener('mousedown', (event) => event.preventDefault())
  updateCalloutToggle(button, title, expanded, toggle)
  return button
}
