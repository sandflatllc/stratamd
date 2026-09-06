/**
 * Strata's overrides on a page (docs/plans/open/visual-review, phase 4):
 * an adjustment on a marked thing is one stylesheet Strata owns, targeting
 * the thing through an attribute Strata sets. Cleanup removes that
 * stylesheet and those attributes and nothing else, so a live update the
 * page made in the meantime is never overwritten by a snapshot of old styles.
 */
import type { PageIdentity } from './inspect'

export interface OverrideTarget {
  markId: string
  identity: Pick<PageIdentity, 'selector' | 'testIds' | 'role' | 'name'>
  declarations: Record<string, string>
}

const OVERRIDE_ATTRIBUTE = 'data-strata-target'

const LOCATE = `
  function visible(el) { const rect = el.getBoundingClientRect(); if (!rect || rect.width <= 0 || rect.height <= 0) return false; const style = el.ownerDocument.defaultView.getComputedStyle(el); return style.visibility !== 'hidden' && style.display !== 'none'; }
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
  function locate(identity) {
    let matches = identity.selector ? resolveSelector(identity.selector).filter(visible) : [];
    if (matches.length !== 1 && identity.testIds && identity.testIds.length) {
      const last = identity.testIds[identity.testIds.length - 1];
      matches = Array.from(document.querySelectorAll('[data-testid="' + last.replace(/"/g, '\\\\"') + '"]')).filter(visible);
    }
    return matches.length === 1 ? matches[0] : null;
  }
`

/** Apply the whole set of overrides at once: the previous sheet goes, each target gets its rule. Returns the marks that were found. */
export function applyOverridesScript(targets: OverrideTarget[]): string {
  const safe = targets.map((target) => ({ markId: target.markId, identity: { selector: target.identity.selector, testIds: target.identity.testIds, role: target.identity.role, name: target.identity.name }, declarations: target.declarations }))
  return `(() => {${LOCATE}
  const targets = ${JSON.stringify(safe)};
  const ATTRIBUTE = ${JSON.stringify(OVERRIDE_ATTRIBUTE)};
  document.querySelectorAll('[data-strata-visual="override"]').forEach(function (node) { node.remove(); });
  document.querySelectorAll('[' + ATTRIBUTE + ']').forEach(function (node) { node.removeAttribute(ATTRIBUTE); });
  const applied = [];
  const rules = [];
  targets.forEach(function (target) {
    const el = locate(target.identity);
    if (!el) return;
    el.setAttribute(ATTRIBUTE, target.markId);
    const body = Object.keys(target.declarations).map(function (property) {
      // Property names and values are data: only letters, digits, and the characters a CSS value needs pass through.
      const name = String(property).replace(/[^a-z-]/g, '');
      const value = String(target.declarations[property]).replace(/[;{}<>]/g, '');
      return name && value ? name + ': ' + value + ' !important;' : '';
    }).join(' ');
    if (body) rules.push('[' + ATTRIBUTE + '="' + target.markId.replace(/"/g, '') + '"] { ' + body + ' }');
    applied.push(target.markId);
  });
  if (rules.length) {
    const style = document.createElement('style');
    style.setAttribute('data-strata-visual', 'override');
    style.textContent = rules.join('\\n');
    document.documentElement.appendChild(style);
  }
  return applied;
})()`
}

/** Remove only Strata's overrides: its stylesheet and its attributes. The page's own styles, live or not, are left alone. */
export const CLEAR_OVERRIDES_SCRIPT = `(() => {
  document.querySelectorAll('[data-strata-visual="override"]').forEach(function (node) { node.remove(); });
  document.querySelectorAll('[${OVERRIDE_ATTRIBUTE}]').forEach(function (node) { node.removeAttribute('${OVERRIDE_ATTRIBUTE}'); });
  return true;
})()`
