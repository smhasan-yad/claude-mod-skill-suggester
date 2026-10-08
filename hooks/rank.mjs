// Skill ranking, all local and deterministic: no model, no network.
//
// Evidence for a skill, added up:
//   text     BM25 over the skill's SKILL.md (name and description x4, the
//            first 6000 characters of the body x0.3), queried with the prompt and, weighted down, the last
//            few prompts, Claude's last answer and the files touched
//   files    a file type Claude reads or writes that belongs to a skill
//   rules    a precise phrase in the prompt (RULES in skill-suggester.mjs)
//   pins     the project's own .claude/skill-hints.json
//   you      clicks raise a skill, dismissals lower it (kept per profile)
// Pure functions: no `$` here, so the tests run them directly.

const STOP = new Set(("a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or our so " +
  "that the their them then there these this to up use used uses using was we what when where which while who why will with you your " +
  "any all also more most other some such than too very should would could just like want need make made get got file files work works " +
  "skill skills claude user users one two new see each only own may must about after before over under when then they been being here " +
  "yes ok okay please thanks lets let now still back done").split(" "));

/** Words of a text: lowercase, letters and digits, light suffix stripping. */
export function tokens(text) {
  const out = [];
  for (let w of String(text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    if (w.length > 5 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
    else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    if (w.length >= 3 && !STOP.has(w)) out.push(w);
  }
  return out;
}

/** SKILL.md text -> { name, description, body } (frontmatter read loosely). */
export function parseSkill(text) {
  const s = String(text ?? "");
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(s);
  if (!m) return { name: "", description: "", body: s };
  const head = m[1];
  const field = (k) => {
    const r = new RegExp(`^${k}:\\s*(.*(?:\\n[ \\t]+.*)*)`, "mi").exec(head);
    return r ? r[1].replace(/^[|>]-?\s*/, "").replace(/\s+/g, " ").replace(/^["']|["']$/g, "").trim() : "";
  };
  return { name: field("name"), description: field("description"), body: m[2] };
}

const K1 = 1.2;
const B = 0.75;

/**
 * The index: per skill a weighted bag of words, plus document frequencies.
 * docs: [{ name, description, body }]
 */
// Tuned on the 33 installed skills against 24 realistic prompts: name and
// description carry the most, the body's start adds terms the description
// lacks (15/19 right at rank 1 on words alone; phrases and files cover the rest).
export const WEIGHTS = { name: 4, description: 4, body: 0.3, bodyCap: 6000 };
export function buildIndex(docs, w = WEIGHTS) {
  const items = [];
  const df = new Map();
  for (const d of docs) {
    const tf = new Map();
    const add = (text, weight) => { for (const t of tokens(text)) tf.set(t, (tf.get(t) ?? 0) + weight); };
    add(String(d.name).replace(/[:_-]/g, " "), w.name);
    add(d.description, w.description);
    add(String(d.body ?? "").slice(0, w.bodyCap), w.body);
    let len = 0;
    for (const v of tf.values()) len += v;
    items.push({ name: d.name, tf, len });
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avg = items.reduce((a, i) => a + i.len, 0) / Math.max(1, items.length);
  return { items, df, n: items.length, avg };
}

/**
 * BM25 of each skill against a weighted query: [{ text, weight }].
 * Returns Map name -> score. A query word counts once per part, scaled by
 * the part's weight, so a long pasted answer cannot outweigh the prompt.
 */
export function bm25(index, parts) {
  const q = new Map();
  for (const { text, weight } of parts) {
    for (const t of new Set(tokens(text))) q.set(t, Math.max(q.get(t) ?? 0, weight));
  }
  const scores = new Map();
  for (const it of index.items) {
    let s = 0;
    for (const [t, w] of q) {
      const f = it.tf.get(t);
      if (!f) continue;
      const n = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (index.n - n + 0.5) / (n + 0.5));
      s += w * idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * it.len) / index.avg)));
    }
    if (s > 0) scores.set(it.name, s);
  }
  return scores;
}

// File types that belong to a skill (by bare skill name).
export const FILE_TRIGGERS = [
  { ext: /\.(docx|dotx|doc)$/i, skills: ["docx"] },
  { ext: /\.pdf$/i, skills: ["pdf"] },
  { ext: /\.(pptx|potx)$/i, skills: ["pptx"] },
  { ext: /\.(xlsx|xlsm|xltx|csv|tsv)$/i, skills: ["xlsx"] },
  { ext: /\.(dcm|dicom)$/i, skills: ["pydicom"] },
  { ext: /\.(bib|tex)$/i, skills: ["scientific-writing"] },
  { ext: /(requirements\.txt|pyproject\.toml|\.python-version)$/i, skills: ["create-project-env"] },
  { ext: /(^|[\\/])(AGENTS|CLAUDE)\.md$/i, skills: ["writing-for-agents"] },
  { ext: /(^|[\\/])SKILL\.md$/i, skills: ["writing-for-agents"] },
  { ext: /\.(h5ad|h5)$/i, skills: ["single-cell-rna-qc"] },
  { ext: /(handoff(_journal)?\.md)$/i, skills: ["handoff-journal"] },
];

/** Bare skill names a touched path points to. */
export function fileSkills(path) {
  const p = String(path ?? "");
  const out = [];
  for (const r of FILE_TRIGGERS) if (r.ext.test(p)) out.push(...r.skills);
  return out;
}

/** The weight your clicks and dismissals give a skill: 0.25 to 1.6. */
export function feedbackWeight(f) {
  if (!f) return 1;
  const w = (1 + 0.15 * Math.min(f.clicked ?? 0, 4)) / (1 + 0.6 * (f.dismissed ?? 0));
  return Math.max(0.25, Math.min(1.6, w));
}

export const THRESHOLD = 5; // total evidence a chip needs (tuned on your skills)
export const RULE_BONUS = 6;
export const FILE_BONUS = 6;
export const PIN_BONUS = 2.5;

/**
 * Combine the evidence. Returns [{ name, score, why }] best first, above the
 * threshold, at most `max`.
 * text: Map name -> bm25; rules, files, pins: Set of names.
 */
export function combine({ names, text, rules, files, pins, feedback, max = 2, threshold = THRESHOLD }) {
  const out = [];
  for (const name of names) {
    const bm = text.get(name) ?? 0;
    let s = bm;
    const why = [];
    if (bm >= 2) why.push("words");
    if (rules.has(name)) { s += RULE_BONUS; why.push("phrase"); }
    if (files.has(name)) { s += FILE_BONUS; why.push("file"); }
    if (pins.has(name) && s > 0) { s += PIN_BONUS; why.push("project"); }
    s *= feedbackWeight(feedback?.[name]);
    if (s >= threshold) out.push({ name, score: s, why });
  }
  out.sort((a, b) => b.score - a.score);
  // A second chip only when it is nearly as strong as the first.
  return out.filter((o, i) => i === 0 || o.score >= 0.6 * out[0].score).slice(0, max);
}
