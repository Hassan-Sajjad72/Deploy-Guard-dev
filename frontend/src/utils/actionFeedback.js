/**
 * Action feedback — presentation only.
 *
 * Answers "did my press register / is it working / did it succeed?" for any
 * button without touching page logic:
 *   - the pressed button that becomes disabled is marked aria-busy (inline
 *     spinner) with its width locked, so the label change cannot shift layout;
 *   - when an outcome is reported (toast tone, or an ErrorState appearing),
 *     the same button plays a success check or a failure shake once it is
 *     interactive again.
 */
const BUTTON = "button, .button, .ds-button, .secondary-button, .danger-button, .danger-text-button, .dg-cta";
const WINDOW_MS = 20000;
let last = null; // { el, at, outcome, observer }

function flash(el, outcome) {
  if (!el?.isConnected || !outcome) return;
  const cls = outcome === "danger" ? "ds-flash-danger" : "ds-flash-success";
  el.classList.remove("ds-flash-danger", "ds-flash-success");
  void el.offsetWidth; // restart the animation if it is already running
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), 900);
}

function settle(entry) {
  if (!entry) return;
  entry.el.removeAttribute("aria-busy");
  entry.el.style.removeProperty("min-width");
  if (entry.outcome) flash(entry.el, entry.outcome);
  entry.outcome = null;
}

function track(el) {
  last?.observer?.disconnect();
  const entry = { el, at: Date.now(), outcome: null, observer: null };
  const width = el.getBoundingClientRect().width;
  entry.observer = new MutationObserver(() => {
    if (el.disabled || el.getAttribute("aria-disabled") === "true") {
      if (!el.hasAttribute("aria-busy")) { el.style.minWidth = `${width}px`; el.setAttribute("aria-busy", "true"); }
    } else if (el.hasAttribute("aria-busy")) {
      settle(entry);
    }
  });
  entry.observer.observe(el, { attributes: true, attributeFilter: ["disabled", "aria-disabled"] });
  window.setTimeout(() => { if (last === entry) { entry.observer.disconnect(); settle(entry); } }, WINDOW_MS);
  last = entry;
}

/** Report the outcome of the most recent action ("success" | "danger"; anything else is ignored). */
export function reportActionOutcome(tone) {
  if (!last || !last.el.isConnected) return;
  const busy = last.el.hasAttribute("aria-busy");
  if (Date.now() - last.at > (busy ? WINDOW_MS : 4000)) return;
  const outcome = tone === "danger" ? "danger" : tone === "success" ? "success" : null;
  if (!outcome) return;
  last.outcome = outcome;
  if (!last.el.hasAttribute("aria-busy")) settle(last);
}

export function installActionFeedback() {
  if (typeof document === "undefined" || document.documentElement.dataset.actionFeedback) return;
  document.documentElement.dataset.actionFeedback = "on";
  const onPress = (event) => {
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    const el = event.target instanceof Element ? event.target.closest(BUTTON) : null;
    if (el && !el.disabled) track(el);
  };
  document.addEventListener("pointerdown", onPress, true);
  document.addEventListener("keydown", onPress, true);
  // Inline outcome banners count too (many forms report success/failure in place, not by toast).
  const SUCCESS = ".state.success, .ds-banner-success";
  const DANGER = ".state.error, .state.danger, .ds-banner-danger";
  new MutationObserver((records) => {
    if (!last) return;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(DANGER) || node.querySelector(DANGER)) { reportActionOutcome("danger"); return; }
        if (node.matches(SUCCESS) || node.querySelector(SUCCESS)) { reportActionOutcome("success"); return; }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}
