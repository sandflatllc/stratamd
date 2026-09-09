/**
 * One-shot scripts the preview host runs inside a page (docs/plans/open/visual-review).
 * Each runs once, reads or acts, and returns bounded plain data. Nothing here
 * installs a palette, a card, or draft text in the page, and nothing lingers.
 */

/** Playwright-style locators the host accepts: a CSS selector, `text=…`, or `role=name[name='…']`. */
export interface ParsedLocator {
  kind: 'css' | 'text' | 'role'
  value: string
  name?: string
}

export function parseLocator(input: { selector?: string; locator?: string }): ParsedLocator {
  const raw = (input.locator ?? input.selector ?? '').trim()
  if (!raw) throw new Error('Provide a selector or locator')
  if (raw.startsWith('text=')) return { kind: 'text', value: raw.slice(5).replace(/^["']|["']$/g, '') }
  const role = /^role=([a-z]+)(?:\[name=(?:"([^"]*)"|'([^']*)')\])?$/i.exec(raw)
  if (role) return { kind: 'role', value: role[1]!.toLowerCase(), ...(role[2] ?? role[3] ? { name: role[2] ?? role[3] } : {}) }
  if (raw.startsWith('css=')) return { kind: 'css', value: raw.slice(4) }
  return { kind: 'css', value: raw }
}

/** Shared in-page helpers: an accessible role and name for any element, visibility, and a unique CSS path. */
const HELPERS = `
  const roleFor = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.split(/\\s+/)[0].toLowerCase();
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'input') { const t = (el.type || 'text').toLowerCase(); return ({ button: 'button', submit: 'button', reset: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox' })[t] || 'textbox'; }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'option') return 'option';
    if (tag === 'th') return 'columnheader';
    if (tag === 'td') return 'cell';
    if (tag === 'table') return 'table';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    if (tag === 'li') return 'listitem';
    if (tag === 'ul' || tag === 'ol') return 'list';
    return '';
  };
  const textOf = (node) => String(node && (node.innerText !== undefined ? node.innerText : node.textContent) || '').replace(/\\s+/g, ' ').trim();
  const nameFor = (el) => {
    const labelled = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelled) { const value = labelled.split(/\\s+/).map((id) => { const node = el.ownerDocument.getElementById(id); return node ? textOf(node) : ''; }).join(' ').trim(); if (value) return value; }
    const direct = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder'));
    if (direct) return String(direct).trim();
    if (el.labels && el.labels.length) return Array.from(el.labels).map(textOf).join(' ').trim();
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' && (el.type === 'submit' || el.type === 'button' || el.type === 'reset') && el.value) return String(el.value).trim();
    return textOf(el).slice(0, 240);
  };
  const visible = (el) => { if (!el || !el.getBoundingClientRect) return false; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const s = el.ownerDocument.defaultView.getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(tag + '#' + CSS.escape(node.id)); break; }
      let index = 1; let sibling = node.previousElementSibling;
      while (sibling) { if (sibling.tagName === node.tagName) index += 1; sibling = sibling.previousElementSibling; }
      parts.unshift(tag + ':nth-of-type(' + index + ')');
      node = node.parentElement;
    }
    return parts.join(' > ') || 'html';
  };
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; };
`

/** Finds the element a locator names; returns its rect and a stable selector, or a plain reason. */
export function findScript(locator: ParsedLocator, options: { scroll?: boolean } = {}): string {
  return `(() => {
    ${HELPERS}
    const locator = ${JSON.stringify(locator)};
    let el = null;
    try {
      if (locator.kind === 'css') el = document.querySelector(locator.value);
      else {
        const all = Array.from(document.querySelectorAll('body *')).filter(visible);
        if (locator.kind === 'text') el = all.find((node) => textOf(node) === locator.value && Array.from(node.children).every((child) => textOf(child) !== locator.value)) || all.find((node) => textOf(node).includes(locator.value) && Array.from(node.children).every((child) => !textOf(child).includes(locator.value)));
        else el = all.find((node) => roleFor(node) === locator.value && (locator.name === undefined || nameFor(node) === locator.name)) || all.find((node) => roleFor(node) === locator.value && locator.name !== undefined && nameFor(node).includes(locator.name));
      }
    } catch (error) { return { invalid: String(error && error.message || error) }; }
    if (!el) return { missing: true };
    if (${options.scroll ? 'true' : 'false'}) { try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {} }
    const editable = (() => { const tag = el.tagName.toLowerCase(); if (tag === 'textarea') return !el.disabled && !el.readOnly; if (tag === 'input') return !el.disabled && !el.readOnly && !['button','submit','reset','checkbox','radio','file','range','color'].includes((el.type || 'text').toLowerCase()); return el.isContentEditable === true; })();
    return { rect: rectOf(el), selector: cssPath(el), role: roleFor(el), name: nameFor(el), editable, visible: visible(el) };
  })()`
}

/** Focuses a found element, and clears it when asked, so typed text lands where the agent meant. */
export function focusScript(selector: string, clear: boolean): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    if (${clear ? 'true' : 'false'}) {
      if ('value' in el) { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); if (setter && setter.set) setter.set.call(el, ''); else el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
      else if (el.isContentEditable) { el.textContent = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    return document.activeElement === el;
  })()`
}

/** Whether the focused element takes text. */
export const FOCUSED_EDITABLE_SCRIPT = `(() => {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return !el.disabled && !el.readOnly;
  if (tag === 'input') return !el.disabled && !el.readOnly && !['button','submit','reset','checkbox','radio','file','range','color'].includes((el.type || 'text').toLowerCase());
  return el.isContentEditable === true;
})()`

/** The page as the agent reads it: text, interactive things with plain names, and a bounded accessibility outline. */
export function snapshotScript(limits: { text: number; elements: number; nodes: number }): string {
  return `(() => {
    ${HELPERS}
    const interactive = [];
    const candidates = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, summary, [role], [tabindex], [contenteditable="true"]'));
    for (const el of candidates) {
      if (!visible(el)) continue;
      const role = roleFor(el) || (el.hasAttribute('tabindex') ? 'generic' : '');
      if (!role) continue;
      interactive.push({ tag: el.tagName.toLowerCase(), role, name: nameFor(el).slice(0, 200), selector: cssPath(el), ...rectOf(el) });
      if (interactive.length >= ${limits.elements}) break;
    }
    let count = 0;
    const outline = (el) => {
      if (count >= ${limits.nodes} || !visible(el)) return null;
      count += 1;
      const role = roleFor(el);
      const children = [];
      for (const child of Array.from(el.children)) { const node = outline(child); if (node) children.push(node); }
      if (!role && children.length === 0) return null;
      const node = { role: role || 'generic', name: role ? nameFor(el).slice(0, 120) : '' };
      if (children.length) node.children = children;
      return node;
    };
    return {
      url: location.href,
      title: document.title,
      visibleText: textOf(document.body).slice(0, ${limits.text}),
      interactiveElements: interactive,
      accessibilityTree: outline(document.body) || { role: 'document', name: document.title },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  })()`
}

/** Whether every wait condition holds right now. */
export function waitConditionScript(input: { locator?: ParsedLocator; text?: string; urlIncludes?: string }): string {
  return `(() => {
    ${HELPERS}
    const input = ${JSON.stringify({ text: input.text ?? null, urlIncludes: input.urlIncludes ?? null })};
    if (input.urlIncludes !== null && !location.href.includes(input.urlIncludes)) return false;
    if (input.text !== null && !textOf(document.body).includes(input.text)) return false;
    ${input.locator ? `{ const found = ${findScript(input.locator).replace(/^\(\(\) => \{/, '(() => {')}; if (!found || !found.rect || !found.visible) return false; }` : ''}
    return true;
  })()`
}

/** Scrolls a container, or the page, by a delta; the page's own scroll handlers see it. */
export function scrollScript(selector: string | null, deltaX: number, deltaY: number): string {
  return `(() => {
    const target = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'null'};
    if (${selector ? 'true' : 'false'} && !target) return false;
    if (target) target.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: 'instant' }); else window.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: 'instant' });
    return true;
  })()`
}

/** Key names T3 sends, mapped to what Chromium's key event needs. */
export function keyEvent(key: string): { keyCode: string; char: string | null } {
  const named: Record<string, string> = { enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', space: ' ', arrowdown: 'Down', arrowup: 'Up', arrowleft: 'Left', arrowright: 'Right', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' }
  const lower = key.trim().toLowerCase()
  if (named[lower]) return { keyCode: named[lower]!, char: lower === 'space' ? ' ' : lower === 'enter' || lower === 'return' ? '\r' : null }
  if (key.length === 1) return { keyCode: key, char: key }
  if (/^f\d{1,2}$/i.test(key)) return { keyCode: key.toUpperCase(), char: null }
  return { keyCode: key, char: null }
}
