"use strict";

// Serialized into the page: keep this function self-contained.
function probeComposer(expected, token, prepare = false, findSend = false) {
  // innerText expands rich-editor paragraph boundaries into blank lines and
  // trailing spaces. Compare canonical paragraph breaks while retaining every
  // non-whitespace character and spaces inside each line.
  const normalize = value => String(value ?? "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/[ \t]*\n(?:[ \t]*\n)*/g, "\n").trim();
  const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden"; };
  const nodes = new Set(), roots = new Set();
  const collect = root => {
    if (!root || roots.has(root)) return;
    roots.add(root);
    for (const el of root.querySelectorAll('textarea,input:not([type="file"]):not([type="search"]):not([type="button"]):not([type="submit"]),[contenteditable="true"],[role="textbox"],[data-slate-editor="true"],.ProseMirror')) nodes.add(el);
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) collect(el.shadowRoot);
  };
  collect(document);
  const candidates = [...nodes].filter(el => {
    const hint = [el.getAttribute("placeholder"), el.getAttribute("aria-placeholder"), el.getAttribute("aria-label"), el.getAttribute("data-testid"), el.className].join(" ");
    return visible(el) && !el.disabled && !el.readOnly && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable) && !/(search|搜索|项目|素材|任务)/i.test(hint);
  }).sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom || b.getBoundingClientRect().width - a.getBoundingClientRect().width);
  const input = candidates[0];
  if (!input) return {ready: false, prepared: false, reason: "composer-not-found"};
  if (prepare) {
    if (!input.__doubaoCompositionGuard) {
      input.__doubaoCompositionGuard = {active: false};
      input.addEventListener("compositionstart", () => { input.__doubaoCompositionGuard.active = true; });
      input.addEventListener("compositionend", () => { input.__doubaoCompositionGuard.active = false; });
    }
    if (input.__doubaoCompositionGuard.active) return {ready: false, prepared: false, reason: "composer-composing"};
    input.focus();
    if ("value" in input) input.select();
    else {
      const range = document.createRange(); range.selectNodeContents(input);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
    if (input.getRootNode().activeElement !== input) return {ready: false, prepared: false, reason: "composer-not-focused"};
    input.setAttribute("data-doubao-composer-token", token);
  }
  const actual = normalize("value" in input ? input.value : (input.innerText ?? input.textContent));
  const sameEditor = input.getAttribute("data-doubao-composer-token") === token;
  const ready = Boolean(normalize(expected)) && sameEditor && !input.__doubaoCompositionGuard?.active && actual === normalize(expected);
  // Only lengths and status leave the page; diagnostics must not log the prompt.
  const result = {ready, prepared: prepare, actualLength: actual.length, expectedLength: normalize(expected).length,
    reason: ready ? "" : (!sameEditor ? "composer-replaced" : "composer-text-not-ready")};
  if (!ready && sameEditor) {
    const wanted = normalize(expected);
    let mismatch = 0;
    while (mismatch < actual.length && mismatch < wanted.length && actual[mismatch] === wanted[mismatch]) mismatch++;
    result.textDifference = {index: mismatch, actualCode: actual.charCodeAt(mismatch), expectedCode: wanted.charCodeAt(mismatch), actualLines: actual.split("\n").length, expectedLines: wanted.split("\n").length};
  }
  if (ready && findSend) {
    const ir = input.getBoundingClientRect(), buttons = new Set();
    for (const root of roots) for (const el of root.querySelectorAll('button,[role="button"],[data-dbx-name="button"]')) buttons.add(el);
    const candidates = [...buttons].filter(visible).map(el => {
      const r = el.getBoundingClientRect();
      const label = String(el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, "");
      const blocked = /停止|暂停|取消|排队|稍后|stop|cancel|queue/i.test(label);
      const semantic = !blocked && (/发送|生成/.test(label) || /send|generate|submit|g-send-msg-btn/i.test(el.outerHTML || ""));
      const near = r.left >= ir.left - 24 && r.right <= ir.right + 24 && r.top >= ir.top - 24 && r.bottom <= ir.bottom + 86;
      return {el, r, label, semantic, near};
    }).filter(item => item.semantic && item.near).sort((a, b) => Math.hypot(a.r.left - ir.right, a.r.top - ir.bottom) - Math.hypot(b.r.left - ir.right, b.r.top - ir.bottom));
    const item = candidates[0];
    if (!item) result.reason = "send-control-not-found";
    else if (item.el.disabled || item.el.getAttribute("aria-disabled") === "true" || ["true", "1", "disabled"].includes(String(item.el.getAttribute("data-disabled") || "").toLowerCase())) result.reason = "send-control-disabled";
    else result.sendPoint = {x: item.r.left + item.r.width / 2, y: item.r.top + item.r.height / 2, label: item.label};
  }
  return result;
}

// Serialized into the page. A queued chip is not a user message, even when
// the editor is empty. Never return prompt text in these diagnostics.
function probeConversationTurn(expected = "") {
  const visible = el => { if (!el) return false; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden"; };
  const compact = value => String(value || "").replace(/\s+/g, "");
  const text = el => String(el?.innerText || el?.textContent || "");
  const wanted = compact(expected);
  const editor = [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].filter(visible).sort((a,b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  const controls = [...document.querySelectorAll('button,[role="button"],[data-dbx-name="button"]')].filter(visible);
  const responding = controls.some(el => {
    const label = [text(el), el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("data-testid"), el.id].join(" ");
    return /停止(?:生成|回答|响应|输出)|stop[-_ ]?(?:generat|respond|output)|(?:^|\s)stop(?:\s|$)/i.test(label);
  });
  const messages = [...document.querySelectorAll('[data-message-id]')];
  const userMessages = messages.filter(el => /user/i.test(String(el.getAttribute("data-role") || el.getAttribute("data-author") || ""))
    || /(^|\s)justify-end(\s|$)/.test(String(el.className || ""))
    || Boolean(el.querySelector('[class*="g-send-msg-bubble"],[class*="send-msg-bubble"],[class*="user-message"]')));
  const matched = wanted ? userMessages.filter(el => compact(text(el)).includes(wanted)).at(-1) : null;
  const er = editor?.getBoundingClientRect();
  const queued = Boolean(wanted && er && [...document.querySelectorAll('div,span,p')].some(el => {
    if (!visible(el) || el === editor || el.contains(editor) || messages.some(message => message.contains(el) || el.contains(message))) return false;
    const r = el.getBoundingClientRect(), own = compact(text(el));
    return r.bottom >= er.top - 180 && r.top < er.top + 20 && own.includes(wanted) && own.length <= wanted.length + 80;
  }));
  return {known: Boolean(editor), responding, queued, delivered: Boolean(matched), userMessageId: matched?.getAttribute('data-message-id') || "",
    conversationId: String(location.pathname || "").match(/\/chat\/(\d{6,})/)?.[1] || ""};
}

module.exports = {probeComposer, probeConversationTurn};
