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
  for (const event of ordered) {
    const phase = event.phase ?? "";
    const hops = event.record?.hops ?? [];
    if (hops.length > 0) {
      for (const hop of hops) {
        const from2 = nodeIdFor(hop.from);
        const to2 = nodeIdFor(hop.to);
        const blocked2 = hop.outcome === "blocked" && to2 !== null;
        steps.push(step({
          index: steps.length,
          eventId: event.event_id,
          kind: from2 !== null && to2 !== null ? "move" : from2 !== null || to2 !== null ? "self" : "banner",
          from: from2,
          to: to2,
          label: hop.label,
          message: hop.message,
          outcome: hop.outcome,
          phase,
          blocked: blocked2
        }));
      }
      continue;
    }
    const from = nodeIdFor(event.source);
    const target = event.detail?.target;
    const declared = typeof target === "string";
    const to = declared ? nodeIdFor(target) : null;
    const blocked = event.outcome === "blocked" && declared && to !== null;
    steps.push(step({
      index: steps.length,
      eventId: event.event_id,
      kind: from === null && to === null ? "banner" : from !== null && to !== null ? "move" : "self",
      from,
      to,
      label: event.title ?? "",
      message: event.message,
      outcome: event.outcome,
      phase,
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
var REPLAY_NODES = [
  { id: "human-user", label: "\u5229\u7528\u8005", role: "\u6307\u793A\u3059\u308B\u4EBA", x: 80, y: 60 },
  { id: "automation-app", label: "Automation App", role: "\u753B\u9762\u3068\u8A18\u9332", x: 260, y: 60 },
  { id: "authorization-platform", label: "Authorization Platform", role: "\u6A29\u9650\u3092\u6C7A\u3081\u308B", x: 440, y: 60 },
  { id: "agent-provisioner", label: "Agent Provisioner", role: "Agent \u3092\u4F5C\u308B", x: 620, y: 60 },
  { id: "agent-op", label: "Agent OP", role: "\u8EAB\u5143\u3092\u767A\u884C\u3059\u308B", x: 80, y: 220 },
  { id: "agent-runtime", label: "Agent Runtime", role: "Agent \u304C\u52D5\u304F\u5834\u6240", x: 260, y: 220 },
  { id: "resource-as", label: "Resource AS", role: "Access Token \u3092\u51FA\u3059", x: 440, y: 220 },
  { id: "resource-api", label: "Resource API", role: "\u30C7\u30FC\u30BF\u3092\u6301\u3064", x: 620, y: 220 }
];
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
var LABEL_OFFSET = 9;
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
    lightBoxes(root, current);
    if (current.kind === "banner") {
      if (banner) banner.textContent = current.message;
    } else if (current.kind === "self") {
      drawPulse(root, current);
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
    writeCaption(root, current, plan.length);
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
      emptyOut(root.querySelector("[data-labels]"));
      emptyOut(root.querySelector("[data-dots]"));
      emptyOut(messages);
      if (banner) banner.textContent = "";
      resetNodes(root);
      clearCaption(root);
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
    node.setAttribute("data-active", "");
  });
}
function lightBoxes(root, step2) {
  root.querySelectorAll("[data-node]").forEach((node) => {
    const id = node.getAttribute("data-node");
    const role = id !== null && id === step2.from ? step2.kind === "self" ? "self" : "from" : id !== null && id === step2.to ? "to" : "";
    node.setAttribute("data-active", role);
  });
}
function writeCaption(root, step2, total) {
  const caption = root.querySelector("[data-caption]");
  if (!caption) return;
  caption.setAttribute("data-caption-state", step2.blocked ? "blocked" : "playing");
  caption.setAttribute("data-caption-emphasis", emphasisClass(step2.outcome, step2.phase));
  const set = (field, text) => {
    const target = caption.querySelector(`[data-field="${field}"]`);
    if (target) target.textContent = text;
  };
  set("caption-step", `${step2.index + 1} / ${total}`);
  set("caption-route", routeOf(step2));
  set("caption-label", step2.label);
  set("caption-message", step2.message);
}
function clearCaption(root) {
  const caption = root.querySelector("[data-caption]");
  if (!caption) return;
  caption.setAttribute("data-caption-state", "idle");
  caption.setAttribute("data-caption-emphasis", "");
  for (const field of ["caption-step", "caption-route", "caption-label", "caption-message"]) {
    const target = caption.querySelector(`[data-field="${field}"]`);
    if (target) target.textContent = "";
  }
}
function routeOf(step2) {
  const from = step2.from === null ? "" : boxLabel(step2.from);
  const to = step2.to === null ? "" : boxLabel(step2.to);
  if (step2.kind === "move") return `${from} \u2192 ${to}`;
  return from || to;
}
function boxLabel(id) {
  return REPLAY_NODES.find((node) => node.id === id)?.label ?? id;
}
function drawPulse(root, step2) {
  const at = step2.from === null ? step2.to === null ? null : centreOf(root, step2.to) : centreOf(root, step2.from);
  const dots = root.querySelector("[data-dots]") ?? root.querySelector("[data-arrows]");
  if (!at || !dots) return;
  const ring = root.ownerDocument.createElementNS(SVG_NS, "rect");
  ring.setAttribute("class", "replay-pulse");
  ring.setAttribute("data-pulse", "true");
  ring.setAttribute("data-step-index", String(step2.index));
  ring.setAttribute("data-pulse-emphasis", emphasisClass(step2.outcome, step2.phase));
  ring.setAttribute("x", String(at.x - NODE_HALF_WIDTH - 4));
  ring.setAttribute("y", String(at.y - NODE_HALF_HEIGHT - 4));
  ring.setAttribute("width", String(NODE_HALF_WIDTH * 2 + 8));
  ring.setAttribute("height", String(NODE_HALF_HEIGHT * 2 + 8));
  ring.setAttribute("rx", "9");
  ring.style.setProperty("--step-ms", `${REPLAY_STEP_MS}ms`);
  dots.appendChild(ring);
  const box = step2.from === null ? null : root.querySelector(`[data-node="${step2.from}"]`);
  if (box) box.setAttribute("data-reached", "true");
}
function drawArrow(root, step2) {
  const arrows = root.querySelector("[data-arrows]");
  const start2 = step2.from === null ? null : centreOf(root, step2.from);
  const finish = step2.to === null ? null : centreOf(root, step2.to);
  if (!arrows || !start2 || !finish) return;
  const dots = root.querySelector("[data-dots]") ?? arrows;
  const labels = root.querySelector("[data-labels]") ?? dots;
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
  if (step2.label !== "") labels.appendChild(arrowLabel(document_, step2, start2, pointAt(start2, stop, stopRatio), emphasis));
  const target = step2.to === null ? null : root.querySelector(`[data-node="${step2.to}"]`);
  if (target) target.setAttribute("data-reached", step2.blocked ? "false" : "true");
}
function arrowLabel(document_, step2, start2, stop, emphasis) {
  const middle = pointAt(start2, stop, 0.5);
  const forward = stop.x > start2.x || stop.x === start2.x && stop.y > start2.y;
  const vertical = Math.abs(stop.x - start2.x) < Math.abs(stop.y - start2.y);
  const label = document_.createElementNS(SVG_NS, "text");
  label.setAttribute("class", "replay-arrow-label");
  label.setAttribute("data-arrow-label", "true");
  label.setAttribute("data-step-index", String(step2.index));
  label.setAttribute("data-label-emphasis", emphasis);
  label.setAttribute("text-anchor", vertical ? forward ? "start" : "end" : "middle");
  label.setAttribute("x", String(vertical ? middle.x + (forward ? LABEL_OFFSET : -LABEL_OFFSET) : middle.x));
  label.setAttribute("y", String(vertical ? middle.y : middle.y + (forward ? -LABEL_OFFSET : LABEL_OFFSET + 6)));
  label.textContent = step2.label;
  return label;
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
function showLocalTimes(root) {
  for (const element of Array.from(root.querySelectorAll("[datetime]"))) {
    const recorded = element.getAttribute("datetime") ?? "";
    const millis = Date.parse(recorded);
    if (!Number.isFinite(millis)) continue;
    try {
      element.setAttribute("title", recorded);
      element.textContent = new Intl.DateTimeFormat("ja-JP", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).format(new Date(millis));
    } catch {
    }
  }
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
      const key = `${task.run_id}:${task.task_id}`;
      if (!Array.isArray(task.events) || wired.has(key)) continue;
      const canvas = root.querySelector(`[data-replay-key="${key}"]`);
      if (!canvas) continue;
      wired.add(key);
      const log = root.querySelector(`[data-log-key="${key}"]`);
      const events = task.events;
      const begin = (autoplay) => {
        const controller = playReplay(canvas, events, { log, autoplay });
        controllers.set(key, controller);
        return controller;
      };
      canvas.addEventListener("click", (event) => {
        if (isControl(event.target)) return;
        begin(true);
      });
      wireControls(canvas, key, controllers, begin);
      wireRow(root, key, canvas, controllers, begin);
    }
    wireDetailToggles(root);
    showLocalTimes(root);
  };
  void load();
  root.querySelector('[data-action="refresh"]')?.addEventListener("click", () => {
    void load();
  });
}
function isControl(target) {
  return target instanceof Element && target.closest("[data-replay-controls]") !== null;
}
function wireControls(canvas, key, controllers, begin) {
  const on = (action, run) => {
    canvas.querySelector(`[data-action="${action}"]`)?.addEventListener("click", () => {
      run(controllers.get(key));
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
function wireRow(root, key, canvas, controllers, begin) {
  root.querySelectorAll(`[data-task-key="${key}"]`).forEach((row) => {
    if (row.hasAttribute("disabled")) return;
    row.addEventListener("click", () => {
      canvas.scrollIntoView?.({ behavior: "smooth", block: "start" });
      const controller = controllers.get(key);
      if (!controller) {
        begin(true);
        return;
      }
      if (canvas.getAttribute("data-replay-state") === "finished") controller.restart();
      else controller.play();
    });
  });
}
if (typeof document !== "undefined") start();
export {
  start
};
