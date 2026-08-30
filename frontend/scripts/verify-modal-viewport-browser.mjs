import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromeBinary = [process.env.DG_CHROME_BIN, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((candidate) => candidate && existsSync(candidate));
assert.ok(chromeBinary, "A Chromium browser is required for the rendered modal viewport certification.");

const temporaryRoot = await mkdtemp(join(frontendRoot, ".modal-browser-"));
const chromeProfile = join(temporaryRoot, "chrome");
const outputRoot = join(temporaryRoot, "dist");
let chrome;
let server;

const harness = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { DetailsDrawer, Modal } from "@design-system";
import "@styles";
import "@enterprise";

function Harness() {
  const [overlay, setOverlay] = useState(null);
  return <div className="workspace-page" id="workspace">
    <section id="transformed-surface" style={{ height: 420, marginLeft: 170, overflow: "hidden", width: 690 }}>
      <button id="open-destroy" onClick={() => setOverlay("destroy")} type="button">Open destroy</button>
      <button id="open-rollback" onClick={() => setOverlay("rollback")} type="button">Open rollback</button>
      <button id="open-drawer" onClick={() => setOverlay("drawer")} type="button">Open drawer</button>
      {overlay === "destroy" ? <Modal labelledBy="destroy-title" onClose={() => setOverlay(null)}>
        <p className="eyebrow">Permanent project deletion</p><h2 id="destroy-title">Delete this project and its owned resources?</h2>
        <p>Each recorded generation and the separate project resources will be cleaned by exact identity. Shared platform networking, cluster and load balancer remain untouched. Type <strong>DESTROY</strong> to confirm.</p>
        <label className="field"><span>Confirmation</span><input autoFocus defaultValue="DESTROY" id="destroy-input" /></label>
        <div className="overview-modal-actions"><button id="destroy-cancel" type="button">Cancel</button><button id="confirm-destroy" type="button">Confirm destroy</button></div>
      </Modal> : null}
      {overlay === "rollback" ? <Modal labelledBy="rollback-title" onClose={() => setOverlay(null)}>
        <p className="eyebrow">Application release</p><h2 id="rollback-title">Rollback application?</h2>
        <div className="state"><strong>Previous immutable release</strong><p>The stored image digest and runtime configuration will be reused.</p></div>
        <p>Repository code will not be rebuilt.</p><div className="overview-modal-actions"><button type="button">Cancel</button><button id="confirm-rollback" type="button">Confirm rollback</button></div>
      </Modal> : null}
      {overlay === "drawer" ? <DetailsDrawer labelledBy="drawer-title" onClose={() => setOverlay(null)} title="Attempt details"><p>Drawer evidence</p></DetailsDrawer> : null}
    </section>
  </div>;
}
createRoot(document.getElementById("root")).render(<Harness />);
`;

function contentType(pathname) {
  return ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp" })[extname(pathname)] || "application/octet-stream";
}

async function waitFor(check, message, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(message);
}

try {
  await writeFile(join(temporaryRoot, "index.html"), '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/src.jsx"></script></body></html>');
  await writeFile(join(temporaryRoot, "src.jsx"), harness);
  await build({
    root: temporaryRoot,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    resolve: { alias: {
      "@design-system": resolve(frontendRoot, "src/components/common/DesignSystem.jsx"),
      "@styles": resolve(frontendRoot, "src/styles.css"),
      "@enterprise": resolve(frontendRoot, "src/design-system.css"),
    } },
    build: { outDir: outputRoot, emptyOutDir: true },
  });

  server = createServer(async (request, response) => {
    try {
      const pathname = request.url === "/" ? "/index.html" : new URL(request.url, "http://localhost").pathname;
      const file = resolve(outputRoot, `.${pathname}`);
      assert.ok(file.startsWith(`${outputRoot}/`) || file === join(outputRoot, "index.html"));
      const contents = await readFile(file);
      response.writeHead(200, { "content-type": contentType(file) });
      response.end(contents);
    } catch {
      response.writeHead(404); response.end("Not found");
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  chrome = spawn(chromeBinary, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${chromeProfile}`, `http://127.0.0.1:${address.port}`], { stdio: "ignore" });
  const debuggingPort = await waitFor(async () => {
    try { return Number((await readFile(join(chromeProfile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]); } catch { return 0; }
  }, "Chrome did not expose its debugging port.");
  const targets = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`).then((response) => response.json());
  const target = targets.find((candidate) => candidate.type === "page");
  assert.ok(target, "Chrome page target is unavailable.");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => { socket.onopen = resolveOpen; socket.onerror = rejectOpen; });
  let messageId = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id || !pending.has(message.id)) return;
    const callbacks = pending.get(message.id); pending.delete(message.id);
    message.error ? callbacks.reject(new Error(message.error.message)) : callbacks.resolve(message.result);
  };
  function command(method, params = {}) {
    const id = ++messageId;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveMessage, rejectMessage) => pending.set(id, { resolve: resolveMessage, reject: rejectMessage }));
  }
  async function evaluate(expression) {
    const response = await command("Runtime.evaluate", { expression, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  }
  async function open(trigger, expectedSelector) {
    const openerId = await evaluate(`(() => { const trigger=document.querySelector(${JSON.stringify(trigger)}); trigger.focus(); return document.activeElement?.id; })()`);
    assert.equal(openerId, trigger.slice(1), `${trigger} could not receive focus before opening the overlay`);
    await evaluate(`(() => { document.querySelector(${JSON.stringify(trigger)}).click(); return true; })()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(expectedSelector)}))`), `${expectedSelector} did not render.`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 220));
  }
  async function closeWithEscape() {
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await waitFor(() => evaluate("!document.querySelector('.ds-modal-backdrop,.ds-drawer-backdrop')"), "Escape did not close the shared overlay.");
  }

  await command("Runtime.enable");
  await waitFor(() => evaluate("Boolean(document.querySelector('#open-destroy'))"), "React modal harness did not render.");
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('#transformed-surface')).transform"), "none", "Fixture must reproduce a transformed containing block.");

  const viewports = [
    { name: "failing-desktop", width: 1365, height: 600 },
    { name: "short-desktop", width: 1024, height: 360 },
    { name: "responsive", width: 560, height: 480 },
    { name: "short-responsive", width: 390, height: 280 },
  ];
  for (const viewport of viewports) {
    await command("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
    await open("#open-destroy", ".ds-modal-backdrop");
    const geometry = await evaluate(`(() => { const backdrop=document.querySelector('.ds-modal-backdrop'); const modal=document.querySelector('.ds-modal'); const confirm=document.querySelector('#confirm-destroy'); const bounds=backdrop.getBoundingClientRect(); const modalBounds=modal.getBoundingClientRect(); modal.scrollTop=modal.scrollHeight; const actionBounds=confirm.getBoundingClientRect(); return { parentIsBody:backdrop.parentElement===document.body, bounds:{top:bounds.top,left:bounds.left,right:bounds.right,bottom:bounds.bottom,width:bounds.width,height:bounds.height}, modalBounds:{top:modalBounds.top,bottom:modalBounds.bottom}, actionBounds:{top:actionBounds.top,bottom:actionBounds.bottom}, viewport:{width:document.documentElement.clientWidth,height:document.documentElement.clientHeight}, bodyOverflow:getComputedStyle(document.body).overflow, modalOverflow:getComputedStyle(modal).overflowY, scrollable:modal.scrollHeight>modal.clientHeight, activeId:document.activeElement?.id }; })()`);
    assert.equal(geometry.parentIsBody, true, `${viewport.name}: modal was not portalled to document.body`);
    assert.deepEqual(geometry.bounds, { top: 0, left: 0, right: geometry.viewport.width, bottom: geometry.viewport.height, width: geometry.viewport.width, height: geometry.viewport.height }, `${viewport.name}: backdrop does not equal the browser layout viewport`);
    assert.equal(geometry.bodyOverflow, "hidden", `${viewport.name}: background body remained scrollable`);
    assert.equal(geometry.modalOverflow, "auto", `${viewport.name}: modal has no internal scroll path`);
    assert.ok(geometry.actionBounds.top >= geometry.modalBounds.top && geometry.actionBounds.bottom <= geometry.modalBounds.bottom, `${viewport.name}: Confirm destroy is unreachable`);
    assert.equal(geometry.activeId, "destroy-input", `${viewport.name}: autofocus was not preserved`);
    if (["short-desktop", "short-responsive"].includes(viewport.name)) assert.equal(geometry.scrollable, true, `${viewport.name}: fixture must exercise modal scrolling`);

    await evaluate("document.querySelector('#confirm-destroy').focus()");
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
    assert.equal(await evaluate("document.activeElement?.id"), "destroy-input", `${viewport.name}: focus trap did not wrap forward`);
    await closeWithEscape();
    assert.equal(await evaluate("document.body.style.overflow"), "", `${viewport.name}: body scroll lock was not restored`);
    await waitFor(() => evaluate("document.activeElement?.id === 'open-destroy'"), `${viewport.name}: focus was not restored to the opener`);
  }

  await open("#open-destroy", ".ds-modal-backdrop");
  await evaluate("document.querySelector('.ds-modal-backdrop').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))");
  await waitFor(() => evaluate("!document.querySelector('.ds-modal-backdrop')"), "Backdrop interaction did not close the modal.");

  await open("#open-rollback", ".ds-modal-backdrop");
  assert.equal(await evaluate("document.querySelector('.ds-modal-backdrop').parentElement===document.body && Boolean(document.querySelector('#confirm-rollback'))"), true, "Rollback did not use the viewport-level shared modal.");
  await closeWithEscape();

  await open("#open-drawer", ".ds-drawer-backdrop");
  assert.equal(await evaluate("document.querySelector('.ds-drawer-backdrop').parentElement===document.body"), true, "Shared drawer remained trapped by the transformed page ancestor.");
  await closeWithEscape();
  socket.close();
  console.log("Shared modal browser certification passed: body portal, viewport bounds, scrolling, Destroy, Rollback, drawer, focus trap, Escape, backdrop close, focus restoration, and body lock.");
} finally {
  if (chrome && chrome.exitCode === null) {
    chrome.kill("SIGTERM");
    await new Promise((resolveExit) => chrome.once("exit", resolveExit));
  }
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  await rm(temporaryRoot, { recursive: true, force: true });
}
