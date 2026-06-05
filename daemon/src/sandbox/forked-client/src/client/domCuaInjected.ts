// @ts-nocheck
// WARNING: every export in this file is serialized with String(fn) and
// re-evaluated inside the page (frame.evaluate ships source text over the
// wire). Each export must stay ONE truly self-contained function expression —
// no references to module-level helpers, constants, or imports. A closure
// would bundle and stringify fine but explode as a ReferenceError in-page at
// runtime. Bundler flags that rewrite function bodies (minify, keepNames)
// would also corrupt the serialized source; see
// daemon/scripts/bundle-sandbox-client.ts.

export const domCuaWalker = function (options) {
  const maxElements = options && typeof options.maxElements === "number" ? options.maxElements : 50;

  const INTERACTIVE_TAGS = {
    a: 1,
    button: 1,
    details: 1,
    input: 1,
    option: 1,
    select: 1,
    summary: 1,
    textarea: 1,
  };
  const INTERACTIVE_ROLES = {
    button: 1,
    checkbox: 1,
    combobox: 1,
    link: 1,
    menuitem: 1,
    option: 1,
    radio: 1,
    slider: 1,
    spinbutton: 1,
    switch: 1,
    tab: 1,
    textbox: 1,
  };
  const SKIPPED_TAGS = { script: 1, style: 1, template: 1, noscript: 1 };
  const TEXT_ATTRIBUTES = [
    "aria-disabled",
    "aria-label",
    "contenteditable",
    "href",
    "name",
    "placeholder",
    "role",
    "title",
    "type",
    "value",
  ];
  const BOOLEAN_ATTRIBUTES = [
    ["checked", "checked"],
    ["disabled", "disabled"],
    ["multiple", "multiple"],
    ["readonly", "readOnly"],
    ["required", "required"],
    ["selected", "selected"],
  ];

  let state = globalThis.__devBrowserDomCua;
  if (!state || typeof state !== "object") {
    state = {};
    globalThis.__devBrowserDomCua = state;
    if (globalThis.__devBrowserDomCua !== state)
      return { blocked: true, entries: [], truncated: false };
  }
  if (!(state.elementToRef instanceof WeakMap)) state.elementToRef = new WeakMap();
  if (typeof state.nextRef !== "number") state.nextRef = 1;
  if (typeof state.docToken !== "string") state.docToken = Date.now() + "-" + Math.random();
  const refToElement = new Map();
  state.refToElement = refToElement;
  if (state.refToElement !== refToElement || !(state.elementToRef instanceof WeakMap))
    return { blocked: true, entries: [], truncated: false };

  const viewport =
    typeof visualViewport !== "undefined" && visualViewport
      ? {
          left: visualViewport.offsetLeft,
          top: visualViewport.offsetTop,
          width: visualViewport.width,
          height: visualViewport.height,
        }
      : { left: 0, top: 0, width: innerWidth, height: innerHeight };

  function collapseWhitespace(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isStyleVisible(element) {
    const style = getComputedStyle(element);
    return (
      style.visibility === "visible" &&
      style.display !== "none" &&
      style.pointerEvents !== "none" &&
      parseFloat(style.opacity) > 0.01
    );
  }

  function isTextVisible(element) {
    const style = getComputedStyle(element);
    return (
      style.visibility === "visible" && style.display !== "none" && parseFloat(style.opacity) > 0.01
    );
  }

  function intersectsViewport(element) {
    const rects = element.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > viewport.left &&
        rect.left < viewport.left + viewport.width &&
        rect.bottom > viewport.top &&
        rect.top < viewport.top + viewport.height
      )
        return true;
    }
    return false;
  }

  function visibleText(root) {
    let out = "";
    const nodes = root.childNodes || [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeType === 3) {
        out += node.nodeValue || "";
        continue;
      }
      if (node.nodeType !== 1) continue;
      if (SKIPPED_TAGS[node.tagName.toLowerCase()] === 1) continue;
      if (node.getAttribute("aria-hidden") === "true" || node.hasAttribute("hidden")) continue;
      if (!isTextVisible(node)) continue;
      if (node.shadowRoot) out += visibleText(node.shadowRoot) + " ";
      out += visibleText(node);
    }
    return out;
  }

  function isInteractive(element) {
    const tag = element.tagName.toLowerCase();
    if (INTERACTIVE_TAGS[tag] === 1) return true;
    if (
      element.hasAttribute("contenteditable") &&
      element.getAttribute("contenteditable") !== "false"
    )
      return true;
    if (element.hasAttribute("href")) return true;
    if (element.hasAttribute("onclick")) return true;
    const role = element.getAttribute("role");
    if (role && INTERACTIVE_ROLES[role.toLowerCase()] === 1) return true;
    const tabIndex = element.getAttribute("tabindex");
    if (tabIndex !== null && parseInt(tabIndex, 10) >= 0) return true;
    return false;
  }

  function renderLine(element, ref) {
    const tag = element.tagName.toLowerCase();
    const parts = ["<" + tag + " node_id=" + ref];
    for (let i = 0; i < TEXT_ATTRIBUTES.length; i++) {
      const name = TEXT_ATTRIBUTES[i];
      const value =
        name === "value" && typeof element.value === "string"
          ? element.value
          : element.getAttribute(name);
      if (value === null || value === undefined || value === "") continue;
      parts.push(name + '="' + escapeHtml(collapseWhitespace(String(value))) + '"');
    }
    for (let j = 0; j < BOOLEAN_ATTRIBUTES.length; j++) {
      const attrName = BOOLEAN_ATTRIBUTES[j][0];
      const propName = BOOLEAN_ATTRIBUTES[j][1];
      const enabled =
        propName in element ? element[propName] === true : element.hasAttribute(attrName);
      if (enabled) parts.push(attrName + '="true"');
    }
    let text = visibleText(element);
    if (element.shadowRoot) text = visibleText(element.shadowRoot) + " " + text;
    text = collapseWhitespace(text);
    if (text.length > 160) text = text.slice(0, 160);
    const opener = parts.join(" ");
    if (!text) return opener + " />";
    return opener + ">" + escapeHtml(text) + "</" + tag + ">";
  }

  const entries = [];
  let truncated = false;

  function visit(node) {
    if (truncated) return;
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (SKIPPED_TAGS[tag] === 1) return;
    if (node.getAttribute("aria-hidden") === "true" || node.hasAttribute("hidden")) return;
    const hiddenInput =
      tag === "input" && (node.getAttribute("type") || "").toLowerCase() === "hidden";
    if (!hiddenInput && isInteractive(node) && isStyleVisible(node) && intersectsViewport(node)) {
      if (entries.length >= maxElements) {
        truncated = true;
        return;
      }
      let ref = state.elementToRef.get(node);
      if (ref === undefined) {
        ref = state.nextRef++;
        state.elementToRef.set(node, ref);
      }
      refToElement.set(ref, node);
      entries.push({ ref, line: renderLine(node, ref) });
    }
    if (node.shadowRoot) {
      const shadowChildren = node.shadowRoot.children;
      for (let i = 0; i < shadowChildren.length; i++) {
        visit(shadowChildren[i]);
        if (truncated) return;
      }
    }
    const children = node.children;
    for (let j = 0; j < children.length; j++) {
      visit(children[j]);
      if (truncated) return;
    }
  }

  const root = document.body || document.documentElement;
  if (root) visit(root);
  return { blocked: false, entries, truncated, docToken: state.docToken };
};

export const domCuaRegister = function (data) {
  const STORAGE_KEY = "__devBrowserDomCuaNextPublicId";

  let state = globalThis.__devBrowserDomCua;
  if (!state || typeof state !== "object") {
    state = {};
    globalThis.__devBrowserDomCua = state;
    if (globalThis.__devBrowserDomCua !== state) return { blocked: true, ids: [] };
  }

  let next = state.nextPublicId;
  if (typeof next !== "number" || !isFinite(next)) {
    let stored = null;
    try {
      stored = sessionStorage.getItem(STORAGE_KEY);
    } catch (error) {
      stored = null;
    }
    const parsed = stored === null ? NaN : parseInt(stored, 10);
    next = parsed >= 1 ? parsed : 1_000_000 + Math.floor(Math.random() * 2_000_000_000);
  }

  if (!(state.publicIdByFrameKey instanceof Map)) state.publicIdByFrameKey = new Map();
  const sticky = state.publicIdByFrameKey;
  let total = 0;
  sticky.forEach((frameMap) => {
    total += frameMap.size;
  });
  if (total > 5000) {
    sticky.clear();
    next += 1_000_000;
  }

  const actionable = new Map();
  const ids = [];
  for (let i = 0; i < data.frames.length; i++) {
    const frame = data.frames[i];
    const stickyKey = frame.key + "::" + frame.docToken;
    let frameMap = sticky.get(stickyKey);
    if (!frameMap) {
      frameMap = new Map();
      sticky.set(stickyKey, frameMap);
    }
    const frameIds = [];
    for (let j = 0; j < frame.refs.length; j++) {
      const ref = frame.refs[j];
      let id = frameMap.get(ref);
      if (id === undefined) {
        id = next++;
        frameMap.set(ref, id);
      }
      actionable.set(id, { frameKey: frame.key, ref });
      frameIds.push(id);
    }
    ids.push(frameIds);
  }
  state.actionableByPublicId = actionable;
  state.nextPublicId = next;
  try {
    sessionStorage.setItem(STORAGE_KEY, String(next));
  } catch (error) {
    // sessionStorage may be blocked; the random high base covers the next document
  }
  if (
    globalThis.__devBrowserDomCua !== state ||
    state.actionableByPublicId !== actionable ||
    state.publicIdByFrameKey !== sticky
  )
    return { blocked: true, ids: [] };
  return { blocked: false, ids };
};
