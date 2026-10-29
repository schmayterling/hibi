/** Shared, view-only disclosure control for both document engines. */
export function updateCalloutToggle(
  button: HTMLButtonElement,
  title: string,
  expanded: boolean,
  toggle: () => void,
) {
  button.setAttribute('aria-expanded', String(expanded))
  button.setAttribute(
    'aria-label',
    `${expanded ? 'Collapse' : 'Expand'} callout: ${title}`,
  )
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
  updateCalloutToggle(button, title, expanded, toggle)
  return button
}
