/**
 * In-page snapshot script. Evaluated as a string in Puppeteer's ISOLATED realm of a frame.
 * Installs window.__doobie (idempotent). See ./index.ts for the contract.
 *
 * Port of do-browser's ariaSnapshot.ts (itself a port of Playwright's injected
 * ariaSnapshot) plus: stable refs, interactive mode, scope, depth, boxes,
 * iframe detection, frame-prefixed refs.
 *
 * window.__doobie = {
 *   version,
 *   snapshot(opts) -> { yaml, refs, truncated, droppedLines, iframes: [{ ref, line, origin: [x, y] }] }
 *     opts: { scope, interactive, depth, boxes, urls, maxChars, refPrefix, boxOffset: [x, y] }
 *     boxOffset is added to every [box=...] (the iframe's content origin in main-viewport px,
 *     passed by the host for nested frames) so boxes are always main-viewport coordinates.
 *   ref(id)        -> Element | null   (accepts "e5" or "f1e5")
 *   box(id)        -> [x, y, w, h] | null   (frame-local viewport px)
 * }
 *
 * NOTE: written with String.raw so regexes read like normal JS. Do not use
 * backticks or "${" inside the script body.
 */

export const INPAGE_VERSION = 3;

export const INPAGE_SCRIPT: string = String.raw`(() => {
  if (window.__doobie && window.__doobie.version === ${INPAGE_VERSION}) return;

  // === domUtils ===
  let cacheStyle;
  let cachesCounter = 0;

  function beginDOMCaches() {
    ++cachesCounter;
    cacheStyle = cacheStyle || new Map();
  }
  function endDOMCaches() {
    if (!--cachesCounter) cacheStyle = undefined;
  }
  function getElementComputedStyle(element, pseudo) {
    const cache = cacheStyle;
    const cacheKey = pseudo ? undefined : element;
    if (cache && cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);
    const style = element.ownerDocument && element.ownerDocument.defaultView
      ? element.ownerDocument.defaultView.getComputedStyle(element, pseudo)
      : undefined;
    if (cache && cacheKey) cache.set(cacheKey, style);
    return style;
  }
  function parentElementOrShadowHost(element) {
    if (element.parentElement) return element.parentElement;
    if (!element.parentNode) return;
    if (element.parentNode.nodeType === 11 && element.parentNode.host) return element.parentNode.host;
  }
  function enclosingShadowRootOrDocument(element) {
    let node = element;
    while (node.parentNode) node = node.parentNode;
    if (node.nodeType === 11 || node.nodeType === 9) return node;
  }
  function closestCrossShadow(element, css, scope) {
    while (element) {
      const closest = element.closest(css);
      if (scope && closest !== scope && closest && closest.contains(scope)) return;
      if (closest) return closest;
      element = enclosingShadowHost(element);
    }
  }
  function enclosingShadowHost(element) {
    while (element.parentElement) element = element.parentElement;
    return parentElementOrShadowHost(element);
  }
  function isElementStyleVisibilityVisible(element, style) {
    style = style || getElementComputedStyle(element);
    if (!style) return true;
    if (style.visibility !== "visible") return false;
    const detailsOrSummary = element.closest("details,summary");
    if (detailsOrSummary !== element && detailsOrSummary && detailsOrSummary.nodeName === "DETAILS" && !detailsOrSummary.open) return false;
    return true;
  }
  function computeBox(element) {
    const style = getElementComputedStyle(element);
    if (!style) return { visible: true, inline: false };
    const cursor = style.cursor;
    if (style.display === "contents") {
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && isElementVisible(child)) return { visible: true, inline: false, cursor };
        if (child.nodeType === 3 && isVisibleTextNode(child)) return { visible: true, inline: true, cursor };
      }
      return { visible: false, inline: false, cursor };
    }
    if (!isElementStyleVisibilityVisible(element, style)) return { cursor, visible: false, inline: false };
    const rect = element.getBoundingClientRect();
    return { rect, cursor, visible: rect.width > 0 && rect.height > 0, inline: style.display === "inline" };
  }
  function isElementVisible(element) {
    return computeBox(element).visible;
  }
  function isVisibleTextNode(node) {
    const range = node.ownerDocument.createRange();
    range.selectNode(node);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function elementSafeTagName(element) {
    const tagName = element.tagName;
    if (typeof tagName === "string") return tagName.toUpperCase();
    if (element instanceof HTMLFormElement) return "FORM";
    return String(element.tagName).toUpperCase();
  }
  function normalizeWhiteSpace(text) {
    return text.split("\u00A0").map(chunk =>
      chunk.replace(/\r\n/g, "\n").replace(/[\u200b\u00ad]/g, "").replace(/\s\s*/g, " ")
    ).join("\u00A0").trim();
  }

  // === yaml ===
  function yamlEscapeKeyIfNeeded(str) {
    if (!yamlStringNeedsQuotes(str)) return str;
    return "'" + str.replace(/'/g, "''") + "'";
  }
  function yamlEscapeValueIfNeeded(str) {
    if (!yamlStringNeedsQuotes(str)) return str;
    return '"' + str.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, c => {
      switch (c) {
        case "\\": return "\\\\";
        case '"': return '\\"';
        case "\b": return "\\b";
        case "\f": return "\\f";
        case "\n": return "\\n";
        case "\r": return "\\r";
        case "\t": return "\\t";
        default: return "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0");
      }
    }) + '"';
  }
  function yamlStringNeedsQuotes(str) {
    if (str.length === 0) return true;
    if (/^\s|\s$/.test(str)) return true;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(str)) return true;
    if (/^-/.test(str)) return true;
    if (/[\n:](\s|$)/.test(str)) return true;
    if (/\s#/.test(str)) return true;
    if (/[\n\r]/.test(str)) return true;
    if (/^[&*\],?!>|@"'#%]/.test(str)) return true;
    if (/[{}]/.test(str)) return true;
    if (/^\[/.test(str)) return true;
    if (!isNaN(Number(str)) || ["y","n","yes","no","true","false","on","off","null"].includes(str.toLowerCase())) return true;
    return false;
  }

  // === roleUtils ===
  const validRoles = new Set(["alert","alertdialog","application","article","banner","blockquote","button","caption","cell","checkbox","code","columnheader","combobox","complementary","contentinfo","definition","deletion","dialog","directory","document","emphasis","feed","figure","form","generic","grid","gridcell","group","heading","img","insertion","link","list","listbox","listitem","log","main","mark","marquee","math","meter","menu","menubar","menuitem","menuitemcheckbox","menuitemradio","navigation","none","note","option","paragraph","presentation","progressbar","radio","radiogroup","region","row","rowgroup","rowheader","scrollbar","search","searchbox","separator","slider","spinbutton","status","strong","subscript","superscript","switch","tab","table","tablist","tabpanel","term","textbox","time","timer","toolbar","tooltip","tree","treegrid","treeitem"]);

  let cacheAccessibleName;
  let cacheIsHidden;
  let cachePointerEvents;
  let cacheRole;
  let ariaCachesCounter = 0;

  function beginAriaCaches() {
    beginDOMCaches();
    ++ariaCachesCounter;
    cacheAccessibleName = cacheAccessibleName || new Map();
    cacheIsHidden = cacheIsHidden || new Map();
    cachePointerEvents = cachePointerEvents || new Map();
    cacheRole = cacheRole || new Map();
  }
  function endAriaCaches() {
    if (!--ariaCachesCounter) {
      cacheAccessibleName = undefined;
      cacheIsHidden = undefined;
      cachePointerEvents = undefined;
      cacheRole = undefined;
    }
    endDOMCaches();
  }

  function hasExplicitAccessibleName(e) {
    return e.hasAttribute("aria-label") || e.hasAttribute("aria-labelledby");
  }
  const kAncestorPreventingLandmark = "article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), section:not([role]), [role=article], [role=complementary], [role=main], [role=navigation], [role=region]";
  const kNamingProhibited = ["caption","code","deletion","emphasis","generic","insertion","paragraph","presentation","strong","subscript","superscript"];
  const kGlobalAriaAttributes = [
    ["aria-atomic", undefined],["aria-busy", undefined],["aria-controls", undefined],["aria-current", undefined],
    ["aria-describedby", undefined],["aria-details", undefined],["aria-dropeffect", undefined],["aria-flowto", undefined],
    ["aria-grabbed", undefined],["aria-hidden", undefined],["aria-keyshortcuts", undefined],
    ["aria-label", kNamingProhibited],["aria-labelledby", kNamingProhibited],
    ["aria-live", undefined],["aria-owns", undefined],["aria-relevant", undefined],["aria-roledescription", ["generic"]]
  ];
  function hasGlobalAriaAttribute(element, forRole) {
    return kGlobalAriaAttributes.some(([attr, prohibited]) => !(prohibited && prohibited.includes(forRole || "")) && element.hasAttribute(attr));
  }
  function hasTabIndex(element) {
    return !Number.isNaN(Number(String(element.getAttribute("tabindex"))));
  }
  function isFocusable(element) {
    return !isNativelyDisabled(element) && (isNativelyFocusable(element) || hasTabIndex(element));
  }
  function isNativelyFocusable(element) {
    const tagName = elementSafeTagName(element);
    if (["BUTTON","DETAILS","SELECT","TEXTAREA"].includes(tagName)) return true;
    if (tagName === "A" || tagName === "AREA") return element.hasAttribute("href");
    if (tagName === "INPUT") return !element.hidden;
    return false;
  }
  function isNativelyDisabled(element) {
    const isNativeFormControl = ["BUTTON","INPUT","SELECT","TEXTAREA","OPTION","OPTGROUP"].includes(elementSafeTagName(element));
    return isNativeFormControl && (element.hasAttribute("disabled") || belongsToDisabledFieldSet(element));
  }
  function belongsToDisabledFieldSet(element) {
    const fieldSetElement = element && element.closest("FIELDSET[DISABLED]");
    if (!fieldSetElement) return false;
    const legendElement = fieldSetElement.querySelector(":scope > LEGEND");
    return !legendElement || !legendElement.contains(element);
  }
  const inputTypeToRole = {button:"button",checkbox:"checkbox",image:"button",number:"spinbutton",radio:"radio",range:"slider",reset:"button",submit:"button"};
  function getIdRefs(element, ref) {
    if (!ref) return [];
    const root = enclosingShadowRootOrDocument(element);
    if (!root) return [];
    try {
      const ids = ref.split(" ").filter(id => !!id);
      const result = [];
      for (const id of ids) {
        const firstElement = root.querySelector("#" + CSS.escape(id));
        if (firstElement && !result.includes(firstElement)) result.push(firstElement);
      }
      return result;
    } catch (e) { return []; }
  }
  const kImplicitRoleByTagName = {
    A: e => e.hasAttribute("href") ? "link" : null,
    AREA: e => e.hasAttribute("href") ? "link" : null,
    ARTICLE: () => "article", ASIDE: () => "complementary", BLOCKQUOTE: () => "blockquote", BUTTON: () => "button",
    CAPTION: () => "caption", CODE: () => "code", DATALIST: () => "listbox", DD: () => "definition",
    DEL: () => "deletion", DETAILS: () => "group", DFN: () => "term", DIALOG: () => "dialog", DT: () => "term",
    EM: () => "emphasis", FIELDSET: () => "group", FIGURE: () => "figure",
    FOOTER: e => closestCrossShadow(e, kAncestorPreventingLandmark) ? null : "contentinfo",
    FORM: e => hasExplicitAccessibleName(e) ? "form" : null,
    H1: () => "heading", H2: () => "heading", H3: () => "heading", H4: () => "heading", H5: () => "heading", H6: () => "heading",
    HEADER: e => closestCrossShadow(e, kAncestorPreventingLandmark) ? null : "banner",
    HR: () => "separator", HTML: () => "document",
    IMG: e => e.getAttribute("alt") === "" && !e.getAttribute("title") && !hasGlobalAriaAttribute(e) && !hasTabIndex(e) ? "presentation" : "img",
    INPUT: e => {
      const type = String(e.type).toLowerCase();
      if (type === "search") return e.hasAttribute("list") ? "combobox" : "searchbox";
      if (["email","tel","text","url",""].includes(type)) {
        const list = getIdRefs(e, e.getAttribute("list"))[0];
        return list && elementSafeTagName(list) === "DATALIST" ? "combobox" : "textbox";
      }
      if (type === "hidden") return null;
      if (type === "file") return "button";
      return inputTypeToRole[type] || "textbox";
    },
    INS: () => "insertion", LI: () => "listitem", MAIN: () => "main", MARK: () => "mark", MATH: () => "math",
    MENU: () => "list", METER: () => "meter", NAV: () => "navigation", OL: () => "list", OPTGROUP: () => "group",
    OPTION: () => "option", OUTPUT: () => "status", P: () => "paragraph", PROGRESS: () => "progressbar",
    SEARCH: () => "search", SECTION: e => hasExplicitAccessibleName(e) ? "region" : null,
    SELECT: e => e.hasAttribute("multiple") || e.size > 1 ? "listbox" : "combobox",
    STRONG: () => "strong", SUB: () => "subscript", SUP: () => "superscript", SVG: () => "img",
    TABLE: () => "table", TBODY: () => "rowgroup",
    TD: e => { const table = closestCrossShadow(e, "table"); const role = table ? getExplicitAriaRole(table) : ""; return role === "grid" || role === "treegrid" ? "gridcell" : "cell"; },
    TEXTAREA: () => "textbox", TFOOT: () => "rowgroup",
    TH: e => { const scope = e.getAttribute("scope"); if (scope === "col" || scope === "colgroup") return "columnheader"; if (scope === "row" || scope === "rowgroup") return "rowheader"; return "columnheader"; },
    THEAD: () => "rowgroup", TIME: () => "time", TR: () => "row", UL: () => "list"
  };
  function getExplicitAriaRole(element) {
    const roles = (element.getAttribute("role") || "").split(" ").map(role => role.trim());
    return roles.find(role => validRoles.has(role)) || null;
  }
  function getImplicitAriaRole(element) {
    const fn = kImplicitRoleByTagName[elementSafeTagName(element)];
    return fn ? fn(element) : null;
  }
  function hasPresentationConflictResolution(element, role) {
    return hasGlobalAriaAttribute(element, role) || isFocusable(element);
  }
  function getAriaRole(element) {
    const cache = cacheRole;
    if (cache && cache.has(element)) return cache.get(element);
    let result;
    const explicitRole = getExplicitAriaRole(element);
    if (!explicitRole) result = getImplicitAriaRole(element);
    else if (explicitRole === "none" || explicitRole === "presentation") {
      const implicitRole = getImplicitAriaRole(element);
      result = hasPresentationConflictResolution(element, implicitRole) ? implicitRole : explicitRole;
    } else result = explicitRole;
    if (cache) cache.set(element, result);
    return result;
  }
  function getAriaBoolean(attr) {
    return attr === null ? undefined : attr.toLowerCase() === "true";
  }
  function isElementIgnoredForAria(element) {
    return ["STYLE","SCRIPT","NOSCRIPT","TEMPLATE"].includes(elementSafeTagName(element));
  }
  function isElementHiddenForAria(element) {
    if (isElementIgnoredForAria(element)) return true;
    const style = getElementComputedStyle(element);
    const isSlot = element.nodeName === "SLOT";
    if (style && style.display === "contents" && !isSlot) {
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && !isElementHiddenForAria(child)) return false;
        if (child.nodeType === 3 && isVisibleTextNode(child)) return false;
      }
      return true;
    }
    const isOptionInsideSelect = element.nodeName === "OPTION" && !!element.closest("select");
    if (!isOptionInsideSelect && !isSlot && !isElementStyleVisibilityVisible(element, style)) return true;
    return belongsToDisplayNoneOrAriaHiddenOrNonSlotted(element);
  }
  function belongsToDisplayNoneOrAriaHiddenOrNonSlotted(element) {
    let hidden = cacheIsHidden ? cacheIsHidden.get(element) : undefined;
    if (hidden === undefined) {
      hidden = false;
      if (element.parentElement && element.parentElement.shadowRoot && !element.assignedSlot) hidden = true;
      if (!hidden) {
        const style = getElementComputedStyle(element);
        hidden = !style || style.display === "none" || getAriaBoolean(element.getAttribute("aria-hidden")) === true;
      }
      if (!hidden) {
        const parent = parentElementOrShadowHost(element);
        if (parent) hidden = belongsToDisplayNoneOrAriaHiddenOrNonSlotted(parent);
      }
      if (cacheIsHidden) cacheIsHidden.set(element, hidden);
    }
    return hidden;
  }
  function getAriaLabelledByElements(element) {
    const ref = element.getAttribute("aria-labelledby");
    if (ref === null) return null;
    const refs = getIdRefs(element, ref);
    return refs.length ? refs : null;
  }
  const kNamingProhibitedRoles = ["caption","code","definition","deletion","emphasis","generic","insertion","mark","paragraph","presentation","strong","subscript","suggestion","superscript","term","time"];
  function getElementAccessibleName(element, includeHidden) {
    let accessibleName = cacheAccessibleName ? cacheAccessibleName.get(element) : undefined;
    if (accessibleName === undefined) {
      accessibleName = "";
      const elementProhibitsNaming = kNamingProhibitedRoles.includes(getAriaRole(element) || "");
      if (!elementProhibitsNaming) {
        accessibleName = normalizeWhiteSpace(getTextAlternativeInternal(element, { includeHidden, visitedElements: new Set(), embeddedInTargetElement: "self" }));
      }
      if (cacheAccessibleName) cacheAccessibleName.set(element, accessibleName);
    }
    return accessibleName;
  }
  const kDescendantNameFromContentRoles = ["","caption","code","contentinfo","definition","deletion","emphasis","insertion","list","listitem","mark","none","paragraph","presentation","region","row","rowgroup","section","strong","subscript","superscript","table","term","time","generic"];
  // "row" is deliberately omitted: its content name repeats every cell/link of the row (very costly on tables).
  const kNameFromContentRoles = ["button","cell","checkbox","columnheader","gridcell","heading","link","menuitem","menuitemcheckbox","menuitemradio","option","radio","rowheader","switch","tab","tooltip","treeitem"];
  function getTextAlternativeInternal(element, options) {
    if (options.visitedElements.has(element)) return "";
    const childOptions = Object.assign({}, options, { embeddedInTargetElement: options.embeddedInTargetElement === "self" ? "descendant" : options.embeddedInTargetElement });
    if (!options.includeHidden) {
      const isEmbeddedInHiddenReferenceTraversal = !!(options.embeddedInLabelledBy && options.embeddedInLabelledBy.hidden) || !!(options.embeddedInLabel && options.embeddedInLabel.hidden);
      if (isElementIgnoredForAria(element) || (!isEmbeddedInHiddenReferenceTraversal && isElementHiddenForAria(element))) {
        options.visitedElements.add(element);
        return "";
      }
    }
    const labelledBy = getAriaLabelledByElements(element);
    if (!options.embeddedInLabelledBy) {
      const accessibleName = (labelledBy || []).map(ref => getTextAlternativeInternal(ref, Object.assign({}, options, { embeddedInLabelledBy: { element: ref, hidden: isElementHiddenForAria(ref) }, embeddedInTargetElement: undefined, embeddedInLabel: undefined }))).join(" ");
      if (accessibleName) return accessibleName;
    }
    const role = getAriaRole(element) || "";
    const tagName = elementSafeTagName(element);
    const ariaLabel = element.getAttribute("aria-label") || "";
    if (ariaLabel.trim()) { options.visitedElements.add(element); return ariaLabel; }
    if (!["presentation","none"].includes(role)) {
      if (tagName === "INPUT" && ["button","submit","reset"].includes(element.type)) {
        options.visitedElements.add(element);
        const value = element.value || "";
        if (value.trim()) return value;
        if (element.type === "submit") return "Submit";
        if (element.type === "reset") return "Reset";
        return element.getAttribute("title") || "";
      }
      if (tagName === "INPUT" && element.type === "image") {
        options.visitedElements.add(element);
        const alt = element.getAttribute("alt") || "";
        if (alt.trim()) return alt;
        const title = element.getAttribute("title") || "";
        if (title.trim()) return title;
        return "Submit";
      }
      if (tagName === "IMG") {
        options.visitedElements.add(element);
        const alt = element.getAttribute("alt") || "";
        if (alt.trim()) return alt;
        return element.getAttribute("title") || "";
      }
      if (!labelledBy && ["BUTTON","INPUT","TEXTAREA","SELECT"].includes(tagName)) {
        const labels = element.labels;
        if (labels && labels.length) {
          options.visitedElements.add(element);
          return [...labels].map(label => getTextAlternativeInternal(label, Object.assign({}, options, { embeddedInLabel: { element: label, hidden: isElementHiddenForAria(label) }, embeddedInLabelledBy: undefined, embeddedInTargetElement: undefined }))).filter(name => !!name).join(" ");
        }
      }
    }
    // 2e: embedded control inside a label / labelledby target contributes its value.
    if (!!options.embeddedInLabel || !!options.embeddedInLabelledBy) {
      const isOwnLabel = [...(element.labels || [])].includes(options.embeddedInLabel && options.embeddedInLabel.element);
      const isOwnLabelledBy = (getAriaLabelledByElements(element) || []).includes(options.embeddedInLabelledBy && options.embeddedInLabelledBy.element);
      if (!isOwnLabel && !isOwnLabelledBy) {
        if (role === "textbox") {
          options.visitedElements.add(element);
          if (tagName === "INPUT" || tagName === "TEXTAREA") return element.value;
          return element.textContent || "";
        }
        if (["combobox","listbox"].includes(role)) {
          options.visitedElements.add(element);
          let selectedOptions;
          if (tagName === "SELECT") {
            selectedOptions = [...element.selectedOptions];
            if (!selectedOptions.length && element.options.length) selectedOptions.push(element.options[0]);
          } else {
            const listbox = role === "combobox" ? [...element.querySelectorAll("*")].find(e => getAriaRole(e) === "listbox") : element;
            selectedOptions = listbox ? [...listbox.querySelectorAll('[aria-selected="true"]')].filter(e => getAriaRole(e) === "option") : [];
          }
          if (!selectedOptions.length && tagName === "INPUT") return element.value;
          return selectedOptions.map(option => getTextAlternativeInternal(option, childOptions)).join(" ");
        }
        if (["progressbar","scrollbar","slider","spinbutton","meter"].includes(role)) {
          options.visitedElements.add(element);
          const valueText = element.getAttribute("aria-valuetext");
          if (valueText) return valueText;
          const valueNow = element.getAttribute("aria-valuenow");
          if (valueNow) return valueNow;
          if (tagName === "INPUT") return element.value;
          return "";
        }
        if (role === "menu") { options.visitedElements.add(element); return ""; }
      }
    }
    // 2f: name from content. Playwright's allowsNameFromContent(role, targetDescendant): a descendant of a
    // naming element contributes its text even when its own role (span/div/p/strong/li/...) would not.
    const allowsNameFromContent = kNameFromContentRoles.includes(role) || (options.embeddedInTargetElement === "descendant" && kDescendantNameFromContentRoles.includes(role));
    if (allowsNameFromContent || !!options.embeddedInLabelledBy || !!options.embeddedInLabel) {
      options.visitedElements.add(element);
      const accessibleName = innerAccumulatedElementText(element, childOptions);
      const maybeTrimmedAccessibleName = options.embeddedInTargetElement === "self" ? accessibleName.trim() : accessibleName;
      if (maybeTrimmedAccessibleName) return accessibleName;
    }
    if (!["presentation","none"].includes(role) || tagName === "IFRAME") {
      options.visitedElements.add(element);
      const title = element.getAttribute("title") || "";
      if (title.trim()) return title;
    }
    options.visitedElements.add(element);
    return "";
  }
  function innerAccumulatedElementText(element, options) {
    const tokens = [];
    const visit = (node, skipSlotted) => {
      if (skipSlotted && node.assignedSlot) return;
      if (node.nodeType === 1) {
        const style = getElementComputedStyle(node);
        const display = (style && style.display) || "inline";
        let token = getTextAlternativeInternal(node, options);
        if (display !== "inline" || node.nodeName === "BR") token = " " + token + " ";
        tokens.push(token);
      } else if (node.nodeType === 3) {
        tokens.push(node.textContent || "");
      }
    };
    const assignedNodes = element.nodeName === "SLOT" ? element.assignedNodes() : [];
    if (assignedNodes.length) {
      for (const child of assignedNodes) visit(child, false);
    } else {
      for (let child = element.firstChild; child; child = child.nextSibling) visit(child, true);
      if (element.shadowRoot) {
        for (let child = element.shadowRoot.firstChild; child; child = child.nextSibling) visit(child, true);
      }
    }
    return tokens.join("");
  }

  const kAriaCheckedRoles = ["checkbox","menuitemcheckbox","option","radio","switch","menuitemradio","treeitem"];
  function getAriaChecked(element) {
    const tagName = elementSafeTagName(element);
    if (tagName === "INPUT" && element.indeterminate) return "mixed";
    if (tagName === "INPUT" && ["checkbox","radio"].includes(element.type)) return element.checked;
    if (kAriaCheckedRoles.includes(getAriaRole(element) || "")) {
      const checked = element.getAttribute("aria-checked");
      if (checked === "true") return true;
      if (checked === "mixed") return "mixed";
      return false;
    }
    return false;
  }
  const kAriaDisabledRoles = ["application","button","composite","gridcell","group","input","link","menuitem","scrollbar","separator","tab","checkbox","columnheader","combobox","grid","listbox","menu","menubar","menuitemcheckbox","menuitemradio","option","radio","radiogroup","row","rowheader","searchbox","select","slider","spinbutton","switch","tablist","textbox","toolbar","tree","treegrid","treeitem"];
  function getAriaDisabled(element) {
    return isNativelyDisabled(element) || hasExplicitAriaDisabled(element);
  }
  function hasExplicitAriaDisabled(element, isAncestor) {
    if (!element) return false;
    if (isAncestor || kAriaDisabledRoles.includes(getAriaRole(element) || "")) {
      const attribute = (element.getAttribute("aria-disabled") || "").toLowerCase();
      if (attribute === "true") return true;
      if (attribute === "false") return false;
      return hasExplicitAriaDisabled(parentElementOrShadowHost(element), true);
    }
    return false;
  }
  const kAriaExpandedRoles = ["application","button","checkbox","combobox","gridcell","link","listbox","menuitem","row","rowheader","tab","treeitem","columnheader","menuitemcheckbox","menuitemradio","switch"];
  function getAriaExpanded(element) {
    if (elementSafeTagName(element) === "DETAILS") return element.open;
    if (kAriaExpandedRoles.includes(getAriaRole(element) || "")) {
      const expanded = element.getAttribute("aria-expanded");
      if (expanded === null) return undefined;
      return expanded === "true";
    }
    return undefined;
  }
  const kAriaLevelRoles = ["heading","listitem","row","treeitem"];
  function getAriaLevel(element) {
    const native = {H1:1,H2:2,H3:3,H4:4,H5:5,H6:6}[elementSafeTagName(element)];
    if (native) return native;
    if (kAriaLevelRoles.includes(getAriaRole(element) || "")) {
      const attr = element.getAttribute("aria-level");
      const value = attr === null ? Number.NaN : Number(attr);
      if (Number.isInteger(value) && value >= 1) return value;
    }
    return 0;
  }
  const kAriaPressedRoles = ["button"];
  function getAriaPressed(element) {
    if (kAriaPressedRoles.includes(getAriaRole(element) || "")) {
      const pressed = element.getAttribute("aria-pressed");
      if (pressed === "true") return true;
      if (pressed === "mixed") return "mixed";
    }
    return false;
  }
  const kAriaSelectedRoles = ["gridcell","option","row","tab","rowheader","columnheader","treeitem"];
  function getAriaSelected(element) {
    if (elementSafeTagName(element) === "OPTION") return element.selected;
    if (kAriaSelectedRoles.includes(getAriaRole(element) || "")) return getAriaBoolean(element.getAttribute("aria-selected")) === true;
    return false;
  }
  function receivesPointerEvents(element) {
    const cache = cachePointerEvents;
    let e = element;
    let result;
    const parents = [];
    for (; e; e = parentElementOrShadowHost(e)) {
      const cached = cache ? cache.get(e) : undefined;
      if (cached !== undefined) { result = cached; break; }
      parents.push(e);
      const style = getElementComputedStyle(e);
      if (!style) { result = true; break; }
      const value = style.pointerEvents;
      if (value) { result = value !== "none"; break; }
    }
    if (result === undefined) result = true;
    if (cache) for (const parent of parents) cache.set(parent, result);
    return result;
  }
  function getCSSContent(element, pseudo) {
    const style = getElementComputedStyle(element, pseudo);
    if (!style) return undefined;
    const contentValue = style.content;
    if (!contentValue || contentValue === "none" || contentValue === "normal") return undefined;
    if (style.display === "none" || style.visibility === "hidden") return undefined;
    const match = contentValue.match(/^"(.*)"$/);
    if (match) {
      const content = match[1].replace(/\\"/g, '"');
      if (pseudo) {
        const display = style.display || "inline";
        if (display !== "inline") return " " + content + " ";
      }
      return content;
    }
    return undefined;
  }

  // === refs (persist for the lifetime of the document) ===
  let lastRef = 0;
  const refMap = new Map(); // "e5" -> WeakRef<Element> | Element
  const REF_KEY = "__doobieRef";
  const HasWeakRef = typeof WeakRef === "function";

  function localRefId(id) {
    const m = /^(?:f\d+)?(e\d+)$/.exec(String(id));
    return m ? m[1] : null;
  }
  function refElement(id) {
    const local = localRefId(id);
    if (!local) return null;
    const entry = refMap.get(local);
    if (!entry) return null;
    const el = HasWeakRef && entry instanceof WeakRef ? entry.deref() : entry;
    if (!el || !el.isConnected) return null;
    return el;
  }
  function refBox(id) {
    const el = refElement(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  }

  const INTERACTIVE_ROLES = new Set(["link","button","textbox","checkbox","radio","combobox","listbox","option","menuitem","menuitemcheckbox","menuitemradio","tab","switch","slider","searchbox","spinbutton","treeitem","scrollbar"]);
  // Always kept in interactive mode together with their text: feedback an agent needs to verify an action.
  const FEEDBACK_ROLES = new Set(["alert","alertdialog","status","log","marquee","timer","tooltip"]);
  const CONTEXT_ROLES = new Set(["banner","navigation","main","complementary","contentinfo","region","search","form","dialog","alertdialog","heading","tablist","menu","menubar","radiogroup","toolbar","tree","treegrid","grid","table","row","article","iframe"]);

  function isInteractiveNode(node) {
    if (INTERACTIVE_ROLES.has(node.role)) return true;
    if (node.role === "iframe") return true;
    // A pointer cursor marks an element as clickable only where it is not inherited from a clickable ancestor.
    if (node.box && node.box.cursor === "pointer" && !node.pointerInherited) return true;
    const el = node.element;
    if (el && (el.hasAttribute("onclick") || el.isContentEditable)) return true;
    return false;
  }
  function isFeedbackNode(node) {
    if (FEEDBACK_ROLES.has(node.role)) return true;
    const el = node.element;
    if (!el) return false;
    const live = el.getAttribute("aria-live");
    return !!live && live.toLowerCase() !== "off";
  }
  // Own (non-inherited) reason to be clickable: click handler, tabindex, or a pointer cursor set on this element.
  function hasOwnInteractivity(element, box, pointerInherited) {
    if (element.hasAttribute("onclick") || hasTabIndex(element)) return true;
    return !!box && box.cursor === "pointer" && !pointerInherited;
  }

  // === tree generation ===
  function generateAriaTree(rootElement, options) {
    const visited = new Set();
    const snapshot = {
      root: { role: "fragment", name: "", children: [], element: rootElement, props: {}, box: computeBox(rootElement), receivesPointerEvents: true },
      iframeRefs: []
    };

    const visit = (ariaNode, node, parentElementVisible, pointerInherited) => {
      if (visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === 3 && node.nodeValue) {
        if (!parentElementVisible) return;
        if (ariaNode.role !== "textbox") ariaNode.children.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node;
      const isElementVisibleForAria = !isElementHiddenForAria(element);
      const visible = isElementVisibleForAria || isElementVisible(element);
      const ariaChildren = [];
      if (element.hasAttribute("aria-owns")) {
        const ids = element.getAttribute("aria-owns").split(/\s+/);
        for (const id of ids) {
          const ownedElement = rootElement.ownerDocument.getElementById(id);
          if (ownedElement) ariaChildren.push(ownedElement);
        }
      }
      const childAriaNode = visible ? toAriaNode(element, options, pointerInherited) : null;
      if (childAriaNode) ariaNode.children.push(childAriaNode);
      if (element.nodeName === "IFRAME" || element.nodeName === "FRAME") return;
      if (childAriaNode && childAriaNode.editableText !== undefined) return; // contenteditable textbox: value shown, DOM children skipped
      // Descendants of an element that already shows [cursor=pointer] inherit the cursor; they are not clickable on their own.
      const childPointerInherited = pointerInherited || !!(childAriaNode && childAriaNode.box && childAriaNode.box.cursor === "pointer") || getElementComputedStyle(element)?.cursor === "pointer";
      processElement(childAriaNode || ariaNode, element, ariaChildren, visible, childPointerInherited);
    };

    function processElement(ariaNode, element, ariaChildren, parentElementVisible, pointerInherited) {
      const style = getElementComputedStyle(element);
      const display = (style && style.display) || "inline";
      const treatAsBlock = display !== "inline" || element.nodeName === "BR" ? " " : "";
      if (treatAsBlock) ariaNode.children.push(treatAsBlock);
      ariaNode.children.push(getCSSContent(element, "::before") || "");
      const assignedNodes = element.nodeName === "SLOT" ? element.assignedNodes() : [];
      if (assignedNodes.length) {
        for (const child of assignedNodes) visit(ariaNode, child, parentElementVisible, pointerInherited);
      } else {
        for (let child = element.firstChild; child; child = child.nextSibling) {
          if (!child.assignedSlot) visit(ariaNode, child, parentElementVisible, pointerInherited);
        }
        if (element.shadowRoot) {
          for (let child = element.shadowRoot.firstChild; child; child = child.nextSibling) visit(ariaNode, child, parentElementVisible, pointerInherited);
        }
      }
      for (const child of ariaChildren) visit(ariaNode, child, parentElementVisible, pointerInherited);
      ariaNode.children.push(getCSSContent(element, "::after") || "");
      if (treatAsBlock) ariaNode.children.push(treatAsBlock);
      if (ariaNode.children.length === 1 && ariaNode.name === ariaNode.children[0]) ariaNode.children = [];
      if (ariaNode.role === "link" && element.hasAttribute("href") && options.urls !== false) ariaNode.props["url"] = element.getAttribute("href");
      if (ariaNode.role === "textbox" && element.hasAttribute("placeholder") && element.getAttribute("placeholder") !== ariaNode.name) ariaNode.props["placeholder"] = element.getAttribute("placeholder");
    }

    beginAriaCaches();
    try { visit(snapshot.root, rootElement, true, false); }
    finally { endAriaCaches(); }
    normalizeStringChildren(snapshot.root);
    normalizeGenericRoles(snapshot.root);
    return snapshot;
  }

  function shouldHaveRef(ariaNode) {
    // A generic under an element that already carries the pointer ref (link/button/clickable div) is not a
    // separate click target: no ref unless it is clickable on its own.
    if (ariaNode.role === "generic" && ariaNode.pointerInherited && !hasOwnInteractivity(ariaNode.element, ariaNode.box, true)) return false;
    if (ariaNode.box.visible && ariaNode.receivesPointerEvents) return true;
    if (INTERACTIVE_ROLES.has(ariaNode.role)) {
      if (ariaNode.role === "option" && ariaNode.element.closest("select,datalist")) return false;
      return true;
    }
    return false;
  }

  function computeAriaRef(ariaNode, options) {
    if (!shouldHaveRef(ariaNode)) return;
    const element = ariaNode.element;
    let ariaRef = element[REF_KEY];
    if (!ariaRef || ariaRef.role !== ariaNode.role || ariaRef.name !== ariaNode.name) {
      ariaRef = { role: ariaNode.role, name: ariaNode.name, ref: "e" + (++lastRef) };
      try { Object.defineProperty(element, REF_KEY, { value: ariaRef, configurable: true, writable: true, enumerable: false }); }
      catch (e) { element[REF_KEY] = ariaRef; }
      refMap.set(ariaRef.ref, HasWeakRef ? new WeakRef(element) : element);
    } else if (!refMap.has(ariaRef.ref)) {
      refMap.set(ariaRef.ref, HasWeakRef ? new WeakRef(element) : element);
    }
    ariaNode.ref = (options.refPrefix || "") + ariaRef.ref;
  }

  function toAriaNode(element, options, pointerInherited) {
    const doc = element.ownerDocument;
    const active = doc.activeElement === element && element !== doc.body;
    if (element.nodeName === "IFRAME" || element.nodeName === "FRAME") {
      const ariaNode = { role: "iframe", name: "", children: [], props: {}, element, box: computeBox(element), receivesPointerEvents: true, active, pointerInherited };
      computeAriaRef(ariaNode, options);
      return ariaNode;
    }
    const role = getAriaRole(element) || "generic";
    if (role === "presentation" || role === "none") return null;
    const name = normalizeWhiteSpace(getElementAccessibleName(element, false) || "");
    const receivesPointerEventsValue = receivesPointerEvents(element);
    const box = computeBox(element);
    // Inline span with a single text node: inline its text into the parent unless it is clickable on its own.
    if (role === "generic" && box.inline && element.childNodes.length === 1 && element.childNodes[0].nodeType === 3 && !hasOwnInteractivity(element, box, pointerInherited)) return null;
    const result = { role, name, children: [], props: {}, element, box, receivesPointerEvents: receivesPointerEventsValue, active, pointerInherited };
    computeAriaRef(result, options);
    if (kAriaCheckedRoles.includes(role)) result.checked = getAriaChecked(element);
    if (kAriaDisabledRoles.includes(role)) result.disabled = getAriaDisabled(element);
    if (kAriaExpandedRoles.includes(role)) result.expanded = getAriaExpanded(element);
    if (kAriaLevelRoles.includes(role)) result.level = getAriaLevel(element);
    if (kAriaPressedRoles.includes(role)) result.pressed = getAriaPressed(element);
    if (kAriaSelectedRoles.includes(role)) result.selected = getAriaSelected(element);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const t = element.type;
      if (t !== "checkbox" && t !== "radio" && t !== "file" && t !== "password" && t !== "hidden") result.children = [element.value];
    } else if (role === "textbox" && element.isContentEditable) {
      // contenteditable editor (ProseMirror, Quill, Gmail compose...): show its text as the value.
      let text = normalizeWhiteSpace(element.innerText || element.textContent || "");
      if (text.length > 2000) text = text.slice(0, 2000) + "\u2026";
      result.editableText = text;
      result.children = text ? [text] : [];
    }
    return result;
  }

  function normalizeGenericRoles(node) {
    const normalizeChildren = (node) => {
      const result = [];
      for (const child of node.children || []) {
        if (typeof child === "string") { result.push(child); continue; }
        result.push(...normalizeChildren(child));
      }
      const removeSelf = node.role === "generic" && !node.name && result.length <= 1 && result.every(c => typeof c !== "string" && !!c.ref);
      if (removeSelf) return result;
      node.children = result;
      return [node];
    };
    normalizeChildren(node);
  }

  function normalizeStringChildren(rootA11yNode) {
    const flushChildren = (buffer, normalizedChildren) => {
      if (!buffer.length) return;
      const text = normalizeWhiteSpace(buffer.join(""));
      if (text) normalizedChildren.push(text);
      buffer.length = 0;
    };
    const visit = (ariaNode) => {
      const normalizedChildren = [];
      const buffer = [];
      for (const child of ariaNode.children || []) {
        if (typeof child === "string") buffer.push(child);
        else { flushChildren(buffer, normalizedChildren); visit(child); normalizedChildren.push(child); }
      }
      flushChildren(buffer, normalizedChildren);
      ariaNode.children = normalizedChildren.length ? normalizedChildren : [];
      if (ariaNode.children.length === 1 && ariaNode.children[0] === ariaNode.name) ariaNode.children = [];
    };
    visit(rootA11yNode);
  }

  // interactive mode: keep interactive nodes + heading/landmark ancestors with kept descendants.
  // Feedback (alert/status/log/tooltip/aria-live) and dialog text are kept verbatim: that is what an agent verifies.
  function pruneInteractive(root) {
    const prune = (node, inInteractive) => {
      const out = [];
      for (const child of node.children) {
        if (typeof child === "string") { if (inInteractive) out.push(child); continue; }
        if (isFeedbackNode(child)) { out.push(child); continue; }
        const inter = isInteractiveNode(child);
        const ctx = CONTEXT_ROLES.has(child.role);
        const dialog = child.role === "dialog" || child.role === "alertdialog";
        const kids = prune(child, inter || dialog ? true : (ctx ? false : inInteractive));
        if (inter || child.role === "heading") { child.children = kids; out.push(child); }
        else if (dialog) { child.children = kids; out.push(child); }
        else if (ctx && kids.length) { child.children = kids; out.push(child); }
        else if (child.role === "paragraph" && inInteractive) { child.children = kids; out.push(child); }
        else out.push(...kids);
      }
      return out;
    };
    root.children = prune(root, false);
  }

  function hasPointerCursor(ariaNode) { return ariaNode.box.cursor === "pointer"; }
  // Roles that are interactive by definition: [cursor=pointer] adds nothing for them
  // (it is ~20% of a link-heavy snapshot), so it is only rendered on other roles.
  const kImplicitlyClickableRoles = new Set(["link","button","checkbox","radio","combobox","textbox","searchbox","menuitem","menuitemcheckbox","menuitemradio","tab","switch","option","slider","spinbutton","listbox","menu","menubar","tablist","treeitem"]);
  function showsPointerCursor(ariaNode) { return hasPointerCursor(ariaNode) && !kImplicitlyClickableRoles.has(ariaNode.role); }

  function renderAriaTree(ariaSnapshot, options) {
    const lines = [];
    const iframes = [];
    let refCount = 0;
    const maxDepth = options.depth > 0 ? options.depth : 0;
    const offX = options.boxOffset ? options.boxOffset[0] || 0 : 0;
    const offY = options.boxOffset ? options.boxOffset[1] || 0 : 0;
    const nodesToRender = ariaSnapshot.root.role === "fragment" ? ariaSnapshot.root.children : [ariaSnapshot.root];

    const visitText = (text, indent) => {
      const escaped = yamlEscapeValueIfNeeded(text);
      if (escaped) lines.push(indent + "- text: " + escaped);
    };
    const createKey = (ariaNode, renderCursorPointer, depthCut) => {
      let key = ariaNode.role;
      if (ariaNode.name && ariaNode.name.length <= 900) {
        const name = ariaNode.name;
        const stringifiedName = name.startsWith("/") && name.endsWith("/") ? name : JSON.stringify(name);
        key += " " + stringifiedName;
      }
      if (ariaNode.checked === "mixed") key += " [checked=mixed]";
      if (ariaNode.checked === true) key += " [checked]";
      if (ariaNode.disabled) key += " [disabled]";
      if (ariaNode.expanded) key += " [expanded]";
      if (ariaNode.active) key += " [active]";
      if (ariaNode.level) key += " [level=" + ariaNode.level + "]";
      if (ariaNode.pressed === "mixed") key += " [pressed=mixed]";
      if (ariaNode.pressed === true) key += " [pressed]";
      if (ariaNode.selected === true) key += " [selected]";
      if (ariaNode.ref) {
        refCount++;
        key += " [ref=" + ariaNode.ref + "]";
        if (options.boxes && ariaNode.box && ariaNode.box.rect) {
          const r = ariaNode.box.rect;
          key += " [box=" + Math.round(r.left + offX) + "," + Math.round(r.top + offY) + "," + Math.round(r.width) + "," + Math.round(r.height) + "]";
        }
        if (renderCursorPointer && showsPointerCursor(ariaNode)) key += " [cursor=pointer]";
      }
      if (depthCut) key += " [\u2026]"; // children hidden by opts.depth; scope into this ref to see them
      return key;
    };
    const visit = (ariaNode, indent, renderCursorPointer, level) => {
      const atDepthLimit = !!maxDepth && level >= maxDepth;
      const children = atDepthLimit ? ariaNode.children.filter(c => typeof c === "string") : ariaNode.children;
      const depthCut = atDepthLimit && children.length !== ariaNode.children.length;
      const escapedKey = indent + "- " + yamlEscapeKeyIfNeeded(createKey(ariaNode, renderCursorPointer, depthCut));
      const propKeys = Object.keys(ariaNode.props);
      const singleInlinedTextChild = children.length === 1 && typeof children[0] === "string" && !propKeys.length ? children[0] : undefined;
      if (ariaNode.role === "iframe" && ariaNode.ref) {
        const r = ariaNode.box && ariaNode.box.rect;
        const el = ariaNode.element;
        const origin = r ? [Math.round(r.left + offX + (el.clientLeft || 0)), Math.round(r.top + offY + (el.clientTop || 0))] : [offX, offY];
        iframes.push({ ref: ariaNode.ref, line: lines.length, origin });
      }
      if (!children.length && !propKeys.length) {
        lines.push(escapedKey);
      } else if (singleInlinedTextChild !== undefined) {
        lines.push(escapedKey + ": " + yamlEscapeValueIfNeeded(singleInlinedTextChild));
      } else {
        lines.push(escapedKey + ":");
        for (const name of propKeys) lines.push(indent + "  - /" + name + ": " + yamlEscapeValueIfNeeded(ariaNode.props[name]));
        const childIndent = indent + "  ";
        const inCursorPointer = !!ariaNode.ref && renderCursorPointer && hasPointerCursor(ariaNode);
        for (const child of children) {
          if (typeof child === "string") visitText(child, childIndent);
          else visit(child, childIndent, renderCursorPointer && !inCursorPointer, level + 1);
        }
      }
    };
    for (const nodeToRender of nodesToRender) {
      if (typeof nodeToRender === "string") visitText(nodeToRender, "");
      else visit(nodeToRender, "", true, 1);
    }
    return { lines, iframes, refCount };
  }

  function resolveScope(scope) {
    if (!scope) return document.body || document.documentElement;
    if (/^(?:f\d+)?e\d+$/.test(scope)) {
      const el = refElement(scope);
      if (!el) throw new Error('Ref "' + scope + '" is stale or unknown. Take a new page.snapshot() and use a fresh ref.');
      return el;
    }
    const el = document.querySelector(scope);
    if (!el) throw new Error('snapshot scope "' + scope + '" matched no element.');
    return el;
  }

  function snapshot(opts) {
    opts = opts || {};
    const root = resolveScope(opts.scope);
    const tree = generateAriaTree(root, opts);
    if (opts.interactive) pruneInteractive(tree.root);
    const rendered = renderAriaTree(tree, opts);
    let lines = rendered.lines;
    let truncated = false;
    let droppedLines = 0;
    // Safety valve only: the host does the real maxChars truncation on the combined output.
    const hardCap = opts.maxChars > 0 ? opts.maxChars * 4 : 0;
    if (hardCap) {
      let total = 0;
      for (let i = 0; i < lines.length; i++) {
        total += lines[i].length + 1;
        if (total > hardCap) {
          droppedLines = lines.length - i;
          lines = lines.slice(0, i);
          truncated = true;
          break;
        }
      }
    }
    const iframes = rendered.iframes.filter(f => f.line < lines.length);
    return { yaml: lines.join("\n"), refs: rendered.refCount, truncated, droppedLines, iframes };
  }

  window.__doobie = { version: ${INPAGE_VERSION}, snapshot, ref: refElement, box: refBox };
})()`;
