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
  const load = async () => {
    const response = await fetch("/api/activity/tasks", { credentials: "same-origin" });
    if (!response.ok) return;
    const body = await response.json();
    for (const task of body.tasks) {
      const canvas = root.querySelector(`.replay[data-task-id="${task.task_id}"]`);
      if (canvas && Array.isArray(task.events)) {
        canvas.addEventListener("click", () => playReplay(canvas, task.events));
      }
    }
    wireDetailToggles(root);
  };
  void load();
  root.querySelector('[data-action="refresh"]')?.addEventListener("click", () => {
    void load();
  });
}
if (typeof document !== "undefined") start();
export {
  start
};
