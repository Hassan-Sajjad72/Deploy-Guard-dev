export const PROJECT_STATE_CHANGED_EVENT = "deployguard:project-state-changed";

export function publishProjectStateChanged(projectId) {
  window.dispatchEvent(new CustomEvent(PROJECT_STATE_CHANGED_EVENT, {
    detail: { projectId: String(projectId) },
  }));
}

export function subscribeProjectStateChanged(projectId, refresh) {
  const refreshWithoutEvent = () => { void refresh(); };
  const onStateChanged = (event) => {
    if (String(event.detail?.projectId || "") === String(projectId)) void refresh();
  };
  const onPageVisible = () => {
    if (document.visibilityState === "visible") void refresh();
  };
  window.addEventListener(PROJECT_STATE_CHANGED_EVENT, onStateChanged);
  window.addEventListener("focus", refreshWithoutEvent);
  window.addEventListener("pageshow", refreshWithoutEvent);
  document.addEventListener("visibilitychange", onPageVisible);
  return () => {
    window.removeEventListener(PROJECT_STATE_CHANGED_EVENT, onStateChanged);
    window.removeEventListener("focus", refreshWithoutEvent);
    window.removeEventListener("pageshow", refreshWithoutEvent);
    document.removeEventListener("visibilitychange", onPageVisible);
  };
}
