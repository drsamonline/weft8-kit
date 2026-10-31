/* rules.js — the rule engine layer of weft8-kit.
 *
 * A rule is a Weft-8 program with a contract: the caller puts inputs in the IN
 * ports, the program writes a verdict to the VERDICT port, and everything else is
 * the machine's business. That is the whole idea — a rule small enough to read,
 * sign off, diff and re-check, running on a step-limited machine that cannot
 * reach the network, the filesystem or the DOM.
 *
 * Ports (added to the Loom's own table; they sit at 0xD0+, clear of 0xC0-0xCA):
 *   0xD0 IN0   0xD1 IN1   0xD2 IN2   0xD3 IN3     the rule's inputs, 0-255
 *   0xD7 VERDICT                                  0 pass · 1 flag · 2 stop
 *
 * SPDX-FileCopyrightText: 2026 Dr Sohil Momin
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./weft8.js"));
  else root.Rules = factory(root.Weft8);
})(typeof self !== "undefined" ? self : this, function (Weft8) {
  "use strict";

  Object.assign(Weft8.PORT, { IN0: 0xD0, IN1: 0xD1, IN2: 0xD2, IN3: 0xD3, VERDICT: 0xD7 });

  var PASS = 0, FLAG = 1, STOP = 2;
  var VERDICT_WORD = { 0: "pass", 1: "flag", 2: "stop" };

  /* ---------------------------------------------------------------- the rules
   * These are EXAMPLES of the pattern, not clinical guidance. They are here to
   * show that a rule can be short, readable and provable; the numbers in them are
   * illustrations.
   */
  var RULES = [
    {
      id: "record-complete",
      title: "Is the record complete?",
      question: "Are both fields filled in?",
      why: "The simplest possible rule: two inputs, one comparison each. Read it in ten seconds and you have read the whole rule.",
      inputs: [
        { name: "IN0", label: "notes written (0/1)", min: 0, max: 1, value: 1 },
        { name: "IN1", label: "labs attached (0/1)", min: 0, max: 1, value: 0 }
      ],
      source: [
        "; pass only when both inputs are non-zero",
        "        IN  IN0",
        "        JZ  flag             ; notes missing",
        "        IN  IN1",
        "        JZ  flag             ; labs missing",
        "        LDI 0                ; 0 = pass",
        "        OUT VERDICT",
        "        HLT",
        "flag:   LDI 1                ; 1 = flag",
        "        OUT VERDICT",
        "        HLT"
      ].join("\n"),
      cases: [
        { in: [1, 1], verdict: PASS },
        { in: [0, 1], verdict: FLAG },
        { in: [1, 0], verdict: FLAG },
        { in: [0, 0], verdict: FLAG }
      ]
    },
    {
      id: "follow-up-due",
      title: "Is the follow-up due?",
      question: "Has it been longer than the agreed interval?",
      why: "A comparison with a threshold that is itself an input — so the interval is data, not a number baked into the code.",
      inputs: [
        { name: "IN0", label: "days since last visit", min: 0, max: 120, value: 45 },
        { name: "IN1", label: "agreed interval (days)", min: 0, max: 120, value: 30 }
      ],
      source: [
        "; flag when days_since >= interval",
        "        IN  IN0              ; days since",
        "        MOV R1, R0",
        "        IN  IN1              ; interval",
        "        MOV R2, R0",
        "        CMP R1, R2           ; R1 - R2",
        "        JL  notyet           ; days < interval -> not due",
        "        LDI 1",
        "        OUT VERDICT",
        "        HLT",
        "notyet: LDI 0",
        "        OUT VERDICT",
        "        HLT"
      ].join("\n"),
      cases: [
        { in: [45, 30], verdict: FLAG },
        { in: [30, 30], verdict: FLAG },
        { in: [29, 30], verdict: PASS },
        { in: [0, 0], verdict: FLAG }
      ]
    },
    {
      id: "two-red-flags",
      title: "Two red flags, high severity",
      question: "Two or more flags, and severity at least 7?",
      why: "A rule with an 'and' in it — which the machine has no instruction for, so it is two comparisons and two branches. That is what 'and' costs.",
      inputs: [
        { name: "IN0", label: "red flags counted", min: 0, max: 9, value: 2 },
        { name: "IN1", label: "severity (0-9)", min: 0, max: 9, value: 8 }
      ],
      source: [
        "; stop when flags >= 2 AND severity >= 7",
        "        IN  IN0",
        "        MOV R1, R0",
        "        LDI 2",
        "        MOV R2, R0",
        "        CMP R1, R2",
        "        JL  fine             ; fewer than two flags",
        "        IN  IN1",
        "        MOV R1, R0",
        "        LDI 7",
        "        MOV R2, R0",
        "        CMP R1, R2",
        "        JL  fine             ; severity below seven",
        "        LDI 2                ; 2 = stop",
        "        OUT VERDICT",
        "        HLT",
        "fine:   LDI 0",
        "        OUT VERDICT",
        "        HLT"
      ].join("\n"),
      cases: [
        { in: [2, 8], verdict: STOP },
        { in: [3, 7], verdict: STOP },
        { in: [2, 6], verdict: PASS },
        { in: [1, 9], verdict: PASS }
      ]
    },
    {
      id: "ceiling",
      title: "Over a ceiling?",
      question: "Is the value above the ceiling you set?",
      why: "The pattern a dose or a budget check uses: one number against another, with the ceiling as an input so it can be changed without touching the code. Keep both numbers at 127 or below — the machine compares SIGNED bytes, so 200 would be read as -56.",
      inputs: [
        { name: "IN0", label: "value (0-127)", min: 0, max: 127, value: 120 },
        { name: "IN1", label: "ceiling (0-127)", min: 0, max: 127, value: 100 }
      ],
      source: [
        "; stop when value > ceiling",
        "        IN  IN0",
        "        MOV R1, R0",
        "        IN  IN1",
        "        MOV R2, R0",
        "        CMP R1, R2",
        "        JG  over             ; signed greater",
        "        LDI 0",
        "        OUT VERDICT",
        "        HLT",
        "over:   LDI 2",
        "        OUT VERDICT",
        "        HLT"
      ].join("\n"),
      cases: [
        { in: [120, 100], verdict: STOP },
        { in: [100, 100], verdict: PASS },
        { in: [99, 100], verdict: PASS },
        { in: [127, 127], verdict: PASS }
      ]
    }
  ];

  function ruleById(id) {
    for (var i = 0; i < RULES.length; i++) if (RULES[i].id === id) return RULES[i];
    return null;
  }

  /* evaluate(rule, values) — values is an array of up to four numbers */
  function evaluate(rule, values, maxSteps) {
    var a = Weft8.assemble(rule.source);
    if (a.errors.length) return { errors: a.errors, verdict: null, word: "does not assemble" };

    var verdict = null;
    var writes = [];
    var host = {
      output: writes,
      "in": function (port, name) {
        if (name === "IN0") return values[0] & 0xFF;
        if (name === "IN1") return values[1] & 0xFF;
        if (name === "IN2") return (values[2] || 0) & 0xFF;
        if (name === "IN3") return (values[3] || 0) & 0xFF;
        return 0;
      },
      out: function (port, value, name) {
        if (name === "VERDICT") { verdict = value; writes.push(value); }
      }
    };
    var vm = new Weft8.VM({ rom: a.bytes, peripherals: host });
    vm.run(maxSteps === undefined ? 2000 : maxSteps);

    return {
      errors: [], verdict: verdict, word: verdict === null ? "no verdict written" : VERDICT_WORD[verdict],
      steps: vm.steps, halted: vm.halted, error: vm.error, bytes: a.all,
      writes: writes
    };
  }

  return {
    RULES: RULES, ruleById: ruleById, evaluate: evaluate,
    PASS: PASS, FLAG: FLAG, STOP: STOP, VERDICT_WORD: VERDICT_WORD
  };
});
