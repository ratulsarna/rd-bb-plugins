// Asks an assistant thread each question as a turn through bb and scores the answers.
// A question passes when each `must` group has one of its strings in the answer.
//   node scripts/eval.ts <thread id> <questions.json> [report.md]
// questions.json: [{ "q": "...", "must": [["a", "b"], ["c"]] }]
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const [thread, file, reportFile] = process.argv.slice(2);
if (!thread || !file) throw new Error("usage: node scripts/eval.ts <thread id> <questions.json> [report.md]");
const questions: { q: string; must: string[][] }[] = JSON.parse(fs.readFileSync(file, "utf8"));
// Run from inside a bb thread, the caller's thread context would make each question a message from that
// thread, and the agent would answer it there with `bb thread tell`: the questions must be plain user turns.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^BB_(THREAD_|ENVIRONMENT_ID$)/.test(k)));
const bb = (...args: string[]) => execFileSync(process.env.BB_CLI ?? "bb", args, { encoding: "utf8", env });

const rows = ["| # | pass | question | answer |", "|---|---|---|---|"];
let passed = 0;
for (const [k, { q, must }] of questions.entries()) {
  bb("thread", "tell", thread, q);
  // The turn may not have started yet when tell returns.
  try {
    bb("thread", "wait", thread, "--status", "active", "--timeout", "30s");
  } catch {}
  bb("thread", "wait", thread, "--status", "idle", "--timeout", "20m");
  const answer = JSON.parse(bb("thread", "output", thread, "--json")).output as string;
  const ok = must.every((group) => group.some((s) => answer.toLowerCase().includes(s.toLowerCase())));
  if (ok) passed++;
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ");
  rows.push(`| ${k + 1} | ${ok ? "yes" : "no"} | ${cell(q)} | ${cell(answer)} |`);
  console.log(`${k + 1}. ${ok ? "PASS" : "FAIL"} ${q}\n   ${cell(answer).slice(0, 400)}`);
}
const report = `score ${passed}/${questions.length}\n\n${rows.join("\n")}\n`;
if (reportFile) fs.writeFileSync(reportFile, report);
console.log(`\nscore ${passed}/${questions.length}`);
