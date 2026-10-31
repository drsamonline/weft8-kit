/* test-node.js — the proof for weft8-kit.
 *
 * A kit is only worth using if its guarantees are real, so this asserts them:
 * every rule answers its own cases, a rule cannot run away, a rule cannot reach
 * anything but its ports, and the API is the one the README documents.
 *
 * SPDX-FileCopyrightText: 2026 Dr Sohil Momin
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
"use strict";

const W = require("./docs/play/weft8.js");
const Rules = require("./docs/play/rules.js");

let pass = 0;
const failures = [];
const ok = (c, n) => { if (c) { pass++; return; } failures.push(n); console.log("  FAIL  " + n); };
const eq = (g, w, n) => ok(JSON.stringify(g) === JSON.stringify(w),
  n + "  (got " + JSON.stringify(g) + ", want " + JSON.stringify(w) + ")");

console.log("the kit — the machine it carries");
eq(Object.keys(W.OPCODES).length, 27, "the Weft-8 still has 27 opcodes");
ok(typeof W.assemble === "function" && typeof W.VM === "function", "assemble and VM are exported");
eq(W.PORT.IN0, 0xD0, "the kit's input ports are at 0xD0 and up, clear of the Loom's 0xC0-0xCA");
eq(W.PORT.VERDICT, 0xD7, "the verdict port is 0xD7");

console.log("the rules — every case, on the real machine");
Rules.RULES.forEach(function (rule) {
  const a = W.assemble(rule.source);
  eq(a.errors, [], rule.id + ": assembles");
  ok(a.all.length <= 128, rule.id + ": fits the 128-byte ROM (" + a.all.length + ")");
  ok(rule.cases.length >= 3, rule.id + ": ships at least three cases");
  ok(rule.why.length > 30, rule.id + ": says why it exists");
  rule.cases.forEach(function (c, i) {
    const r = Rules.evaluate(rule, c.in);
    eq(r.errors, [], rule.id + " case " + (i + 1) + ": no assemble errors");
    eq(r.verdict, c.verdict, rule.id + " case " + (i + 1) + " " + JSON.stringify(c.in) +
       " -> " + Rules.VERDICT_WORD[c.verdict]);
    ok(r.halted, rule.id + " case " + (i + 1) + ": reaches HLT");
    ok(r.steps < 200, rule.id + " case " + (i + 1) + ": decides in under 200 steps (" + r.steps + ")");
  });
});

console.log("the guarantees — a rule cannot run away, and cannot touch anything else");
{
  const runaway = { source: "loop: JMP loop", cases: [] };
  const r = Rules.evaluate(runaway, [0], 500);
  eq(r.verdict, null, "a runaway rule writes no verdict");
  ok(/step limit/.test(r.error), "and the machine says it hit the step limit: " + r.error);
  eq(r.steps, 500, "after exactly the steps it was allowed");
}
{
  /* the machine has no instructions that reach the network, the DOM or storage:
   * the opcode list IS the permission list, so this is checkable. */
  const ops = Object.keys(W.OPCODES);
  const dangerous = ops.filter(o => /NET|FETCH|DOM|FILE|EVAL|SYS/i.test(o));
  eq(dangerous, [], "no opcode reaches the network, the filesystem or the DOM");
  eq(ops.length, 27, "27 opcodes, all of them arithmetic, memory, flow or ports");
}
{
  const r = Rules.evaluate(Rules.ruleById("ceiling"), [120, 100]);
  eq(r.verdict, Rules.STOP, "the ceiling rule stops on 120 against a ceiling of 100");
  eq(r.writes, [2], "and it wrote the verdict exactly once");
}
{
  /* THE LIMIT, pinned rather than hidden: JG/JL compare SIGNED bytes, so 200 is
   * -56 to this machine. A rule whose inputs can exceed 127 must say so — this
   * test exists so nobody discovers it in production. */
  const r = Rules.evaluate(Rules.ruleById("ceiling"), [200, 100]);
  eq(r.verdict, Rules.PASS, "200 against 100 does NOT stop, because 200 is -56 signed — the documented limit");
  ok(/127/.test(Rules.ruleById("ceiling").why), "and the rule says so in its own words");
}

console.log("the rules bite — change the comparison and the cases fail");
{
  const rule = Rules.ruleById("follow-up-due");
  const broken = { source: rule.source.replace("JL  notyet", "JG  notyet") };
  const r = Rules.evaluate(broken, [45, 30]);
  eq(r.verdict, Rules.PASS, "with the branch flipped, 45 days against 30 is no longer due — so the case really tests the comparison");
}
{
  const rule = Rules.ruleById("record-complete");
  const broken = { source: rule.source.replace("JZ  flag             ; labs missing", "NOP") };
  const r = Rules.evaluate(broken, [1, 0]);
  eq(r.verdict, Rules.PASS, "with the second check removed, a record with no labs passes — so the case really tests it");
}

console.log("the API — what the README promises");
ok(Array.isArray(Rules.RULES) && Rules.RULES.length === 4, "four example rules ship");
ok(typeof Rules.ruleById === "function" && Rules.ruleById("ceiling").id === "ceiling", "ruleById finds a rule");
ok(Rules.ruleById("nope") === null, "and returns null for one that does not exist");
eq([Rules.PASS, Rules.FLAG, Rules.STOP], [0, 1, 2], "the verdict codes are 0 pass, 1 flag, 2 stop");

console.log("");
console.log(pass + " passed, " + failures.length + " failed");
if (failures.length) { failures.forEach(f => console.log("  - " + f)); process.exit(1); }
