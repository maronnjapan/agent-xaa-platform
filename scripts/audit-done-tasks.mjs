#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const taskRoot = 'tasks/done';
const files = readdirSync(taskRoot).filter((name) => name.endsWith('.md')).sort();
const repoPath = /^(?:\.github|apps|demo-scenarios|docs|e2e|generated-baseline|infra|packages|scripts|security-rules|tests)\//;

const report = {
  taskCount: 0,
  uncheckedCompletionConditions: 0,
  countMismatches: [],
  missingArtifacts: [],
};

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
    const artifacts = task.match(/\*\*成果物\*\*([\s\S]*?)(?=\n\*\*実装方針\*\*|\n\*\*完了条件\*\*)/)?.[1] ?? '';
    for (const line of artifacts.split('\n')) {
      // "x は作らず y" deliberately names an absent path. The positive artifact is
      // still checked when it appears on a separate line.
      if (line.includes('は作らず')) continue;
      for (const match of line.matchAll(/`([^`]+)`/g)) {
        const artifact = match[1].replace(/（.*$/, '').replace(/\/$/, '');
        if (!repoPath.test(artifact) || /[<>{}*$]/.test(artifact)) continue;
        if (!existsSync(artifact)) report.missingArtifacts.push({ file: name, task: id, artifact });
      }
    }
  }
}

const ok = report.countMismatches.length === 0
  && report.missingArtifacts.length === 0
  && report.uncheckedCompletionConditions === 0;

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ ok, ...report }, null, 2)}\n`);
} else {
  process.stdout.write(`done audit: ${report.taskCount} tasks\n`);
  process.stdout.write(`unchecked completion conditions: ${report.uncheckedCompletionConditions}\n`);
  process.stdout.write(`task-count mismatches: ${report.countMismatches.length}\n`);
  for (const mismatch of report.countMismatches) {
    process.stdout.write(`  ${mismatch.file}: declared ${mismatch.declared}, actual ${mismatch.actual}\n`);
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
