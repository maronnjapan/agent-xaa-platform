// client/src/replay-config.ts
var REPLAY_STEP_MS = 800;
var BLOCKED_STOP_RATIO = 0.6;

// client/src/replay-plan.ts
function buildReplayPlan(events, nodeIdFor) {
  const ordered = [...events].sort((left, right) => left.occurred_at.localeCompare(right.occurred_at) || left.event_id.localeCompare(right.event_id));
  let previous = null;
  return ordered.map((event, index) => {
    const from = nodeIdFor(event.source);
    const target = event.detail?.target;
    const declared = typeof target === "string";
    const to = declared ? nodeIdFor(target) : previous;
    const blocked = event.outcome === "blocked" && declared;
    if (from) previous = from;
    return {
      index,
      eventId: event.event_id,
      from,
      to,
      message: event.message,
      outcome: event.outcome,
      phase: event.phase ?? "",
      blocked,
      stopRatio: blocked ? BLOCKED_STOP_RATIO : 1,
      delayMs: REPLAY_STEP_MS
    };
  });
}
function isFinished(plan, playedIndex) {
  return playedIndex >= plan.length - 1;
}

// src/ui/replay/nodes.ts
var NODE_HALF_WIDTH = 70;
var NODE_HALF_HEIGHT = 22;

// src/ui/replay/emphasis.ts
function emphasisClass(outcome, phase) {
  if (outcome === "failed") return "ev-failed";
  if (outcome === "blocked") return phase === "security" ? "ev-blocked-security" : "ev-blocked-tool";
  if (outcome === "success") return "ev-success";
  return "ev-info";
}

// client/src/replay.ts
var SOURCE_TO_NODE = {
  "human-user": "human-user",
  "automation-app": "automation-app",
  "authorization-platform": "authorization-platform",
  authorization: "authorization-platform",
  "agent-provisioner": "agent-provisioner",
  provisioner: "agent-provisioner",
  "agent-op": "agent-op",
  "agent-runtime": "agent-runtime",
  "resource-as": "resource-as",
  "resource-api": "resource-api"
};
var SVG_NS = "http://www.w3.org/2000/svg";
function playReplay(root, events) {
  const plan = buildReplayPlan(events, (source) => SOURCE_TO_NODE[source] ?? null);
  const messages = root.querySelector("[data-messages]");
  const banner = root.querySelector("[data-banner]");
  let index = 0;
  let timer;
  const step = () => {
    const current = plan[index];
    if (!current) return;
    if (current.from === null && current.to === null) {
      if (banner) banner.textContent = current.message;
    } else {
      drawArrow(root, current);
    }
    if (messages) {
      const line = root.ownerDocument.createElement("li");
      line.setAttribute("data-step-index", String(current.index));
      line.textContent = current.message;
      messages.appendChild(line);
    }
    if (isFinished(plan, index)) {
      root.setAttribute("data-replay-state", "finished");
      return;
    }
    index += 1;
    timer = setTimeout(step, REPLAY_STEP_MS);
  };
  resetNodes(root);
  root.setAttribute("data-replay-state", "playing");
  step();
  return () => {
    if (timer !== void 0) clearTimeout(timer);
  };
}
function resetNodes(root) {
  root.querySelectorAll("[data-node]").forEach((node) => {
    node.setAttribute("data-reached", "");
  });
}
function drawArrow(root, step) {
  const arrows = root.querySelector("[data-arrows]");
  const start2 = step.from === null ? null : centreOf(root, step.from);
  const finish = step.to === null ? null : centreOf(root, step.to);
  if (!arrows || !start2 || !finish) return;
  const stop = edgeOf(finish, start2);
  const document_ = root.ownerDocument;
  const path = document_.createElementNS(SVG_NS, "path");
  path.setAttribute("class", "replay-arrow");
  path.setAttribute("data-step-index", String(step.index));
  path.setAttribute("d", lineBetween(start2, stop));
  arrows.appendChild(path);
  const emphasis = emphasisClass(step.outcome, step.phase);
  const dot = document_.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", step.blocked ? "replay-dot is-blocked" : "replay-dot");
  dot.setAttribute("data-step-index", String(step.index));
  dot.setAttribute("data-from", step.from ?? "");
  dot.setAttribute("data-to", step.to ?? "");
  dot.setAttribute("data-emphasis", emphasis);
  if (step.blocked) dot.setAttribute("data-blocked", "true");
  dot.setAttribute("r", "6");
  dot.style.setProperty("offset-path", `path('${lineBetween(start2, stop)}')`);
  dot.style.setProperty("--step-ms", `${REPLAY_STEP_MS}ms`);
  dot.style.setProperty("--stop-ratio", String(step.stopRatio));
  arrows.appendChild(dot);
  if (step.blocked) arrows.appendChild(stopMark(document_, pointAt(start2, stop, step.stopRatio), emphasis));
  const target = step.to === null ? null : root.querySelector(`[data-node="${step.to}"]`);
  if (target) target.setAttribute("data-reached", step.blocked ? "false" : "true");
}
function stopMark(document_, at, emphasis) {
  const mark = document_.createElementNS(SVG_NS, "g");
  mark.setAttribute("class", "replay-stop");
  mark.setAttribute("data-stop", "true");
  mark.setAttribute("data-emphasis", emphasis);
  mark.setAttribute("transform", `translate(${at.x},${at.y})`);
  const ring = document_.createElementNS(SVG_NS, "circle");
  ring.setAttribute("r", "9");
  const bar = document_.createElementNS(SVG_NS, "path");
  bar.setAttribute("d", "M -6 -6 L 6 6");
  mark.appendChild(ring);
  mark.appendChild(bar);
  return mark;
}
function centreOf(root, nodeId) {
  const node = root.querySelector(`[data-node="${nodeId}"]`);
  const x = Number(node?.getAttribute("data-x"));
  const y = Number(node?.getAttribute("data-y"));
  return Number.isFinite(x) && Number.isFinite(y) && node ? { x, y } : null;
}
function edgeOf(target, from) {
  const dx = from.x - target.x;
  const dy = from.y - target.y;
  if (dx === 0 && dy === 0) return target;
  const horizontal = dx === 0 ? Number.POSITIVE_INFINITY : NODE_HALF_WIDTH / Math.abs(dx);
  const vertical = dy === 0 ? Number.POSITIVE_INFINITY : NODE_HALF_HEIGHT / Math.abs(dy);
  const scale = Math.min(1, horizontal, vertical);
  return { x: target.x + dx * scale, y: target.y + dy * scale };
}
function pointAt(from, to, ratio) {
  return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
}
function lineBetween(from, to) {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

// client/src/detail-toggle.ts
function wireDetailToggles(root) {
  root.querySelectorAll('[data-detail="true"]').forEach((element) => {
    element.addEventListener("toggle", () => {
    });
  });
}

// client/src/timeline.ts
function start(root = document) {
  let tasks = [];
  let cancel;
  const status = root.querySelector("[data-timeline-status]");
  const inspectors = Array.from(root.querySelectorAll("[data-inspector-task]"));
  const buttons = Array.from(root.querySelectorAll("[data-task-button]"));
  const play = (panel) => {
    const task = tasks.find((item) => item.task_id === panel.getAttribute("data-inspector-task") && (item.agent_id ?? "") === panel.getAttribute("data-agent-id"));
    const canvas = panel.querySelector(".replay");
    if (!task?.events || !canvas) {
      if (status) status.textContent = "\u518D\u751F\u30C7\u30FC\u30BF\u3092\u53D6\u5F97\u3067\u304D\u3066\u3044\u307E\u305B\u3093\u3002\u66F4\u65B0\u3057\u3066\u518D\u5EA6\u304A\u8A66\u3057\u304F\u3060\u3055\u3044\u3002";
      return;
    }
    cancel?.();
    canvas.querySelector("[data-arrows]")?.replaceChildren();
    canvas.querySelector("[data-messages]")?.replaceChildren();
    const banner = canvas.querySelector("[data-banner]");
    if (banner) banner.textContent = "";
    cancel = playReplay(canvas, task.events);
  };
  for (const button of buttons) button.addEventListener("click", () => {
    cancel?.();
    for (const panel of inspectors) {
      const selected = panel.getAttribute("data-inspector-task") === button.getAttribute("data-task-id") && panel.getAttribute("data-agent-id") === button.getAttribute("data-agent-id");
      panel.hidden = !selected;
      if (selected) {
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
    for (const item of buttons) item.setAttribute("aria-expanded", String(item === button));
  });
  for (const panel of inspectors) panel.querySelector('[data-action="play-replay"]')?.addEventListener("click", () => play(panel));
  wireDetailToggles(root);
  void (async () => {
    try {
      const response = await fetch("/api/activity/tasks", { credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      tasks = body.tasks;
    } catch {
      if (status) status.textContent = "\u518D\u751F\u30C7\u30FC\u30BF\u306E\u53D6\u5F97\u306B\u5931\u6557\u3057\u307E\u3057\u305F\u3002\u66F4\u65B0\u3057\u3066\u518D\u5EA6\u304A\u8A66\u3057\u304F\u3060\u3055\u3044\u3002";
    }
  })();
  root.querySelector('[data-action="refresh"]')?.addEventListener("click", () => root.location.reload());
  const outcome = root.querySelector('[data-filter="outcome"]');
  const search = root.querySelector('[data-filter="search"]');
  const filter = () => {
    const value = outcome?.value ?? "all";
    const query = search?.value.trim().toLocaleLowerCase() ?? "";
    let shown = 0;
    for (const button of buttons) {
      const text = `${button.textContent} ${button.getAttribute("data-agent-id")}`.toLocaleLowerCase();
      const match = (value === "all" || button.getAttribute("data-status") === value || button.getAttribute("data-outcome") === value) && text.includes(query);
      const row = button.closest(".task-row");
      if (row) row.hidden = !match;
      if (match) shown += 1;
    }
    for (const group of Array.from(root.querySelectorAll(".agent-group"))) {
      group.hidden = !group.querySelector(".task-row:not([hidden])");
    }
    for (const panel of inspectors) panel.hidden = true;
    for (const button of buttons) button.setAttribute("aria-expanded", "false");
    cancel?.();
    if (status) status.textContent = shown ? `${shown} \u4EF6\u3092\u8868\u793A` : "\u6761\u4EF6\u306B\u4E00\u81F4\u3059\u308B\u30BF\u30B9\u30AF\u306F\u3042\u308A\u307E\u305B\u3093\u3002";
  };
  outcome?.addEventListener("change", filter);
  search?.addEventListener("input", filter);
}
if (typeof document !== "undefined") start();
export {
  start
};
