/**
 * One-shot page queries for marking up a running page
 * (docs/plans/open/visual-review, phase 3). Each script runs once inside the
 * page, returns bounded descriptive data, and leaves nothing behind but a
 * short-lived outline the owner asked for. No palette, card, or draft text is
 * ever injected; Strata's own interface draws over its capture instead.
 *
 * Three facts stay apart in what comes back: what the owner selected (the
 * rect and plain label), whether Strata can find it again right now (a
 * unique match), and which source locations describe it, if any (build-time
 * stamps when present, React fiber when present, nothing otherwise).
 *
 * The element description, frame and shadow traversal, selector ladder, and
 * stamp chain are Outcrop's picker reshaped into queries driven from
 * Strata's interface; the fiber ladder and the plain names are new.
 */

export interface PageRect { x: number; y: number; width: number; height: number }

export interface PageSource { file: string; line: number; column: number; role: 'definition' | 'usage' | 'candidate' }

/** What the agent needs to find the thing again; never shown in a control. */
export interface PageIdentity {
  role: string | null
  name: string | null
  text: string | null
  testIds: string[]
  selector: string | null
  html: string | null
  style: Record<string, string>
  sources: PageSource[]
  viewportRect: PageRect
  pageRect: PageRect
}

export interface PageDescription {
  kind: 'element' | 'region'
  /** A plain name taken from the page: label, role, text, or title, with the kind of thing it is. */
  label: string
  /** In CSS pixels of the page's viewport. */
  rect: PageRect
  identity: PageIdentity | null
  scroll: { x: number; y: number }
  viewport: { width: number; height: number }
}

export interface PageMatch {
  rect: PageRect
  scroll: { x: number; y: number }
  /** How many things matched; only exactly one is a confident match. */
  matches: number
}

/** Style properties the brief carries: the ones a visual request is usually about, nothing more. */
export const RELEVANT_STYLE = ['font-size', 'font-weight', 'font-family', 'line-height', 'color', 'background-color', 'padding', 'margin', 'border', 'border-radius', 'display', 'width', 'height', 'gap', 'text-align', 'position'] as const

const LIMITS = { name: 40, text: 240, html: 220, testIds: 6, sources: 8 }

/** Shared in-page helpers: identity, plain names, traversal, and the selector ladder. Wrapped as a function body string. */
const HELPERS = `
  const LIMITS = ${JSON.stringify(LIMITS)};
  const RELEVANT = ${JSON.stringify(RELEVANT_STYLE)};
  const WORDS = { table: 'Table', thead: 'Table header', tbody: 'Table body', tfoot: 'Table footer', tr: 'Row', th: 'Header cell', td: 'Cell', nav: 'Navigation', form: 'Form', img: 'Image', svg: 'Icon', picture: 'Image', video: 'Video', h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading', p: 'Paragraph', li: 'List item', ul: 'List', ol: 'List', dl: 'List', input: 'Field', textarea: 'Text box', select: 'Dropdown', label: 'Label', a: 'Link', button: 'Button', header: 'Header', footer: 'Footer', aside: 'Sidebar', main: 'Main area', section: 'Section', article: 'Section', dialog: 'Dialog', summary: 'Summary', details: 'Details', figure: 'Figure', blockquote: 'Quote', pre: 'Code block', code: 'Code', legend: 'Legend', fieldset: 'Field group', output: 'Output', progress: 'Progress bar', meter: 'Meter', hr: 'Divider', canvas: 'Drawing', iframe: 'Frame' };
  const ROLE_WORDS = { button: 'Button', link: 'Link', heading: 'Heading', textbox: 'Text box', checkbox: 'Checkbox', radio: 'Radio button', combobox: 'Dropdown', listbox: 'List', option: 'Option', menu: 'Menu', menuitem: 'Menu item', tab: 'Tab', tablist: 'Tabs', tabpanel: 'Tab panel', dialog: 'Dialog', alert: 'Alert', status: 'Status', img: 'Image', table: 'Table', row: 'Row', cell: 'Cell', columnheader: 'Header cell', rowheader: 'Header cell', grid: 'Table', list: 'List', listitem: 'List item', navigation: 'Navigation', banner: 'Header', contentinfo: 'Footer', main: 'Main area', region: 'Section', switch: 'Switch', slider: 'Slider', progressbar: 'Progress bar', tooltip: 'Tooltip', toolbar: 'Toolbar', search: 'Search', form: 'Form', group: 'Group', separator: 'Divider', figure: 'Figure', article: 'Section', note: 'Note', badge: 'Badge' };
  function escIdent(value) { return window.CSS && typeof window.CSS.escape === 'function' ? window.CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, function (ch) { return '\\\\' + ch; }); }
  function round(rect) { return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }; }
  function visible(el) { const rect = el.getBoundingClientRect(); if (!rect || rect.width <= 0 || rect.height <= 0) return false; const style = el.ownerDocument.defaultView.getComputedStyle(el); return style.visibility !== 'hidden' && style.display !== 'none'; }
  function globalRect(el) {
    const local = el.getBoundingClientRect();
    let x = local.x, y = local.y;
    let view = el.ownerDocument && el.ownerDocument.defaultView;
    while (view && view !== window && view.frameElement) { const frame = view.frameElement.getBoundingClientRect(); x += frame.x; y += frame.y; view = view.frameElement.ownerDocument.defaultView; }
    return { x: x, y: y, width: local.width, height: local.height };
  }
  function ownerParent(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    if (root && root.host) return root.host;
    const view = node.ownerDocument && node.ownerDocument.defaultView;
    return view && view !== window ? view.frameElement : null;
  }
  function strataOwn(el) { return !!(el && el.closest && el.closest('[data-strata-visual]')); }
  function roleFor(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.split(/\\s+/)[0];
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'input') return ({ button: 'button', submit: 'button', reset: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider' })[el.type] || 'textbox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'th') return 'columnheader';
    if (tag === 'td') return 'cell';
    if (tag === 'li') return 'listitem';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'nav') return 'navigation';
    if (tag === 'form') return 'form';
    if (tag === 'dialog') return 'dialog';
    return null;
  }
  function ownText(el) { return String(el.textContent || el.value || '').replace(/\\s+/g, ' ').trim(); }
  function nameFor(el) {
    const labelled = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelled) { const value = labelled.split(/\\s+/).map(function (id) { const node = el.ownerDocument.getElementById(id); return node ? node.textContent : ''; }).join(' ').trim(); if (value) return value; }
    const direct = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder'));
    if (direct) return String(direct).trim();
    if (el.labels && el.labels.length) { const text = Array.from(el.labels).map(function (label) { return ownText(label); }).join(' ').trim(); if (text) return text; }
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'img' || tag === 'svg' || tag === 'canvas' || tag === 'video' || tag === 'iframe') return '';
    return ownText(el);
  }
  function kindWord(el) {
    const role = roleFor(el);
    if (role && ROLE_WORDS[role]) return ROLE_WORDS[role];
    const tag = String(el.tagName || '').toLowerCase();
    if (WORDS[tag]) return WORDS[tag];
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.backgroundImage && style.backgroundImage !== 'none') return 'Image';
    const children = el.children ? el.children.length : 0;
    if (children === 0 && ownText(el)) return 'Text';
    return 'Section';
  }
  const NAMED = ['Button', 'Link', 'Heading', 'Text box', 'Field', 'Dropdown', 'Checkbox', 'Radio button', 'Switch', 'Tab', 'Menu item', 'Option', 'Image', 'Cell', 'Header cell', 'Label', 'Paragraph', 'Text', 'List item', 'Badge', 'Status', 'Alert', 'Summary', 'Legend', 'Slider', 'Tooltip', 'Quote', 'Code'];
  const BARE = ['Text', 'Paragraph', 'Heading', 'Cell', 'Header cell', 'Label', 'List item', 'Option', 'Menu item', 'Tab', 'Quote', 'Code'];
  function plainLabel(el) {
    let word = kindWord(el);
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'tr' && el.parentElement && String(el.parentElement.tagName).toLowerCase() === 'thead') word = 'Table header';
    // A container is named by what it is; a control or a piece of text keeps its own words, cut short when long.
    if (NAMED.indexOf(word) < 0) return word;
    let name = nameFor(el);
    if (name.length > LIMITS.name) { const cut = name.slice(0, LIMITS.name); name = cut.slice(0, cut.lastIndexOf(' ') > 12 ? cut.lastIndexOf(' ') : LIMITS.name) + '…'; }
    if (!name) return word;
    if (BARE.indexOf(word) >= 0) return name;
    return name + ' ' + word.toLowerCase();
  }
  function domSelectorFor(el) {
    const parts = [];
    let node = el;
    const ownerDocument = el.ownerDocument || document;
    while (node && node.nodeType === 1 && node !== ownerDocument.documentElement) {
      const tag = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(tag + '#' + escIdent(node.id)); break; }
      const testid = node.getAttribute && node.getAttribute('data-testid');
      if (testid) { parts.unshift('[data-testid="' + testid.replace(/"/g, '\\\\"') + '"]'); node = node.parentElement; continue; }
      let index = 1; let prev = node.previousElementSibling;
      while (prev) { if (prev.tagName === node.tagName) index += 1; prev = prev.previousElementSibling; }
      parts.unshift(tag + ':nth-of-type(' + index + ')');
      node = node.parentElement;
    }
    const local = parts.join(' > ') || 'body';
    const root = el.getRootNode && el.getRootNode();
    if (root && root.host) return domSelectorFor(root.host) + ' >>> ' + local;
    const view = root && root.defaultView;
    return view && view !== window && view.frameElement ? domSelectorFor(view.frameElement) + ' ||| ' + local : local;
  }
  function resolveSelector(selector) {
    try {
      const frames = String(selector).split(/\\s*\\|\\|\\|\\s*/);
      let root = document; let found = [];
      for (let index = 0; index < frames.length; index += 1) {
        const shadowParts = frames[index].split(/\\s*>>>\\s*/);
        let scope = root; let matches = [];
        for (let shadowIndex = 0; shadowIndex < shadowParts.length; shadowIndex += 1) {
          if (!scope || !scope.querySelectorAll) return [];
          matches = Array.from(scope.querySelectorAll(shadowParts[shadowIndex]));
          if (shadowIndex < shadowParts.length - 1) scope = matches[0] && matches[0].shadowRoot;
        }
        found = matches;
        if (index < frames.length - 1) root = matches[0] && matches[0].contentDocument;
      }
      return found;
    } catch (_) { return []; }
  }
  function testIdChain(el) { const chain = []; let node = el; while (node && node.nodeType === 1) { const id = node.getAttribute && node.getAttribute('data-testid'); if (id) chain.unshift(id); node = ownerParent(node); } return chain.slice(-LIMITS.testIds); }
  function parseStamp(raw) { const match = /^(.*):(\\d+):(\\d+)$/.exec(String(raw || '')); return match ? { file: match[1], line: Number(match[2]), column: Number(match[3]) } : null; }
  function stampSources(el) {
    const sources = []; let node = el; let first = true;
    while (node && node.nodeType === 1) {
      const raw = node.getAttribute && node.getAttribute('data-insp-path');
      if (raw) { const stamp = parseStamp(raw); if (stamp) sources.push({ file: stamp.file, line: stamp.line, column: stamp.column, role: first ? 'usage' : 'candidate' }); first = false; }
      const owner = node.getAttribute && node.getAttribute('data-insp-owner');
      if (owner) { try { const ownerNode = el.ownerDocument.querySelector(owner); const stamp = ownerNode && parseStamp(ownerNode.getAttribute('data-insp-path')); if (stamp) sources.push({ file: stamp.file, line: stamp.line, column: stamp.column, role: 'definition' }); } catch (_) {} }
      node = ownerParent(node);
    }
    return sources;
  }
  function fiberSources(el) {
    const key = Object.keys(el).find(function (name) { return name.indexOf('__reactFiber$') === 0 || name.indexOf('__reactInternalInstance$') === 0; });
    if (!key) return [];
    const sources = []; let fiber = el[key]; let first = true; let depth = 0;
    while (fiber && depth < 40) {
      const source = fiber._debugSource;
      if (source && source.fileName) {
        const named = fiber.type && typeof fiber.type !== 'string';
        sources.push({ file: String(source.fileName), line: Number(source.lineNumber) || 0, column: Number(source.columnNumber) || 0, role: first ? 'usage' : named ? 'definition' : 'candidate' });
        first = false;
      }
      fiber = fiber.return; depth += 1;
    }
    return sources;
  }
  function sourcesFor(el) {
    const all = stampSources(el).concat(fiberSources(el));
    return all.filter(function (candidate, index) { return all.findIndex(function (other) { return other.file === candidate.file && other.line === candidate.line && other.column === candidate.column; }) === index; }).slice(0, LIMITS.sources);
  }
  function styleFor(el) {
    const computed = el.ownerDocument.defaultView.getComputedStyle(el); const out = {};
    RELEVANT.forEach(function (property) { const value = computed.getPropertyValue(property); if (value && value !== 'none' && value !== 'normal' && value !== 'auto' && value !== 'rgba(0, 0, 0, 0)' && value !== '0px' && value !== 'static') out[property] = value; });
    return out;
  }
  function identityFor(el) {
    const rect = round(globalRect(el));
    const scroll = { x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
    let html = '';
    try { const match = String(el.outerHTML || '').replace(/\\s+/g, ' ').match(/^<[^>]+>/); html = match ? match[0].slice(0, LIMITS.html) : ''; } catch (_) {}
    const name = nameFor(el);
    return { role: roleFor(el), name: name ? name.slice(0, LIMITS.text) : null, text: ownText(el).slice(0, LIMITS.text) || null, testIds: testIdChain(el), selector: domSelectorFor(el), html: html || null, style: styleFor(el), sources: sourcesFor(el), viewportRect: rect, pageRect: { x: rect.x + scroll.x, y: rect.y + scroll.y, width: rect.width, height: rect.height } };
  }
  function deepestAt(x, y) {
    let doc = document; let el = null;
    for (let depth = 0; depth < 8; depth += 1) {
      const hit = doc.elementFromPoint(x, y);
      if (!hit || hit === el) break;
      el = hit;
      if (hit.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (inner && inner !== hit) { el = inner; } }
      if (String(hit.tagName).toLowerCase() === 'iframe') {
        try { const inner = hit.contentDocument; if (!inner) break; const frame = hit.getBoundingClientRect(); x -= frame.x; y -= frame.y; doc = inner; continue; } catch (_) { break; }
      }
      break;
    }
    while (el && (strataOwn(el) || /^(script|style|template|meta|link|title|noscript)$/i.test(el.tagName))) el = ownerParent(el);
    return el && visible(el) ? el : null;
  }
  function overlap(a, b) { const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)); const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)); return x * y; }
  function describe(el, kind, rect) {
    return { kind: kind, label: kind === 'element' ? plainLabel(el) : 'Region', rect: rect, identity: kind === 'element' ? identityFor(el) : null, scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }, viewport: { width: window.innerWidth, height: window.innerHeight } };
  }
`

/** What is at a point or in a box, in viewport CSS pixels; null when nothing visible is there. */
export function describeScript(target: { point: { x: number; y: number } } | { rect: PageRect }): string {
  return `(() => {${HELPERS}
  const target = ${JSON.stringify(target)};
  if (target.point) {
    const el = deepestAt(target.point.x, target.point.y);
    if (!el) return null;
    const tag = String(el.tagName).toLowerCase();
    // The page itself is not a thing to mark; a click on bare background is a small region.
    if (tag === 'html' || tag === 'body') return describe(el, 'region', { x: Math.round(target.point.x - 12), y: Math.round(target.point.y - 12), width: 24, height: 24 });
    return describe(el, 'element', round(globalRect(el)));
  }
  const box = target.rect;
  const boxArea = Math.max(1, box.width * box.height);
  let el = deepestAt(box.x + box.width / 2, box.y + box.height / 2);
  // Walk up until one thing holds most of the box without dwarfing it; otherwise the box stays a region.
  while (el) {
    const tag = String(el.tagName).toLowerCase();
    if (tag === 'html' || tag === 'body') { el = null; break; }
    const rect = globalRect(el);
    const area = Math.max(1, rect.width * rect.height);
    const shared = overlap(rect, box);
    if (shared / boxArea >= 0.6 && shared / area >= 0.35) break;
    if (area > boxArea * 4) { el = null; break; }
    el = ownerParent(el);
  }
  return el ? describe(el, 'element', round(globalRect(el))) : describe(document.body, 'region', round(box));
})()`
}

/** Whether the thing is still found now: exactly one visible match by the selector, else by test id or role and name. */
export function locateScript(identity: Pick<PageIdentity, 'selector' | 'testIds' | 'role' | 'name'>): string {
  return `(() => {${HELPERS}
  const identity = ${JSON.stringify({ selector: identity.selector, testIds: identity.testIds, role: identity.role, name: identity.name })};
  let matches = identity.selector ? resolveSelector(identity.selector).filter(visible) : [];
  if (matches.length !== 1 && identity.testIds && identity.testIds.length) {
    const last = identity.testIds[identity.testIds.length - 1];
    matches = Array.from(document.querySelectorAll('[data-testid="' + last.replace(/"/g, '\\\\"') + '"]')).filter(visible);
  }
  if (matches.length !== 1 && identity.role && identity.name) {
    matches = Array.from(document.querySelectorAll('body *')).filter(function (el) { return !strataOwn(el) && visible(el) && roleFor(el) === identity.role && nameFor(el) === identity.name; });
  }
  if (matches.length === 0) return { matches: 0, rect: null, scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) } };
  return { matches: matches.length, rect: round(globalRect(matches[0])), scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) } };
})()`
}

/** Scroll the page by a delta, or to a position, and report where it landed after two frames. */
export function scrollScript(move: { by: { x: number; y: number } } | { to: { x: number; y: number } }): string {
  const call = 'by' in move ? `window.scrollBy(${Math.round(move.by.x)}, ${Math.round(move.by.y)})` : `window.scrollTo(${Math.round(move.to.x)}, ${Math.round(move.to.y)})`
  return `(async () => {
  ${call};
  await new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); });
  return { x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
})()`
}

/** Bring a found thing into view and outline it for a moment; the outline is Strata's, marked so a capture can clear it first. */
export function outlineScript(identity: Pick<PageIdentity, 'selector' | 'testIds' | 'role' | 'name'>, durationMs: number): string {
  return `(async () => {${HELPERS}
  const identity = ${JSON.stringify({ selector: identity.selector, testIds: identity.testIds, role: identity.role, name: identity.name })};
  let matches = identity.selector ? resolveSelector(identity.selector).filter(visible) : [];
  if (matches.length !== 1 && identity.role && identity.name) matches = Array.from(document.querySelectorAll('body *')).filter(function (el) { return !strataOwn(el) && visible(el) && roleFor(el) === identity.role && nameFor(el) === identity.name; });
  if (matches.length !== 1) return null;
  const el = matches[0];
  el.scrollIntoView({ block: 'center', inline: 'center' });
  await new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); });
  document.querySelectorAll('[data-strata-visual="outline"]').forEach(function (node) { node.remove(); });
  const rect = globalRect(el);
  const outline = document.createElement('div');
  outline.setAttribute('data-strata-visual', 'outline');
  outline.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid rgb(255, 92, 138);border-radius:4px;box-shadow:0 0 0 4px rgba(255, 92, 138, 0.25);left:' + rect.x + 'px;top:' + rect.y + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;';
  document.documentElement.appendChild(outline);
  setTimeout(function () { outline.remove(); }, ${Math.max(0, Math.round(durationMs))});
  return round(rect);
})()`
}

/** Remove anything Strata drew in the page, its outline, so a capture never carries it; overrides are the owner's request and are cleared separately. */
export const CLEAR_STRATA_SCRIPT = `(() => {
  document.querySelectorAll('[data-strata-visual="outline"]').forEach(function (node) { node.remove(); });
  return true;
})()`
