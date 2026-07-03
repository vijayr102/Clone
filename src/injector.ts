/**
 * Browser-side interaction sniffing script.
 *
 * Injected into every page via context.addInitScript().
 * All listeners use the CAPTURE phase (third arg = true) so they fire
 * before bubbling listeners and cannot be silenced by e.stopPropagation()
 * calls made in the page's own scripts.
 *
 * Each captured interaction is routed back to Fastify through the
 * window.onActionRecorded() RPC tunnel exposed by Playwright.
 *
 * Phase 4: DOM context is extracted, depth-pruned, and scrubbed of heavy
 * content (SVG blobs, base64 images, style/script blocks) before sending.
 */
export const recorderScript = /* javascript */ `
(function () {

  // ── DOM Extraction ────────────────────────────────────────────────────────

  /**
   * Walk child-element indices from ancestor down to target.
   * Returns an array of indices, or null if target is not a descendant.
   */
  function getIndexPath(ancestor, target) {
    if (ancestor === target) return [];
    var children = ancestor.children;
    for (var i = 0; i < children.length; i++) {
      var sub = getIndexPath(children[i], target);
      if (sub !== null) return [i].concat(sub);
    }
    return null;
  }

  /**
   * Follow a previously computed index path through a (cloned) tree.
   */
  function followPath(root, path) {
    var node = root;
    for (var i = 0; i < path.length; i++) {
      node = node.children[path[i]];
      if (!node) return null;
    }
    return node;
  }

  /**
   * Recursively remove all child nodes from \`node\` when maxDepth reaches 0.
   * This keeps exactly \`maxDepth\` descendant layers below \`node\`.
   */
  function pruneBelow(node, maxDepth) {
    if (maxDepth <= 0) {
      while (node.firstChild) node.removeChild(node.firstChild);
      return;
    }
    var kids = Array.from(node.children);
    for (var i = 0; i < kids.length; i++) {
      pruneBelow(kids[i], maxDepth - 1);
    }
  }

  // ── Content Scrubber ──────────────────────────────────────────────────────

  function scrub(html) {
    // Remove inline SVG blobs
    html = html.replace(/<svg[\\s\\S]*?<\\/svg>/gi, '');
    // Strip base64 data URIs from src / srcset attributes
    html = html.replace(/\\bsrc="data:[^"]*"/gi, 'src=""');
    html = html.replace(/\\bsrcset="[^"]*data:[^"]*"/gi, 'srcset=""');
    // Strip data URIs embedded inside style attributes
    html = html.replace(/(style="[^"]*?)url\\(data:[^)]*\\)([^"]*")/gi, '$1url()$2');
    // Remove <style> blocks
    html = html.replace(/<style[\\s\\S]*?<\\/style>/gi, '');
    // Remove <script> blocks
    html = html.replace(/<script[\\s\\S]*?<\\/script>/gi, '');
    return html;
  }

  // ── Core extraction entry point ───────────────────────────────────────────

  function extractDomContext(el) {
    try {
      // 1. Climb exactly 2 parent nodes (stop at document boundary)
      var root = el;
      for (var i = 0; i < 2; i++) {
        if (root.parentElement) root = root.parentElement;
        else break;
      }

      // 2. Record the path from root → target so we can locate it in the clone
      var path = getIndexPath(root, el);

      // 3. Deep-clone the root subtree
      var clone = root.cloneNode(true);

      // 4. Locate the cloned counterpart of the target element
      if (path !== null && path.length > 0) {
        var clonedTarget = followPath(clone, path);
        if (clonedTarget) {
          // 5. Prune: keep at most 2 descendant layers below the target
          pruneBelow(clonedTarget, 2);
        }
      } else {
        // target IS the root — prune 2 levels below it directly
        pruneBelow(clone, 2);
      }

      // 6. Serialize and scrub
      return scrub(clone.outerHTML || '');
    } catch (_) {
      return '';
    }
  }

  // ── RPC sender ────────────────────────────────────────────────────────────

  function send(action, value, element) {
    if (typeof window.onActionRecorded !== 'function') return;
    window.onActionRecorded({
      id: crypto.randomUUID(),
      action: action,
      value: String(value ?? ''),
      url: window.location.href,
      domContext: element ? extractDomContext(element) : ''
    });
  }

  // ── Entering text ────────────────────────────────────────────────────────
  // Fire on blur so we capture the committed final value, not every keystroke.
  document.addEventListener('blur', function (e) {
    var el = e.target;
    if (!el || !el.tagName) return;
    var tag  = el.tagName.toLowerCase();
    var type = (el.type || '').toLowerCase();
    var textTypes = ['text','email','password','search','tel','url','number','date','time','month','week','color',''];
    if ((tag === 'input' && textTypes.includes(type)) || tag === 'textarea') {
      var val = el.value;
      if (val && val.trim() !== '') {
        send('entering text', val, el);
      }
    }
  }, true);

  // ── Radio / Checkbox / Select ────────────────────────────────────────────
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || !el.tagName) return;
    var tag  = el.tagName.toLowerCase();
    var type = (el.type || '').toLowerCase();
    if (tag === 'select') {
      var opt = el.options[el.selectedIndex];
      send('select option', opt ? opt.text : el.value, el);
    } else if (type === 'radio') {
      send('click radio', el.value || el.name || '', el);
    } else if (type === 'checkbox') {
      send(el.checked ? 'check checkbox' : 'uncheck checkbox', el.value || el.name || '', el);
    }
  }, true);

  // ── Click link / button ─────────────────────────────────────────────────
  // Use closest() so clicks on child nodes (icons, spans) are attributed
  // to their containing interactive element.
  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.tagName) return;
    // Skip if this is a checkbox/radio — already handled by change
    var type = (el.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return;

    var link = el.closest('a');
    var btn  = el.closest(
      'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]'
    );
    if (link) {
      send('click link', link.innerText ? link.innerText.trim() : link.getAttribute('href') || '', link);
    } else if (btn) {
      send(
        'click button',
        btn.innerText
          ? btn.innerText.trim()
          : (btn.value || btn.getAttribute('aria-label') || ''),
        btn
      );
    }
  }, true);
})();
`;

