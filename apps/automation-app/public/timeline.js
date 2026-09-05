// client/src/replay-config.ts
var REPLAY_STEP_MS = 800;
var BLOCKED_STOP_RATIO = 0.6;
var STOP_CLEARANCE = 8;
var MIN_STOP_RATIO = 0.15;
var STOP_RATIO_STEP = 0.02;

// client/src/replay-plan.ts
function buildReplayPlan(events, nodeIdFor) {
  const ordered = [...events].sort((left, right) => left.occurred_at.localeCompare(right.occurred_at) || left.event_id.localeCompare(right.event_id));
  const steps = [];
  let previous = null;
  for (const event of ordered) {
    const hops = event.record?.hops ?? [];
    if (hops.length > 0) {
      for (const hop of hops) {
        const from2 = nodeIdFor(hop.from);
        const to2 = nodeIdFor(hop.to);
        const blocked2 = hop.outcome === "blocked" && to2 !== null;
        if (from2) previous = from2;
        if (to2 && !blocked2) previous = to2;
        steps.push(step({
          index: steps.length,
          eventId: event.event_id,
          from: from2,
          to: to2,
          message: hop.message,
          outcome: hop.outcome,
          phase: event.phase ?? "",
          blocked: blocked2
        }));
      }
      continue;
    }
    const from = nodeIdFor(event.source);
    const target = event.detail?.target;
    const declared = typeof target === "string";
    const to = declared ? nodeIdFor(target) : previous;
    const blocked = event.outcome === "blocked" && declared;
    if (from) previous = from;
    steps.push(step({
      index: steps.length,
      eventId: event.event_id,
      from,
      to,
      message: event.message,
      outcome: event.outcome,
      phase: event.phase ?? "",
      blocked
    }));
  }
  return steps;
}
function step(input) {
  return { ...input, stopRatio: input.blocked ? BLOCKED_STOP_RATIO : 1, delayMs: REPLAY_STEP_MS };
}
function isFinished(plan, playedIndex) {
  return playedIndex >= plan.length - 1;
}

// src/ui/replay/nodes.ts
var NODE_HALF_WIDTH = 70;
var NODE_HALF_HEIGHT = 30;

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
function playReplay(root, events, options = {}) {
  const plan = buildReplayPlan(events, (source) => SOURCE_TO_NODE[source] ?? null);
  const messages = root.querySelector("[data-messages]");
  const banner = root.querySelector("[data-banner]");
  const progress = root.querySelector('[data-field="replay-progress"]');
  let index = 0;
  let timer;
  const clearTimer = () => {
    if (timer !== void 0) clearTimeout(timer);
    timer = void 0;
  };
  const draw = (current) => {
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
    if (progress) progress.textContent = `${current.index + 1} / ${plan.length}`;
    markLog(options.log, current.eventId);
  };
  const advance = (schedule) => {
    const current = plan[index];
    if (!current) return;
    draw(current);
    if (isFinished(plan, index)) {
      root.setAttribute("data-replay-state", "finished");
      clearTimer();
      return;
    }
    index += 1;
    if (schedule) timer = setTimeout(() => advance(true), REPLAY_STEP_MS);
  };
  const play = () => {
    if (root.getAttribute("data-replay-state") === "finished") return;
    clearTimer();
    root.setAttribute("data-replay-state", "playing");
    advance(true);
  };
  resetNodes(root);
  if (options.autoplay === false) {
    root.setAttribute("data-replay-state", "paused");
  } else {
    root.setAttribute("data-replay-state", "playing");
    advance(true);
  }
  return {
    play,
    pause() {
      clearTimer();
      if (root.getAttribute("data-replay-state") === "playing") root.setAttribute("data-replay-state", "paused");
    },
    next() {
      clearTimer();
      if (root.getAttribute("data-replay-state") === "finished") return;
      root.setAttribute("data-replay-state", "paused");
      advance(false);
    },
    restart() {
      clearTimer();
      emptyOut(root.querySelector("[data-arrows]"));
      emptyOut(root.querySelector("[data-dots]"));
      emptyOut(messages);
      if (banner) banner.textContent = "";
      resetNodes(root);
      resetLog(options.log);
      index = 0;
      root.setAttribute("data-replay-state", "playing");
      advance(true);
    },
    stop: clearTimer
  };
}
function markLog(log, eventId) {
  if (!log) return;
  let reached = false;
  for (const entry of Array.from(log.querySelectorAll("[data-event-id]"))) {
    if (entry.getAttribute("data-event-id") === eventId) {
      entry.setAttribute("data-entry-state", "current");
      reached = true;
      continue;
    }
    entry.setAttribute("data-entry-state", reached ? "waiting" : "played");
  }
}
function resetLog(log) {
  if (!log) return;
  for (const entry of Array.from(log.querySelectorAll("[data-event-id]"))) {
    entry.setAttribute("data-entry-state", "waiting");
  }
}
function emptyOut(element) {
  if (!element) return;
  while (element.firstChild) element.removeChild(element.firstChild);
}
function resetNodes(root) {
  root.querySelectorAll("[data-node]").forEach((node) => {
    node.setAttribute("data-reached", "");
  });
}
function drawArrow(root, step2) {
  const arrows = root.querySelector("[data-arrows]");
  const start2 = step2.from === null ? null : centreOf(root, step2.from);
  const finish = step2.to === null ? null : centreOf(root, step2.to);
  if (!arrows || !start2 || !finish) return;
  const dots = root.querySelector("[data-dots]") ?? arrows;
  const stop = edgeOf(finish, start2);
  const stopRatio = step2.blocked ? clearStopRatio(root, step2, start2, stop) : step2.stopRatio;
  const document_ = root.ownerDocument;
  const path = document_.createElementNS(SVG_NS, "path");
  path.setAttribute("class", "replay-arrow");
  path.setAttribute("data-step-index", String(step2.index));
  path.setAttribute("d", lineBetween(start2, stop));
  arrows.appendChild(path);
  const emphasis = emphasisClass(step2.outcome, step2.phase);
  const dot = document_.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", step2.blocked ? "replay-dot is-blocked" : "replay-dot");
  dot.setAttribute("data-step-index", String(step2.index));
  dot.setAttribute("data-from", step2.from ?? "");
  dot.setAttribute("data-to", step2.to ?? "");
  dot.setAttribute("data-emphasis", emphasis);
  if (step2.blocked) dot.setAttribute("data-blocked", "true");
  dot.setAttribute("r", "6");
  dot.style.setProperty("offset-path", `path('${lineBetween(start2, stop)}')`);
  dot.style.setProperty("--step-ms", `${REPLAY_STEP_MS}ms`);
  dot.style.setProperty("--stop-ratio", String(stopRatio));
  dots.appendChild(dot);
  if (step2.blocked) dots.appendChild(stopMark(document_, pointAt(start2, stop, stopRatio), emphasis));
  const target = step2.to === null ? null : root.querySelector(`[data-node="${step2.to}"]`);
  if (target) target.setAttribute("data-reached", step2.blocked ? "false" : "true");
}
function clearStopRatio(root, step2, start2, stop) {
  const others = [];
  root.querySelectorAll("[data-node]").forEach((node) => {
    if (node.getAttribute("data-node") === step2.from || node.getAttribute("hidden") !== null) return;
    const x = Number(node.getAttribute("data-x"));
    const y = Number(node.getAttribute("data-y"));
    if (Number.isFinite(x) && Number.isFinite(y)) others.push({ x, y });
  });
  const clear = (ratio) => {
    const at = pointAt(start2, stop, ratio);
    return others.every((node) => Math.abs(at.x - node.x) > NODE_HALF_WIDTH + STOP_CLEARANCE || Math.abs(at.y - node.y) > NODE_HALF_HEIGHT + STOP_CLEARANCE);
  };
  for (let ratio = step2.stopRatio; ratio > MIN_STOP_RATIO; ratio -= STOP_RATIO_STEP) {
    if (clear(ratio)) return Math.round(ratio * 100) / 100;
  }
  return MIN_STOP_RATIO;
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
  const controllers = /* @__PURE__ */ new Map();
  const wired = /* @__PURE__ */ new Set();
  const load = async () => {
    const response = await fetch("/api/activity/tasks", { credentials: "same-origin" });
    if (!response.ok) return;
    const body = await response.json();
    for (const task of body.tasks) {
      if (!Array.isArray(task.events) || wired.has(task.task_id)) continue;
      const canvas = root.querySelector(`.replay[data-task-id="${task.task_id}"]`);
      if (!canvas) continue;
      wired.add(task.task_id);
      const log = root.querySelector(`[data-event-log="${task.task_id}"]`);
      const events = task.events;
      const begin = (autoplay) => {
        const controller = playReplay(canvas, events, { log, autoplay });
        controllers.set(task.task_id, controller);
        return controller;
      };
      canvas.addEventListener("click", (event) => {
        if (isControl(event.target)) return;
        begin(true);
      });
      wireControls(canvas, task.task_id, controllers, begin);
    }
    wireDetailToggles(root);
  };
  void load();
  root.querySelector('[data-action="refresh"]')?.addEventListener("click", () => {
    void load();
  });
}
function isControl(target) {
  return target instanceof Element && target.closest("[data-replay-controls]") !== null;
}
function wireControls(canvas, taskId, controllers, begin) {
  const on = (action, run) => {
    canvas.querySelector(`[data-action="${action}"]`)?.addEventListener("click", () => {
      run(controllers.get(taskId));
    });
  };
  on("replay-play", (controller) => {
    if (controller) controller.play();
    else begin(true);
  });
  on("replay-pause", (controller) => {
    controller?.pause();
  });
  on("replay-step", (controller) => {
    if (controller) controller.next();
    else begin(false).next();
  });
  on("replay-restart", (controller) => {
    if (controller) controller.restart();
    else begin(true);
  });
}
if (typeof document !== "undefined") start();
export {
  start
};
