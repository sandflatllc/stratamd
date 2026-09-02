// A small in-editor form for the link and image commands (usability round 2
// §2.8). Electron never implements window.prompt, so the toolbar's Link and
// Image buttons and Ctrl+K used to fail silently. The form floats beside the
// selection: Enter applies, Escape cancels, and focus goes back to the editor.

export interface PopoverField {
  name: string
  label: string
  value: string
  placeholder?: string
}

export interface PopoverAnchor {
  left: number
  top: number
  bottom: number
}

export interface PopoverOptions {
  title: string
  fields: readonly PopoverField[]
  submitLabel: string
  /** A secondary action shown beside Cancel, such as Remove link. */
  secondary?: { label: string; onClick(): void }
  anchor: PopoverAnchor
  onSubmit(values: Record<string, string>): void
  onCancel(): void
}

export interface PopoverHandle {
  element: HTMLFormElement
  close(): void
}

const WIDTH = 340

/** Where a popover of the given size sits so it stays inside the window. */
export function popoverPosition(
  anchor: PopoverAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.round(Math.max(8, Math.min(viewport.width - size.width - 8, anchor.left)))
  const below = anchor.bottom + 8
  const fitsBelow = below + size.height <= viewport.height - 8
  const top = fitsBelow ? below : Math.max(8, anchor.top - size.height - 8)
  return { left, top: Math.round(top) }
}

export function openEditorPopover(host: HTMLElement, options: PopoverOptions): PopoverHandle {
  const form = document.createElement('form')
  form.className = 'editor-popover'
  form.setAttribute('role', 'dialog')
  form.setAttribute('aria-label', options.title)
  const heading = document.createElement('div')
  heading.className = 'editor-popover-title'
  heading.textContent = options.title
  form.append(heading)
  const inputs: HTMLInputElement[] = []
  for (const field of options.fields) {
    const label = document.createElement('label')
    const caption = document.createElement('span')
    caption.textContent = field.label
    const input = document.createElement('input')
    input.type = 'text'
    input.name = field.name
    input.value = field.value
    input.autocomplete = 'off'
    input.spellcheck = false
    if (field.placeholder) input.placeholder = field.placeholder
    input.setAttribute('aria-label', field.label)
    label.append(caption, input)
    form.append(label)
    inputs.push(input)
  }
  const actions = document.createElement('div')
  actions.className = 'editor-popover-actions'
  if (options.secondary) {
    const secondary = document.createElement('button')
    secondary.type = 'button'
    secondary.className = 'quiet-button'
    secondary.textContent = options.secondary.label
    secondary.addEventListener('click', () => options.secondary?.onClick())
    actions.append(secondary)
  }
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'quiet-button'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', () => options.onCancel())
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'primary-button'
  submit.textContent = options.submitLabel
  actions.append(cancel, submit)
  form.append(actions)

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const values: Record<string, string> = {}
    for (const input of inputs) values[input.name] = input.value
    options.onSubmit(values)
  })
  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    options.onCancel()
  })
  const away = (event: Event): void => {
    if (event.target instanceof Node && form.contains(event.target)) return
    options.onCancel()
  }
  window.addEventListener('pointerdown', away, true)

  host.append(form)
  const size = { width: Math.max(WIDTH, form.offsetWidth), height: form.offsetHeight || 160 }
  const position = popoverPosition(options.anchor, size, { width: window.innerWidth, height: window.innerHeight })
  form.style.left = `${position.left}px`
  form.style.top = `${position.top}px`
  form.style.width = `${WIDTH}px`
  inputs[0]?.focus()
  inputs[0]?.select()

  return {
    element: form,
    close() {
      window.removeEventListener('pointerdown', away, true)
      form.remove()
    },
  }
}
