// client/src/monitor.ts
function startMonitor(root, url, selector) {
  let busy = false;
  const refresh = async () => {
    if (busy) return;
    busy = true;
    const status = root.querySelector("[data-monitor-status]");
    try {
      const response = await fetch(url, { credentials: "same-origin", signal: AbortSignal.timeout(1e4) });
      if (!response.ok) throw new Error(String(response.status));
      const fragment = new DOMParser().parseFromString(await response.text(), "text/html").querySelector(selector);
      const current = root.querySelector(selector);
      let deferred = false;
      if (fragment && current) {
        deferred = Boolean(current.querySelector("details[open]")) || current.contains(root.activeElement);
        if (!deferred) current.replaceWith(fragment);
      }
      if (status) status.textContent = `\u53D6\u5F97\u6642\u523B ${(/* @__PURE__ */ new Date()).toLocaleTimeString("ja-JP")} \xB7 ${deferred ? "\u8A73\u7D30\u3092\u95B2\u89A7\u4E2D\u306E\u305F\u3081\u8868\u793A\u66F4\u65B0\u3092\u4FDD\u7559\u3057\u3066\u3044\u307E\u3059" : "\u8868\u793A\u3092\u66F4\u65B0\u3057\u307E\u3057\u305F"}`;
    } catch {
      if (status) status.textContent = "\u66F4\u65B0\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002\u8868\u793A\u306F\u524D\u56DE\u306E\u53D6\u5F97\u7D50\u679C\u3067\u3059\u3002";
    } finally {
      busy = false;
    }
  };
  root.querySelector('[data-action="monitor-refresh"]')?.addEventListener("click", () => {
    void refresh();
  });
  const poll = () => {
    setTimeout(() => {
      if (root.visibilityState !== "hidden" && root.querySelector("[data-monitor-auto]")?.checked) void refresh();
      poll();
    }, 5e3);
  };
  poll();
}

// client/src/security.ts
if (typeof document !== "undefined") startMonitor(document, "/api/security/analysis-view", "[data-analysis-results]");
