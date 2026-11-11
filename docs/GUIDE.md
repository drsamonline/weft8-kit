# weft8-kit — a rule engine small enough to sign off

**Version 1.0.0 · PolyForm Noncommercial 1.0.0 · 0 runtime dependencies**

A rules engine built on the Weft-8 machine, for the kind of rule a person has to be able to read
before trusting it.

Open the bench: <https://drsamonline.github.io/weft8-kit/>

## Why a rule engine at all

Three properties a rules engine in a general-purpose language struggles to promise:

- **Readable** — a rule is twenty lines you can read aloud. No callbacks, no hidden state, no library
  deciding what "and" means.
- **Bounded** — 27 opcodes, none of which touch a file, a network or a page, and a step limit. A
  runaway rule stops and says so.
- **Provable** — every rule ships its cases, and the suite runs them on the real machine, including a
  case where the comparison is deliberately flipped to prove the test bites.

## The five example rules

| Rule | Question | What it shows |
|---|---|---|
| `record-complete` | are both fields filled in? | two inputs, one comparison each — the smallest possible rule |
| `follow-up-due` | has it been longer than the agreed interval? | a threshold that is an **input**, not a number baked into code |
| `two-red-flags` | two or more flags, and severity ≥ 7? | what an "and" costs when the machine has no `and` branch |
| `ceiling` | is the value above the ceiling you set? | the pattern a dose or budget check uses |
| `two-of-three` | are two of the three fields present? | counting is not an instruction — you add one per input and compare |

> These are **examples of the pattern, not clinical guidance.** The numbers in them are illustrations.

## The limits, stated

- The machine compares **signed** bytes, so an input above 127 reads as negative. The `ceiling` rule
  says so in its own words, and a test pins that behaviour rather than hiding it.
- Five rules is a demonstration, not a library. Adopting the kit means writing and checking your own.

## Adopting it

`docs/play/weft8.js` is the Weft-8 from [Jacquard](https://github.com/drsamonline/app-jacquard) — byte
for byte the same engine its 102 assertions cover. This kit adds one file on top: `rules.js`, the port
contract and the rule set. Copy both, write your rules, and run the suite.

## Licence

PolyForm Noncommercial 1.0.0. See [LICENSE](../LICENSE).
