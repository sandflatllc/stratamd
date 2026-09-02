export interface ToolbarButtonOptions {
  className?: string
  pressed?: boolean
}

export function toolbarButton(
  label: string,
  action: () => void,
  options: ToolbarButtonOptions = {},
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  if (options.className) button.className = options.className
  if (options.pressed !== undefined) button.setAttribute('aria-pressed', String(options.pressed))
  button.addEventListener('click', action)
  return button
}
