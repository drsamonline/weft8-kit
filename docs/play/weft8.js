/* weft8.js — the Weft-8: an 8-bit assembler and VM for Jacquard.
 *
 * SPDX-FileCopyrightText: 2026 Dr Sohil Momin
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * The machine is deliberately small and completely described here: 16 eight-bit
 * registers (R0 is the accumulator), a FLAGS register (Z C N V), 256 bytes of
 * address space, and fixed TWO-BYTE instructions.
 *
 *   byte 0 = opcode          byte 1 = operand
 *   (little-endian: the opcode is the low byte, the operand the high byte)
 *
 * The operand byte is either an 8-bit value/address/port (LDI, LOAD, STORE, IN,
 * OUT, JMP, JZ, JNZ, JG, JL, CALL) or a pair of 4-bit register numbers
 * (a << 4 | b) for MOV, ADD, SUB, AND, OR, XOR and CMP, or one register number
 * in the high nibble (a << 4) for the unary ops NOT, SHL, SHR, RAND, PUSH, POP.
 *
 * Memory map
 *   0x00-0x7F  program ROM (128 bytes)
 *   0x80-0xBF  scratch RAM (64 bytes)
 *   0xC0-0xFF  peripherals, reached with IN/OUT (and with LOAD/STORE)
 *
 * Nothing here touches the network, the DOM or storage. The peripherals are host
 * callbacks, so the whole machine is testable with no browser.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Weft8 = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var OPCODES = {
    LDI: 0x00, MOV: 0x01, LOAD: 0x02, STORE: 0x03, ADD: 0x04, SUB: 0x05,
    AND: 0x06, OR: 0x07, XOR: 0x08, NOT: 0x09, SHL: 0x0A, SHR: 0x0B,
    CMP: 0x0C, JMP: 0x0D, JZ: 0x0E, JNZ: 0x0F, JG: 0x10, JL: 0x11,
    CALL: 0x12, RET: 0x13, PUSH: 0x14, POP: 0x15, IN: 0x16, OUT: 0x17,
    RAND: 0x18, NOP: 0x19, HLT: 0x1A
  };

  var NAMES = {};
  Object.keys(OPCODES).forEach(function (k) { NAMES[OPCODES[k]] = k; });

  /* Operand shape per opcode: "imm" = 8-bit value/address/port, "rr" = two
   * registers, "r" = one register, "none" = no operand. */
  var SHAPE = {
    LDI: "imm", MOV: "rr", LOAD: "imm", STORE: "imm", ADD: "rr", SUB: "rr",
    AND: "rr", OR: "rr", XOR: "rr", NOT: "r", SHL: "r", SHR: "r",
    CMP: "rr", JMP: "imm", JZ: "imm", JNZ: "imm", JG: "imm", JL: "imm",
    CALL: "imm", RET: "none", PUSH: "r", POP: "r", IN: "imm", OUT: "imm",
    RAND: "r", NOP: "none", HLT: "none"
  };

  var PORT = {
    CLOCK: 0xC0, LAT: 0xC1, LON: 0xC2, OFFICE_INSIDE: 0xC3,
    NEXT_EVENT_MIN: 0xC4, NOTIFY: 0xC5, CLIPBOARD: 0xC6, ACCEL: 0xC7,
    RNG: 0xC8, AUDIO: 0xC9, HALT: 0xCA
  };

  var ROM_START = 0x00, ROM_END = 0x7F;
  var RAM_START = 0x80, RAM_END = 0xBF;
  var PERIPH_START = 0xC0;

  /* ---------------------------------------------------------------- assembler */

  function parseNumber(tok, symbols) {
    var t = String(tok).trim();
    if (Object.prototype.hasOwnProperty.call(symbols, t)) return symbols[t];
    if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
    if (/^\$[0-9a-f]+$/i.test(t)) return parseInt(t.slice(1), 16);
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^'(\\.|[^\\'])'$/.test(t)) {
      var ch = t.slice(1, -1);
      var map = { "\\n": 10, "\\t": 9, "\\0": 0, "\\\\": 92, "\\'": 39, '\\"': 34 };
      if (map[ch] !== undefined) return map[ch];
      return ch.charCodeAt(0);
    }
    if (Object.prototype.hasOwnProperty.call(PORT, t.toUpperCase())) return PORT[t.toUpperCase()];
    return null;
  }

  function parseRegister(tok) {
    var m = /^[Rr](\d{1,2})$/.exec(String(tok).trim());
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return n >= 0 && n <= 15 ? n : null;
  }

  function unquote(s) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c !== "\\") { out += c; continue; }
      var n = s[++i];
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "0") out += "\0";
      else if (n === "\\") out += "\\";
      else if (n === '"') out += '"';
      else out += n;
    }
    return out;
  }

  /* Split a line into [label, mnemonic, operandText]. */
  function parseLine(raw) {
    var line = raw;
    var comment = line.indexOf(";");
    if (comment >= 0) line = line.slice(0, comment);
    line = line.replace(/\s+$/, "");
    var label = null;
    var m = /^([A-Za-z_.][\w.]*):\s*/.exec(line);
    if (m) { label = m[1]; line = line.slice(m[0].length); }
    line = line.trim();
    if (!line) return { label: label, mnemonic: null, operand: "" };
    var sp = line.search(/\s/);
    var mn = sp < 0 ? line : line.slice(0, sp);
    var op = sp < 0 ? "" : line.slice(sp).trim();
    return { label: label, mnemonic: mn.toUpperCase(), operand: op };
  }

  /* assemble(src) -> {bytes, symbols, errors, listing}
   * Never throws on bad source: every problem lands in `errors` with its line. */
  function assemble(src) {
    var errors = [];
    var symbols = {};
    var listing = [];
    var lines = String(src == null ? "" : src).split(/\r?\n/);

    /* pass 1 — addresses */
    var addr = ROM_START;
    for (var i = 0; i < lines.length; i++) {
      var p = parseLine(lines[i]);
      if (p.label) {
        if (Object.prototype.hasOwnProperty.call(symbols, p.label)) {
          errors.push({ line: i + 1, message: "duplicate label '" + p.label + "'" });
        } else {
          symbols[p.label] = addr;
        }
      }
      if (!p.mnemonic) { listing.push({ line: i + 1, addr: addr, mnemonic: null }); continue; }
      if (p.mnemonic.charAt(0) === ".") {
        if (p.mnemonic === ".STR") {
          var s = /^"(.*)"$/.exec(p.operand);
          if (!s) { errors.push({ line: i + 1, message: ".str needs a quoted string" }); continue; }
          addr += unquote(s[1]).length;
        } else if (p.mnemonic === ".BYTE") {
          addr += p.operand.split(",").filter(function (x) { return x.trim(); }).length;
        } else {
          errors.push({ line: i + 1, message: "unknown directive '" + p.mnemonic + "'" });
        }
        listing.push({ line: i + 1, addr: addr, mnemonic: p.mnemonic });
        continue;
      }
      if (OPCODES[p.mnemonic] === undefined) {
        errors.push({ line: i + 1, message: "unknown instruction '" + p.mnemonic + "'" });
        continue;
      }
      listing.push({ line: i + 1, addr: addr, mnemonic: p.mnemonic, operand: p.operand });
      addr += 2;
    }

    if (addr - 1 > ROM_END) {
      errors.push({ line: 0, message: "program is " + (addr - ROM_START) + " bytes; program ROM is " + (ROM_END - ROM_START + 1) });
    }

    /* pass 2 — encode */
    var bytes = [];
    for (var j = 0; j < lines.length; j++) {
      var q = parseLine(lines[j]);
      if (!q.mnemonic) continue;

      if (q.mnemonic === ".STR") {
        var str = /^"(.*)"$/.exec(q.operand);
        if (!str) continue;
        unquote(str[1]).split("").forEach(function (ch) { bytes.push(ch.charCodeAt(0) & 0xFF); });
        continue;
      }
      if (q.mnemonic === ".BYTE") {
        q.operand.split(",").forEach(function (tok) {
          var v = parseNumber(tok, symbols);
          if (v === null || v < 0 || v > 255) {
            errors.push({ line: j + 1, message: ".byte value '" + tok.trim() + "' is not 0-255" });
            return;
          }
          bytes.push(v);
        });
        continue;
      }
      if (OPCODES[q.mnemonic] === undefined) continue;

      var opcode = OPCODES[q.mnemonic];
      var shape = SHAPE[q.mnemonic];
      var operand = 0;

      if (shape === "none") {
        if (q.operand) errors.push({ line: j + 1, message: q.mnemonic + " takes no operand" });
      } else if (shape === "imm") {
        var parts = q.operand.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
        if (parts.length !== 1) {
          errors.push({ line: j + 1, message: q.mnemonic + " takes exactly one operand" });
        } else {
          var v = parseNumber(parts[0], symbols);
          if (v === null) {
            errors.push({ line: j + 1, message: "undefined label or bad value '" + parts[0] + "'" });
          } else if (v < 0 || v > 255) {
            errors.push({ line: j + 1, message: q.mnemonic + " operand " + v + " is outside 0-255" });
          } else {
            operand = v;
          }
        }
      } else if (shape === "rr") {
        var pair = q.operand.split(",").map(function (x) { return x.trim(); });
        var ra = parseRegister(pair[0]), rb = parseRegister(pair[1]);
        if (pair.length !== 2 || ra === null || rb === null) {
          errors.push({ line: j + 1, message: q.mnemonic + " takes two registers, e.g. " + q.mnemonic + " R1, R2" });
        } else {
          operand = (ra << 4) | rb;
        }
      } else if (shape === "r") {
        var only = parseRegister(q.operand);
        if (only === null) {
          errors.push({ line: j + 1, message: q.mnemonic + " takes one register, e.g. " + q.mnemonic + " R3" });
        } else {
          operand = only << 4;
        }
      }
      bytes.push(opcode, operand);
    }

    return {
      bytes: new Uint8Array(bytes.slice(0, Math.max(0, ROM_END + 1))),
      all: bytes,
      symbols: symbols,
      errors: errors,
      listing: listing
    };
  }

  /* --------------------------------------------------------------------- VM */

  function VM(opts) {
    opts = opts || {};
    this.mem = new Uint8Array(256);
    this.rom = opts.rom || new Uint8Array(128);
    for (var i = 0; i < Math.min(128, this.rom.length); i++) this.mem[i] = this.rom[i];
    this.r = new Uint8Array(16);
    this.flags = { Z: false, C: false, N: false, V: false };
    this.pc = 0;
    this.stack = [];
    this.halted = false;
    this.steps = 0;
    this.error = null;
    this.log = [];
    this.peripherals = opts.peripherals || {};
    this.rand = opts.rand || defaultRand;
    this.mem[PERIPH_START] = 0; // peripherals are served by callbacks, not by mem
  }

  function defaultRand() { return Math.floor(Math.random() * 256); }

  VM.prototype.read = function (addr) {
    addr &= 0xFF;
    if (addr >= PERIPH_START) return this.portIn(addr);
    return this.mem[addr];
  };

  VM.prototype.write = function (addr, value) {
    addr &= 0xFF;
    value &= 0xFF;
    if (addr >= PERIPH_START) { this.portOut(addr, value); return; }
    if (addr <= ROM_END) { this.log.push("write to ROM 0x" + hex(addr) + " ignored"); return; }
    this.mem[addr] = value;
  };

  VM.prototype.portIn = function (port) {
    var p = this.peripherals;
    var name = portName(port);
    if (p["in"] && typeof p["in"] === "function") {
      var v = p["in"](port, name);
      if (v !== undefined && v !== null) return v & 0xFF;
    }
    if (typeof p[name] === "number") return p[name] & 0xFF;
    this.log.push("read from unwired port " + name);
    return 0;
  };

  VM.prototype.portOut = function (port, value) {
    var p = this.peripherals;
    var name = portName(port);
    if (p.out && typeof p.out === "function") { p.out(port, value, name); return; }
    this.log.push("write to unwired port " + name + " = " + value);
  };

  function portName(port) {
    var keys = Object.keys(PORT);
    for (var i = 0; i < keys.length; i++) if (PORT[keys[i]] === port) return keys[i];
    return "0x" + hex(port);
  }

  function hex(n) { return ("0" + (n & 0xFF).toString(16).toUpperCase()).slice(-2); }

  VM.prototype.setNZ = function (v) {
    this.flags.Z = (v & 0xFF) === 0;
    this.flags.N = (v & 0x80) !== 0;
  };

  VM.prototype.step = function () {
    if (this.halted) return false;
    var op = this.mem[this.pc & 0xFF];
    var arg = this.mem[(this.pc + 1) & 0xFF];
    var next = (this.pc + 2) & 0xFF;
    var a = (arg >> 4) & 0x0F, b = arg & 0x0F;
    var res, va, vb;

    switch (op) {
      case OPCODES.LDI: this.r[0] = arg; this.setNZ(this.r[0]); break;
      case OPCODES.MOV: this.r[a] = this.r[b]; this.setNZ(this.r[a]); break;
      case OPCODES.LOAD: this.r[0] = this.read(arg); this.setNZ(this.r[0]); break;
      case OPCODES.STORE: this.write(arg, this.r[0]); break;
      case OPCODES.ADD:
        va = this.r[a]; vb = this.r[b]; res = va + vb;
        this.r[a] = res & 0xFF;
        this.flags.C = res > 0xFF;
        this.flags.V = ((va ^ res) & (vb ^ res) & 0x80) !== 0;
        this.setNZ(this.r[a]); break;
      case OPCODES.SUB:
        va = this.r[a]; vb = this.r[b]; res = va - vb;
        this.r[a] = res & 0xFF;
        this.flags.C = va < vb;
        this.flags.V = ((va ^ vb) & (va ^ res) & 0x80) !== 0;
        this.setNZ(this.r[a]); break;
      case OPCODES.AND: this.r[a] = this.r[a] & this.r[b]; this.flags.C = false; this.flags.V = false; this.setNZ(this.r[a]); break;
      case OPCODES.OR: this.r[a] = this.r[a] | this.r[b]; this.flags.C = false; this.flags.V = false; this.setNZ(this.r[a]); break;
      case OPCODES.XOR: this.r[a] = this.r[a] ^ this.r[b]; this.flags.C = false; this.flags.V = false; this.setNZ(this.r[a]); break;
      case OPCODES.NOT: this.r[a] = (~this.r[a]) & 0xFF; this.flags.C = false; this.flags.V = false; this.setNZ(this.r[a]); break;
      case OPCODES.SHL:
        va = this.r[a]; this.flags.C = (va & 0x80) !== 0; this.r[a] = (va << 1) & 0xFF;
        this.flags.V = ((va & 0x40) !== 0) !== ((va & 0x80) !== 0); this.setNZ(this.r[a]); break;
      case OPCODES.SHR:
        va = this.r[a]; this.flags.C = (va & 0x01) !== 0; this.r[a] = va >> 1;
        this.flags.V = false; this.setNZ(this.r[a]); break;
      case OPCODES.CMP:
        va = this.r[a]; vb = this.r[b]; res = va - vb;
        this.flags.C = va < vb;
        this.flags.V = ((va ^ vb) & (va ^ res) & 0x80) !== 0;
        this.setNZ(res); break;
      case OPCODES.JMP: next = arg; break;
      case OPCODES.JZ: if (this.flags.Z) next = arg; break;
      case OPCODES.JNZ: if (!this.flags.Z) next = arg; break;
      case OPCODES.JG: if (!this.flags.Z && this.flags.N === this.flags.V) next = arg; break;
      case OPCODES.JL: if (this.flags.N !== this.flags.V) next = arg; break;
      case OPCODES.CALL:
        if (this.stack.length >= 16) { this.error = "stack overflow"; this.halted = true; return false; }
        this.stack.push(next); next = arg; break;
      case OPCODES.RET:
        if (!this.stack.length) { this.error = "RET with an empty stack"; this.halted = true; return false; }
        next = this.stack.pop(); break;
      case OPCODES.PUSH:
        if (this.stack.length >= 16) { this.error = "stack overflow"; this.halted = true; return false; }
        this.stack.push(this.r[a]); break;
      case OPCODES.POP:
        if (!this.stack.length) { this.error = "POP with an empty stack"; this.halted = true; return false; }
        this.r[a] = this.stack.pop(); this.setNZ(this.r[a]); break;
      case OPCODES.IN: this.r[0] = this.read(arg); this.setNZ(this.r[0]); break;
      case OPCODES.OUT: this.write(arg, this.r[0]); break;
      case OPCODES.RAND: this.r[a] = this.rand() & 0xFF; this.setNZ(this.r[a]); break;
      case OPCODES.NOP: break;
      case OPCODES.HLT: this.halted = true; this.pc = next; return false;
      default:
        this.error = "not an instruction: 0x" + hex(op) + " at 0x" + hex(this.pc);
        this.halted = true;
        return false;
    }
    this.pc = next & 0xFF;
    this.steps++;
    return !this.halted;
  };

  VM.prototype.run = function (maxSteps) {
    var limit = maxSteps === undefined ? 20000 : maxSteps;
    while (!this.halted && this.steps < limit) this.step();
    if (!this.halted && this.steps >= limit) this.error = this.error || "step limit reached (" + limit + ")";
    return this;
  };

  /* ------------------------------------------------------------------ helpers */

  /* A ready-made host for the app and the tests: an 8-bit device bus. */
  function host(opts) {
    opts = opts || {};
    var out = [];
    var text = "";
    var notes = [];
    var beeps = [];
    var clipboard = opts.clipboard || "";
    var clipAt = 0;
    var state = {
      CLOCK: opts.hour === undefined ? 9 : opts.hour & 0xFF,
      LAT: opts.lat === undefined ? 19 : opts.lat & 0xFF,
      LON: opts.lon === undefined ? 73 : opts.lon & 0xFF,
      OFFICE_INSIDE: opts.officeInside ? 1 : 0,
      NEXT_EVENT_MIN: opts.nextEventMin === undefined ? 30 : opts.nextEventMin & 0xFF,
      ACCEL: opts.accel === undefined ? 128 : opts.accel & 0xFF
    };
    var p = {
      state: state,
      output: out,
      text: function () { return text; },
      notes: notes,
      beeps: beeps,
      "in": function (port, name) {
        if (name === "RNG") return Math.floor(Math.random() * 256);
        if (name === "CLIPBOARD") { var c = clipboard.charCodeAt(clipAt++) || 0; return c; }
        return state[name];
      },
      out: function (port, value, name) {
        if (name === "NOTIFY") { notes.push(value); out.push("NOTIFY " + value); return; }
        if (name === "CLIPBOARD") { clipboard += String.fromCharCode(value); out.push("CLIPBOARD '" + String.fromCharCode(value) + "'"); return; }
        if (name === "AUDIO") { beeps.push(value); out.push("AUDIO " + value); return; }
        if (name === "HALT") { out.push("HALT"); return; }
        if (Object.prototype.hasOwnProperty.call(state, name)) { state[name] = value; out.push(name + " = " + value); return; }
        out.push("PORT " + name + " = " + value);
      }
    };
    return p;
  }

  /* The machine reference card, in one place, so the UI and the docs agree. */
  var REFERENCE = [
    { op: "LDI", operand: "imm8", effect: "R0 = imm8", flags: "Z N" },
    { op: "MOV", operand: "Ra, Rb", effect: "Ra = Rb", flags: "Z N" },
    { op: "LOAD", operand: "addr8", effect: "R0 = mem[addr8] (or the peripheral there)", flags: "Z N" },
    { op: "STORE", operand: "addr8", effect: "mem[addr8] = R0", flags: "-" },
    { op: "ADD", operand: "Ra, Rb", effect: "Ra = Ra + Rb", flags: "Z N C V" },
    { op: "SUB", operand: "Ra, Rb", effect: "Ra = Ra - Rb", flags: "Z N C V" },
    { op: "AND", operand: "Ra, Rb", effect: "Ra = Ra & Rb", flags: "Z N" },
    { op: "OR", operand: "Ra, Rb", effect: "Ra = Ra | Rb", flags: "Z N" },
    { op: "XOR", operand: "Ra, Rb", effect: "Ra = Ra ^ Rb", flags: "Z N" },
    { op: "NOT", operand: "Ra", effect: "Ra = ~Ra", flags: "Z N" },
    { op: "SHL", operand: "Ra", effect: "Ra = Ra << 1", flags: "Z N C V" },
    { op: "SHR", operand: "Ra", effect: "Ra = Ra >> 1", flags: "Z N C" },
    { op: "CMP", operand: "Ra, Rb", effect: "flags from Ra - Rb, nothing stored", flags: "Z N C V" },
    { op: "JMP", operand: "addr8", effect: "jump", flags: "-" },
    { op: "JZ", operand: "addr8", effect: "jump when Z", flags: "-" },
    { op: "JNZ", operand: "addr8", effect: "jump when not Z", flags: "-" },
    { op: "JG", operand: "addr8", effect: "jump when signed greater (not Z, N = V)", flags: "-" },
    { op: "JL", operand: "addr8", effect: "jump when signed less (N ≠ V)", flags: "-" },
    { op: "CALL", operand: "addr8", effect: "push the return address, jump", flags: "-" },
    { op: "RET", operand: "", effect: "pop the return address", flags: "-" },
    { op: "PUSH", operand: "Ra", effect: "push Ra", flags: "-" },
    { op: "POP", operand: "Ra", effect: "Ra = pop", flags: "Z N" },
    { op: "IN", operand: "port8", effect: "R0 = peripheral[port8]", flags: "Z N" },
    { op: "OUT", operand: "port8", effect: "peripheral[port8] = R0", flags: "-" },
    { op: "RAND", operand: "Ra", effect: "Ra = a random byte", flags: "Z N" },
    { op: "NOP", operand: "", effect: "do nothing", flags: "-" },
    { op: "HLT", operand: "", effect: "stop the machine", flags: "-" }
  ];

  return {
    OPCODES: OPCODES, NAMES: NAMES, SHAPE: SHAPE, PORT: PORT, REFERENCE: REFERENCE,
    ROM_START: ROM_START, ROM_END: ROM_END, RAM_START: RAM_START, RAM_END: RAM_END,
    PERIPH_START: PERIPH_START,
    assemble: assemble, VM: VM, host: host, portName: portName
  };
});
