/* tests/page-smoke.js — the bench, driven. jsdom is a test-only dependency.
 * SPDX-FileCopyrightText: 2026 Dr Sohil Momin · PolyForm-Noncommercial-1.0.0 */
"use strict";
const fs = require("fs"), path = require("path");
let JSDOM;
try { ({ JSDOM } = require("jsdom")); } catch (e) { console.log("jsdom missing — npm install"); process.exit(2); }
const dir = path.join(__dirname, "..", "docs", "play");
let html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
for (const k of ["web-kit.js", "weft8.js", "rules.js"])
  html = html.replace('<script src="' + k + '"></script>', "<script>" + fs.readFileSync(path.join(dir, k), "utf8") + "</script>");
const errors = [];
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true,
  beforeParse(w) { w.addEventListener("error", (e) => errors.push(e.message)); } });
const w = dom.window, d = w.document;
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "  [" + x + "]" : "")); } };
const click = (id) => d.getElementById(id).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const t = (id) => d.getElementById(id).textContent;

ok("the page boots without an error", errors.length === 0, errors.join("; "));
ok("four rules are listed", d.querySelectorAll("#rules button").length === 4);
ok("the shipped case is evaluated on load", t("word") !== "—", t("word"));
ok("the first rule flags its shipped case (notes written, labs missing)", t("word") === "flag", t("word"));
ok("the rule source is shown", /OUT VERDICT/.test(t("src")));

/* move a slider: labs attached 0 -> 1, the verdict flips */
const ranges = d.querySelectorAll("#inputs input[type=range]");
ranges[1].value = "1";
ranges[1].dispatchEvent(new w.Event("input", { bubbles: true }));
click("eval");
ok("adding the missing input flips the verdict to pass", t("word") === "pass", t("word"));

/* the third rule: two red flags */
d.querySelectorAll("#rules button")[2].dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
ok("switching rules swaps the source", /two or more|stop when flags/i.test(t("src")), t("src").slice(0, 60));
click("eval");
ok("the red-flag rule stops on its shipped case", t("word") === "stop", t("word"));
ok("and the verdict box is styled as a stop", /stop/.test(d.getElementById("verdict").className), d.getElementById("verdict").className);

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
