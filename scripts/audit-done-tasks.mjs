#!/usr/bin/env node
// Audits tasks/done: every completion condition must be either verified in the
// repository (`- [x]`) or observable only on a live GCP project (`- [~]`, naming the
// script that observes it after deploy), and every declared artifact path must exist
// or be resolved through tasks/artifact-map.json (00b-conventions §5).
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const taskRoot = 'tasks/done';
const files = readdirSync(taskRoot).filter((name) => name.endsWith('.md')).sort();
const repoPath = /^(?:\.github|apps|demo-scenarios|docs|e2e|generated-baseline|infra|packages|scripts|security-rules|tests)\//;
// A live-only condition has to say which repository script observes it after deploy.
const observerPath = /`((?:infra\/tests|scripts)\/[^`\s（）]+)`/g;

const artifactMap = JSON.parse(readFileSync('tasks/artifact-map.json', 'utf8'));

const report = {
  taskCount: 0,
  uncheckedCompletionConditions: 0,
  liveOnlyConditions: 0,
  liveConditionsWithoutObserver: [],
  countMismatches: [],
  missingArtifacts: [],
  mappedArtifacts: 0,
  staleMapEntries: [],
};

/** True when the map resolves `artifact` for `task` to files that all exist. */
function resolvedByMap(task, artifact) {
  const entry = artifactMap[task];
  if (!entry || !Array.isArray(entry.declared) || !entry.declared.includes(artifact)) return false;
  return Array.isArray(entry.owner) && entry.owner.length > 0 && entry.owner.every((owner) => existsSync(owner));
}

for (const name of files) {
  const source = readFileSync(`${taskRoot}/${name}`, 'utf8');
  const tasks = [...source.matchAll(/^### (T-[A-Z]+-\d+)\b/gm)].map((match) => match[1]);
  const declared = Number(source.match(/\| このファイルのタスク数 \| (\d+)件 \|/)?.[1]);
  report.taskCount += tasks.length;
  report.uncheckedCompletionConditions += (source.match(/^- \[ \]/gm) ?? []).length;
  if (declared !== tasks.length) report.countMismatches.push({ file: name, declared, actual: tasks.length });

  for (const task of source.split(/^### /m).slice(1)) {
    const id = task.match(/^(T-[A-Z]+-\d+)\b/)?.[1];
    if (!id) continue;

    for (const line of task.split('\n')) {
      if (!line.startsWith('- [~]')) continue;
      report.liveOnlyConditions += 1;
      const observers = [...line.matchAll(observerPath)].map((match) => match[1]);
      if (observers.length === 0 || !observers.every((path) => existsSync(path))) {
        report.liveConditionsWithoutObserver.push({ file: name, task: id, line: line.slice(0, 120) });
      }
    }

    const artifacts = task.match(/\*\*成果物\*\*([\s\S]*?)(?=\n\*\*実装方針\*\*|\n\*\*完了条件\*\*)/)?.[1] ?? '';
    for (const line of artifacts.split('\n')) {
      // "x は作らず y" deliberately names an absent path. The positive artifact is
      // still checked when it appears on a separate line.
      if (line.includes('は作らず')) continue;
      for (const match of line.matchAll(/`([^`]+)`/g)) {
        const artifact = match[1].replace(/（.*$/, '').replace(/\/$/, '');
        if (!repoPath.test(artifact) || /[<>{}*$]/.test(artifact)) continue;
        if (existsSync(artifact)) continue;
        if (resolvedByMap(id, artifact)) { report.mappedArtifacts += 1; continue; }
        report.missingArtifacts.push({ file: name, task: id, artifact });
      }
    }
  }
}

// A map entry whose declared path exists again, or whose owner is gone, is stale: the
// map must describe the repository as it is, not as it once was.
for (const [task, entry] of Object.entries(artifactMap)) {
  if (task.startsWith('$')) continue;
  for (const path of entry.declared ?? []) {
    if (existsSync(path)) report.staleMapEntries.push({ task, path, reason: 'declared path exists' });
  }
  for (const path of entry.owner ?? []) {
    if (!existsSync(path)) report.staleMapEntries.push({ task, path, reason: 'owner missing' });
  }
}

const ok = report.countMismatches.length === 0
  && report.missingArtifacts.length === 0
  && report.uncheckedCompletionConditions === 0
  && report.liveConditionsWithoutObserver.length === 0
  && report.staleMapEntries.length === 0;

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ ok, ...report }, null, 2)}\n`);
} else {
  process.stdout.write(`done audit: ${report.taskCount} tasks\n`);
  process.stdout.write(`unchecked completion conditions: ${report.uncheckedCompletionConditions}\n`);
  process.stdout.write(`live-only conditions (observed after deploy by the named script): ${report.liveOnlyConditions}\n`);
  process.stdout.write(`live-only conditions without an existing observer script: ${report.liveConditionsWithoutObserver.length}\n`);
  for (const entry of report.liveConditionsWithoutObserver.slice(0, 40)) {
    process.stdout.write(`  ${entry.task}: ${entry.line}\n`);
  }
  process.stdout.write(`task-count mismatches: ${report.countMismatches.length}\n`);
  for (const mismatch of report.countMismatches) {
    process.stdout.write(`  ${mismatch.file}: declared ${mismatch.declared}, actual ${mismatch.actual}\n`);
  }
  process.stdout.write(`artifacts resolved through tasks/artifact-map.json: ${report.mappedArtifacts}\n`);
  process.stdout.write(`stale artifact-map entries: ${report.staleMapEntries.length}\n`);
  for (const entry of report.staleMapEntries.slice(0, 40)) {
    process.stdout.write(`  ${entry.task}: ${entry.path} (${entry.reason})\n`);
  }
  process.stdout.write(`missing named artifacts: ${report.missingArtifacts.length}\n`);
  for (const entry of report.missingArtifacts.slice(0, 40)) {
    process.stdout.write(`  ${entry.task}: ${entry.artifact}\n`);
  }
  if (report.missingArtifacts.length > 40) {
    process.stdout.write(`  ... ${report.missingArtifacts.length - 40} more (use --json)\n`);
  }
}

process.exitCode = ok ? 0 : 1;
