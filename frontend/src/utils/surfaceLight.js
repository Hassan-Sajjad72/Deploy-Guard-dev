/**
 * Surface light — presentation only.
 *
 * Glass catches the light where the pointer is: the specular highlight of the
 * glass surface under the pointer follows it (--lx / --ly), and tactile cards
 * lean a few degrees toward it (--rx / --ry). One delegated, rAF-throttled
 * listener for the whole document; nothing is attached per element and no page
 * logic is involved. Coarse pointers and reduced motion opt out.
 */
const LIT = [
  ".dg-glass", ".app-shell .sidebar", ".ds-modal", ".destroy-modal", ".ds-details-drawer",
  ".dg-home-kpis > div", ".dg-home-gauge", ".dg-home-tile a", ".dg-ov-window", ".dg-bill-plan", ".dg-hero-copy",
  ".itw-node", ".pg-node", ".dg-np-rail", ".dg-projects-row", ".metric-card", ".dg-set-nav", ".dg-mon-toolbar",
].join(", ");
const TILT = ".dg-home-tile a, .dg-bill-plan, .dg-home-kpis > div";

export function installSurfaceLight() {
  if (typeof window === "undefined" || window.__dgSurfaceLight) return;
  window.__dgSurfaceLight = true;
  const fine = window.matchMedia("(pointer: fine)");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;
  let event = null;
  let current = null;

  function release(element) {
    if (!element) return;
    element.style.removeProperty("--rx");
    element.style.removeProperty("--ry");
    element.classList.remove("is-lit");
  }

  function paint() {
    frame = 0;
    const target = event?.target instanceof Element ? event.target.closest(LIT) : null;
    if (target !== current) { release(current); current = target; }
    if (!target) return;
    const box = target.getBoundingClientRect();
    const x = (event.clientX - box.left) / Math.max(1, box.width);
    const y = (event.clientY - box.top) / Math.max(1, box.height);
    target.style.setProperty("--lx", `${(x * 100).toFixed(1)}%`);
    target.style.setProperty("--ly", `${(y * 100).toFixed(1)}%`);
    target.classList.add("is-lit");
    if (target.matches(TILT)) {
      target.style.setProperty("--rx", `${((0.5 - y) * 5).toFixed(2)}deg`);
      target.style.setProperty("--ry", `${((x - 0.5) * 6).toFixed(2)}deg`);
    }
  }

  document.addEventListener("pointermove", (next) => {
    if (!fine.matches || still.matches) return;
    event = next;
    if (!frame) frame = window.requestAnimationFrame(paint);
  }, { passive: true });
  document.addEventListener("pointerleave", () => { release(current); current = null; });
}
