// Skill Suggester: up to two of your skills as chips above the prompt, picked
// from what you are working on: your message, the last few turns, the files
// Claude reads and writes, the project's own hints and what you clicked or
// dismissed before. All local and deterministic: no model call, no tokens,
// nothing added to the prompt. A chip only fills the message box when clicked.
//
// Skills are found on disk (your skills folder, the project's .claude/skills,
// installed plugins) and indexed whole (rank.mjs). A skill added later is
// picked up at the next message: the list is re-read and only changed
// SKILL.md files are read again. Each skill is suggested at most once a chat.
//
// Per project, .claude/skill-hints.json: { "boost": [names], "mute": [names] }.
// /skill-suggester shows what it knows; /skill-suggester unmute clears mutes.

import { bm25, buildIndex, combine, fileSkills, parseSkill } from "./rank.mjs";

const MAX_CHIPS = 2;
const RECENT = 3; // earlier prompts kept as context
const FILES_KEPT = 12;

// Precise phrases that point straight at a skill (bare names; the first
// installed match wins). Words alone find the rest.
const RULES = [
  { skills: ["systematic-debugging", "diagnosing-bugs"], prompt: /\b(bug|errors?|fail(s|ed|ing|ure)?|broken|crash(es|ed)?|exception|traceback|stack ?trace|not working|doesn'?t work|regression|keyerror|typeerror|valueerror)\b/i },
  { skills: ["writing-plans"], prompt: /\b(plan (out|the)|roadmap|step[- ]by[- ]step|migrat(e|ion)|refactor)\b/i },
  { skills: ["brainstorming"], prompt: /\b(brainstorm|ideas? for|what if|options for|how (could|should) (i|we))\b/i },
  { skills: ["verification-before-completion"], prompt: /\b(is it (done|working|fixed)|double[- ]check|before (i|we) (ship|commit|merge|push)|ready to (ship|merge|commit))\b/i },
  { skills: ["create-project-env"], prompt: /\b(venv|virtual ?env(ironment)?|pip install|uv (add|pip|venv)|requirements\.txt|python env(ironment)?)\b/i },
  { skills: ["humanizer"], prompt: /\b(reword|proofread|sound(s)? (more |less )?(human|natural|robotic)|draft (an? )?(email|message|post|reply|letter)|linkedin)\b/i },
  { skills: ["handoff-journal", "handoff-local"], prompt: /\b(hand ?off|continue (this )?(later|tomorrow)|end of (the )?day|pick (this|it) up later|summari[sz]e (this|the) session)\b/i },
  { skills: ["scientific-writing"], prompt: /\b(manuscript|abstract|discussion section|methods section|results section|journal submission|research paper)\b/i },
  { skills: ["peer-review"], prompt: /\breview (this|the|a|my) (paper|manuscript|preprint|protocol|proposal)\b/i },
  { skills: ["literature-review"], prompt: /\b(literature|systematic review|meta[- ]analysis|pubmed|papers (on|about)|evidence (on|for)|studies (on|of))\b/i },
  { skills: ["statistical-analysis"], prompt: /\b(t[- ]?test|anova|chi[- ]square|p[- ]?values?|sample size|power analysis|significan(t|ce)|effect size|confidence interval)\b/i },
  { skills: ["clinical-reports"], prompt: /\b(case report|clinical report|discharge summary|adverse event)\b/i },
  { skills: ["evidence-bank-builder"], prompt: /\b(mcqs?|question bank|exam prep|past papers?|flash ?cards?|recall questions)\b/i },
  { skills: ["markitdown"], prompt: /\bconvert\b.*\b(pdf|docx?|pptx?|xlsx?|html|epub)\b.*\b(markdown|md|text)\b/i },
  { skills: ["multi-agent-collab"], prompt: /\b(codex|gemini|antigravity|herdr|multi[- ]agent|agent hub|collab session)\b/i },
  { skills: ["writing-for-agents"], prompt: /\b(agents\.md|claude\.md|skill\.md|(write|edit|create) (a |the )?skill)\b/i },
  { skills: ["markdown-mermaid-writing"], prompt: /\b(flow ?chart|mermaid|sequence diagram|diagram of)\b/i },
  { skills: ["scientific-visualization"], prompt: /\b(figure|plot|chart|graph)s?\b.*\b(paper|publication|journal|manuscript)\b/i },
  { skills: ["gdrive-push"], prompt: /\b(upload|push|sync|back ?up)\b.*\b(google )?drive\b/i },
  { skills: ["security-review"], prompt: /\b(security review|vulnerab(le|ility)|leaked secrets?|injection)\b/i },
];

// name -> { name, description }: the skills you can run now (enabled).
let skills = new Map();
let index = null;
let indexing = null;
const docs = new Map(); // name -> { name, description, body }
let fileCache = {}; // SKILL.md path -> { m (mtime), name, description, body }

let chips = []; // [{ name, why }] shown now
const shownThisChat = new Set();
const usedThisChat = new Set();
let muted = new Set();
let feedback = {}; // name -> { clicked, dismissed }
let pins = { boost: new Set(), mute: new Set() };

let recentPrompts = [];
let lastAnswer = "";
let touched = []; // recent file paths
let fileHints = new Set(); // skills the touched files point to, not yet offered
let toolErrors = 0;
let edits = 0;
let cwd = "";
let configDir = "";

export function register(on) {
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    await $.command.register({ name: "skill-suggester", description: "Skill Suggester: what it indexed and what is muted; /skill-suggester unmute clears mutes" });
    cwd = String(e.cwd ?? "");
    const own = (await $.env.get("CLAUDE_CONFIG_DIR").catch(() => undefined)) ?? "";
    const home = ((await $.env.get("USERPROFILE").catch(() => undefined)) ?? "").replace(/[\\/]+$/, "");
    configDir = own || (home ? `${home}\\.claude` : "");
    muted = new Set(((await $.store.get("muted").catch(() => undefined)) ?? []).map(String));
    feedback = (await $.store.get("feedback").catch(() => undefined)) ?? {};
    fileCache = (await $.store.get("files").catch(() => undefined)) ?? {};
    pins = await readPins($);
    indexing = refresh($).catch(() => undefined);
    return r;
  });

  on("command.run", { command: "skill-suggester" }, async ($, e) => {
    if (/unmute/i.test(String(e.args ?? ""))) {
      muted = new Set();
      await $.store.set("muted", []);
      return { text: "Skill Suggester: nothing is muted now." };
    }
    await refresh($);
    const liked = Object.entries(feedback).filter(([, f]) => (f.clicked ?? 0) > 0).map(([n]) => n);
    const cooled = Object.entries(feedback).filter(([, f]) => (f.dismissed ?? 0) >= 1).map(([n]) => n);
    return {
      text: [
        `Skill Suggester: ${skills.size} skills, ${docs.size} indexed from their SKILL.md.`,
        `Muted: ${[...muted].join(", ") || "none"} (/skill-suggester unmute).`,
        `Clicked before: ${liked.join(", ") || "none"}. Dismissed before: ${cooled.join(", ") || "none"}.`,
        `Project hints (.claude/skill-hints.json): boost ${[...pins.boost].join(", ") || "none"}; mute ${[...pins.mute].join(", ") || "none"}.`,
      ].join("\n"),
    };
  });

  on("prompt.submit", async ($, e, next) => {
    const r = await next(e);
    try {
      const text = String(e.text ?? "").trim();
      toolErrors = 0;
      edits = 0;
      await ignored($);
      const slash = /^\/([\w:.-]+)/.exec(text);
      if (slash) {
        usedThisChat.add(resolve(slash[1]) ?? slash[1]);
      } else if (text) {
        if (indexing) await indexing;
        indexing = refresh($).catch(() => undefined); // picks up new skills for next time
        await suggest($, rank(text));
        recentPrompts = [text, ...recentPrompts].slice(0, RECENT);
      }
    } catch {
      // suggesting must never get in the way
    }
    return r;
  }).catch(($, e, next) => next(e));

  on("tool.call", async ($, e, next) => {
    const ran = await next(e);
    try {
      if (e.agentId) return ran;
      if (e.tool === "Skill" && e.skill) usedThisChat.add(resolve(String(e.skill)) ?? String(e.skill));
      const path = e.file_path ?? e.notebook_path ?? e.path;
      if (typeof path === "string" && path) {
        touched = [path, ...touched.filter((p) => p !== path)].slice(0, FILES_KEPT);
        for (const bare of fileSkills(path)) {
          const name = resolve(bare);
          if (name) fileHints.add(name);
        }
      }
      if (ran && ran.isError === true && ran.deny === undefined) {
        toolErrors += 1;
        if (toolErrors === 2) await offer($, ["systematic-debugging", "diagnosing-bugs"], "errors");
      }
      if (e.tool === "Edit" || e.tool === "Write" || e.tool === "MultiEdit") edits += 1;
    } catch {
      // never block a tool
    }
    return ran;
  }).catch(($, e, next) => next(e));

  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    try {
      if (e.agentId) return r;
      lastAnswer = String(e.text ?? "").slice(0, 3000);
      // The file types Claude worked with this turn, offered once it is done.
      const fromFiles = [...fileHints].filter((n) => fresh(n));
      fileHints = new Set();
      if (fromFiles.length && chips.length === 0) await suggest($, fromFiles.slice(0, MAX_CHIPS).map((name) => ({ name, why: ["file"] })));
      const claimsDone = /\b(done|fixed|all set|completed?|works now|should (now )?work|is ready)\b/i.test(lastAnswer);
      if (edits >= 1 && (claimsDone || edits >= 3) && chips.length === 0) await offer($, ["verification-before-completion"], "edits");
    } catch {
      // ignore
    }
    return r;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const below = await next(e);
    if (e.props.hasSurvey || chips.length === 0) return below;
    const t = $.ui.resolve(e);
    const row = t.Box({
      key: "skill-suggester",
      flexDirection: "row",
      alignItems: "center",
      gap: 1,
      flexWrap: "wrap",
      children: [
        t.Text({ key: "lead", dimColor: true, children: "💡 Skill" }),
        ...chips.map((c) => t.Button({ key: `c-${c.name}`, label: `/${c.name}`, onPress: () => runSkill($, c.name) })),
        t.Text({ key: "why", dimColor: true, wrap: "truncate-end", children: whyText(chips) }),
        t.Button({ key: "x", label: "Not now", plain: true, dimColor: true, onPress: () => dismiss($) }),
        t.Button({ key: "mute", label: "Never", plain: true, dimColor: true, onPress: () => muteShown($) }),
      ],
    });
    return below ? t.Box({ flexDirection: "column", rowGap: e.surface === "terminal" ? 0 : 1, children: [below, row] }) : row;
  });
}

function whyText(list) {
  const why = new Set(list.flatMap((c) => c.why));
  const say = { words: "your words", phrase: "your words", file: "the files in use", project: "this project", errors: "repeated errors", edits: "the edits" };
  return `from ${[...new Set([...why].map((w) => say[w]).filter(Boolean))].join(" + ") || "your words"}`;
}

// ---- Skills on disk ------------------------------------------------------------

const join = (...p) => p.filter(Boolean).join("\\").replace(/[\\/]+/g, "\\");

/** Re-reads the skill list; indexes any SKILL.md that is new or changed. */
async function refresh($) {
  const list = await $.command.list().catch(() => []);
  const now = new Map();
  for (const c of list) {
    if (c.source === "builtin" || c.source === "mcp") continue;
    now.set(c.name, { name: c.name, description: c.description ?? "" });
  }
  if (now.size === 0) return;
  const changed = now.size !== skills.size || [...now.keys()].some((k) => !skills.has(k));
  skills = now;
  const found = await skillFiles($);
  let dirty = changed || index === null;
  const seen = {};
  for (const { path, name } of found) {
    const st = await $.fs.stat(path).catch(() => null);
    if (!st) continue;
    const hit = fileCache[path];
    if (hit && hit.m === st.mtimeMs && hit.name === name) {
      // Unchanged since it was last read (in this chat or an earlier one).
      seen[path] = hit;
      if (!docs.has(name)) {
        docs.set(name, { name, description: hit.description, body: hit.body });
        dirty = true;
      }
      continue;
    }
    const text = await $.fs.read(path).catch(() => null);
    if (text === null) continue;
    const p = parseSkill(text);
    const entry = { m: st.mtimeMs, name, description: p.description, body: String(p.body).slice(0, 6000) };
    seen[path] = entry;
    docs.set(name, { name, description: entry.description, body: entry.body });
    dirty = true;
  }
  if (Object.keys(seen).length !== Object.keys(fileCache).length) dirty = true;
  fileCache = seen;
  if (!dirty) return;
  // Every runnable skill is indexed; one without a SKILL.md found uses its listing.
  const all = [...skills.values()].map((s) => {
    const d = docs.get(s.name);
    return d ? { ...d, description: d.description || s.description } : { name: s.name, description: s.description, body: "" };
  });
  index = buildIndex(all);
  await $.store.set("files", fileCache).catch(() => undefined);
}

/** SKILL.md files: your skills folder, the project's, and installed plugins'. */
async function skillFiles($) {
  const out = [];
  const scan = async (dir, prefix) => {
    const entries = await $.fs.list(dir).catch(() => []);
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      if (ent.kind !== "dir" && !ent.isLink) continue;
      out.push({ path: join(dir, ent.name, "SKILL.md"), name: `${prefix}${ent.name}` });
    }
  };
  if (configDir) await scan(join(configDir, "skills"), "");
  if (cwd) await scan(join(cwd, ".claude", "skills"), "");
  try {
    const inst = JSON.parse(await $.fs.read(join(configDir, "plugins", "installed_plugins.json")));
    for (const [id, rows] of Object.entries(inst.plugins ?? {})) {
      for (const row of rows ?? []) if (row.installPath) await scan(join(row.installPath, "skills"), `${id.split("@")[0]}:`);
    }
  } catch {
    // no plugins file
  }
  // Only skills that can be run now.
  return out.filter((f) => skills.has(f.name));
}

async function readPins($) {
  try {
    const raw = JSON.parse(await $.fs.read(join(cwd, ".claude", "skill-hints.json")));
    return { boost: new Set((raw.boost ?? []).map(String)), mute: new Set((raw.mute ?? []).map(String)) };
  } catch {
    return { boost: new Set(), mute: new Set() };
  }
}

// ---- Choosing ------------------------------------------------------------------

/** The runnable name for a bare or full skill name. */
function resolve(want) {
  if (skills.has(want)) return want;
  return [...skills.keys()].find((k) => k.endsWith(`:${want}`)) ?? null;
}

const pinned = (set, name) => set.has(name) || set.has(name.split(":").pop());

/** Not muted, not used or offered already in this chat. */
function fresh(name) {
  return !muted.has(name) && !pinned(pins.mute, name) && !shownThisChat.has(name) && !usedThisChat.has(name);
}

export function rank(text) {
  if (!index) return [];
  const parts = [{ text, weight: 1 }];
  recentPrompts.forEach((p, i) => parts.push({ text: p, weight: 0.4 - i * 0.1 }));
  if (lastAnswer) parts.push({ text: lastAnswer, weight: 0.25 });
  if (touched.length) parts.push({ text: touched.map((p) => p.split(/[\\/]/).slice(-2).join(" ")).join(" "), weight: 0.35 });
  const scores = bm25(index, parts);
  const rules = new Set();
  for (const rule of RULES) {
    if (!rule.prompt.test(text)) continue;
    const name = rule.skills.map(resolve).find(Boolean);
    if (name) rules.add(name);
  }
  const files = new Set([...fileHints].filter(Boolean));
  const boost = new Set([...skills.keys()].filter((n) => pinned(pins.boost, n)));
  const lower = text.toLowerCase();
  const names = [...skills.keys()].filter((n) => fresh(n) && !lower.includes(n.split(":").pop()));
  return combine({ names, text: scores, rules, files, pins: boost, feedback, max: MAX_CHIPS });
}

async function offer($, bare, why) {
  const name = bare.map(resolve).find((n) => n && fresh(n));
  if (name) await suggest($, [{ name, why: [why] }]);
}

async function suggest($, picks) {
  if (!picks.length) return;
  for (const p of picks) shownThisChat.add(p.name);
  chips = picks.slice(0, MAX_CHIPS);
  $.ui.invalidate("ui.render");
}

// ---- Your answers ---------------------------------------------------------------

async function note($, name, key, by) {
  const f = feedback[name] ?? { clicked: 0, dismissed: 0 };
  f[key] = (f[key] ?? 0) + by;
  feedback[name] = f;
  await $.store.set("feedback", feedback).catch(() => undefined);
}

/** Chips left unanswered when you send the next message count a little against. */
async function ignored($) {
  if (!chips.length) return;
  for (const c of chips) await note($, c.name, "dismissed", 0.25);
  chips = [];
  $.ui.invalidate("ui.render");
}

async function dismiss($) {
  for (const c of chips) await note($, c.name, "dismissed", 1);
  chips = [];
  $.ui.invalidate("ui.render");
}

async function muteShown($) {
  const names = chips.map((c) => c.name);
  for (const n of names) muted.add(n);
  await $.store.set("muted", [...muted]);
  $.ui.toast(`Won't suggest ${names.join(", ")} again. /skill-suggester unmute brings them back.`);
  chips = [];
  $.ui.invalidate("ui.render");
}

// A chip puts the skill into the message box (in front of anything already
// typed there) for you to send, rather than running it out of sight.
async function runSkill($, name) {
  await note($, name, "clicked", 1);
  usedThisChat.add(name);
  chips = [];
  $.ui.invalidate("ui.render");
  try {
    const box = await $.prompt.read();
    const typed = String(box?.text ?? "").replace(/^\/\S+\s*/, "").trim();
    await $.prompt.fill({ text: `/${name} ${typed}`.trimEnd() + " " });
  } catch {
    $.ui.toast(`Type /${name} in the message box to use it.`);
  }
}

