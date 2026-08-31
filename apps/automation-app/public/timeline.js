// apps/automation-app/client/src/replay-config.ts
var REPLAY_STEP_MS = 800;
var BLOCKED_STOP_RATIO = 0.6;

// apps/automation-app/client/src/replay-plan.ts
function buildReplayPlan(events, nodeIdFor) {
  const ordered = [...events].sort((left, right) => left.occurred_at.localeCompare(right.occurred_at) || left.event_id.localeCompare(right.event_id));
  let previous = null;
  return ordered.map((event, index) => {
    const from = nodeIdFor(event.source);
    const target = event.detail?.target;
    const to = typeof target === "string" ? nodeIdFor(target) : previous;
    const blocked = event.outcome === "blocked";
    if (from) previous = from;
    return {
      index,
      eventId: event.event_id,
      from,
      to,
      message: event.message,
      blocked,
      stopRatio: blocked ? BLOCKED_STOP_RATIO : 1,
      delayMs: REPLAY_STEP_MS
    };
  });
}
function isFinished(plan, playedIndex) {
  return playedIndex >= plan.length - 1;
}

// apps/automation-app/client/src/replay.ts
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
      drawArrow(root, current.from, current.to, current.blocked, current.index);
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
  root.setAttribute("data-replay-state", "playing");
  step();
  return () => {
    if (timer !== void 0) clearTimeout(timer);
  };
}
function drawArrow(root, from, to, blocked, index) {
  const arrows = root.querySelector("[data-arrows]");
  if (!arrows || !from) return;
  const dot = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("class", blocked ? "replay-dot is-blocked" : "replay-dot");
  dot.setAttribute("data-step-index", String(index));
  dot.setAttribute("data-from", from);
  if (to) dot.setAttribute("data-to", to);
  if (blocked) dot.setAttribute("data-blocked", "true");
  dot.setAttribute("r", "6");
  arrows.appendChild(dot);
  const target = to ? root.querySelector(`[data-node="${to}"]`) : null;
  if (target) target.setAttribute("data-reached", blocked ? "false" : "true");
}

// apps/automation-app/client/src/detail-toggle.ts
function wireDetailToggles(root) {
  for (const element of root.querySelectorAll('[data-detail="true"]')) {
    element.addEventListener("toggle", () => {
    });
  }
}

// apps/automation-app/client/src/timeline.ts
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
