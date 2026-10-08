import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildIndex, bm25, combine, fileSkills, parseSkill } from './rank.mjs'

const ok = (value: unknown) => ({ value }) as never

const SKILL_MD: Record<string, string> = {
  'systematic-debugging': '---\nname: systematic-debugging\ndescription: Use when encountering any bug, test failure, or unexpected behavior\n---\nFind the root cause before proposing fixes. Reproduce, isolate, hypothesis.',
  'writing-plans': '---\nname: writing-plans\ndescription: Use when you have a spec or requirements for a multi-step task\n---\nBreak the work into small tasks with tests.',
  humanizer: '---\nname: humanizer\ndescription: Rewrite AI-sounding text so it reads like the writer\n---\nEmails, posts and prose: remove AI tells.',
  'scientific-visualization': '---\nname: scientific-visualization\ndescription: Create and audit publication-ready scientific figures with Matplotlib\n---\nJournal figure sizes, colour-blind palettes, multi-panel layouts, export at 300 dpi for the manuscript.',
  docx: '---\nname: docx\ndescription: Create, read and edit Word documents (.docx)\n---\nTracked changes, headings, tables.',
}
// Ordinary skills, so word rarity behaves as it does across ~80 real ones.
for (const [n, d] of [['pptx', 'slide decks and presentations'], ['xlsx', 'spreadsheets, formulas and charts'], ['pdf', 'merge, split and fill PDF forms'],
  ['brainstorming', 'explore ideas and requirements before building'], ['markitdown', 'convert documents to Markdown'], ['theme-factory', 'colours and fonts for artifacts'],
  ['webapp-testing', 'test local web apps with Playwright'], ['create-project-env', 'Python virtual environments with uv'], ['handoff-local', 'session handoff summary'],
  ['pydicom', 'read DICOM medical images'], ['peer-review', 'review manuscripts and protocols'], ['literature-review', 'search PubMed and synthesise papers']]) {
  SKILL_MD[n] = `---\nname: ${n}\ndescription: ${d}\n---\nSteps for ${d}.`
}

function world(on: On, opts: { names?: () => string[] } = {}) {
  mock.clock(on, { now: Date.parse('2026-10-08T12:00:00Z') })
  mock.store(on, {})
  const modelCalls: string[] = []
  on('model.complete', async ($, e) => {
    modelCalls.push(e.prompt)
    return ok({ isAnswered: true, text: '', usage: {} })
  })
  const names = opts.names ?? (() => Object.keys(SKILL_MD))
  on('command.list', async () =>
    ok([...names().map(name => ({ name, description: (/description: (.*)/.exec(SKILL_MD[name] ?? '') ?? [])[1] ?? name, source: 'user' })), { name: 'help', description: 'Show help', source: 'builtin' }]),
  )
  on('env.get', async ($, e) => ok((e as { name: string }).name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined))
  on('fs.list', async ($, e) => {
    const p = (e as { path: string }).path
    return ok(p === 'C:\\Users\\me\\.claude\\skills' ? names().map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) : [])
  })
  on('fs.stat', async () => ok({ kind: 'file', size: 10, mtimeMs: 1, isLink: false }))
  on('fs.read', async ($, e) => {
    const m = /skills\\([^\\]+)\\SKILL\.md$/.exec((e as { path: string }).path)
    if (m && SKILL_MD[m[1]]) return ok(SKILL_MD[m[1]])
    throw new Error('ENOENT')
  })
  on('command.register', async ($, e) => ok({ command: e.name }))
  on('session.start', async () => ({ cwd: 'C:\\repo' }) as never)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  on('turn.start', async () => ({ turnId: 't' }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('tool.call', async () => ({ result: { ok: true } }) as never)
  on('ui.invalidate', async () => ok(undefined))
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  const filled: string[] = []
  on('prompt.read', async () => ok({ text: 'the save button', cursor: 0 }))
  on('prompt.fill', async ($, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  return { modelCalls, filled }
}

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never } as const

async function chips($: Engine, surface: 'terminal' | 'desktop' = 'desktop') {
  const ui = await $.ui.mount({ plugin: 'skill-suggester', surface, ...BAND })
  const labels = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label))
  await ui.unmount()
  return labels.filter(l => l.startsWith('/'))
}

const start = ($: Engine, surface: 'terminal' | 'desktop' = 'desktop') =>
  $.session.start({ source: 'startup', cwd: 'C:\\repo', surface, isInteractive: true } as never)
const say = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a bug report suggests the debugging skill on ${surface}, with no model call`, async ($, on) => {
    const w = world(on)
    await start($, surface)
    await say($, 'the export is broken and throws an error on save')
    expect(await chips($, surface)).toEqual(['/systematic-debugging'])
    expect(w.modelCalls).toEqual([])
  })
}

test('a slash command and a plain question suggest nothing', async ($, on) => {
  const w = world(on)
  await start($)
  await say($, '/help')
  await say($, 'what time is it')
  expect(await chips($)).toEqual([])
  expect(w.modelCalls).toEqual([])
})

test('earlier turns count: "the figures need bigger fonts" finds the figures skill only after talk of the manuscript', async ($, on) => {
  world(on)
  await start($)
  await say($, 'the figures need bigger fonts')
  expect(await chips($)).toEqual([])
})

test('the same request after "finishing the manuscript for publication" does suggest it', async ($, on) => {
  world(on)
  await start($)
  await say($, 'finishing the manuscript for publication')
  expect(await chips($)).toEqual([])
  await say($, 'the figures need bigger fonts')
  expect(await chips($)).toEqual(['/scientific-visualization'])
})

test('a Word file Claude worked on offers the docx skill when the turn ends, once a chat', async ($, on) => {
  world(on)
  await start($)
  await $.turn.start({ turnId: 't1' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\report.docx', tool_use_id: 'r1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Here it is.', durationMs: 1, isAborted: false, reason: 'answer', text: 'Here it is.' } as never)
  expect(await chips($)).toEqual(['/docx'])
  await say($, 'thanks')
  await $.turn.start({ turnId: 't2' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\other.docx', tool_use_id: 'r2' } as never)
  await $.turn.complete({ turnId: 't2', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer', text: 'ok' } as never)
  expect(await chips($)).toEqual([])
})

test('a skill added mid-chat is indexed at the next message', async ($, on) => {
  let names = ['systematic-debugging', 'writing-plans']
  world(on, { names: () => names })
  await start($)
  await say($, 'hello')
  names = [...names, 'humanizer']
  await say($, 'check this')
  await say($, 'rewrite this email to my supervisor so it reads like the writer, less AI-sounding')
  expect(await chips($)).toEqual(['/humanizer'])
})

test('clicking a chip puts the skill in the message box, in front of what was typed', async ($, on) => {
  const w = world(on)
  await start($)
  await say($, 'the export is broken and throws an error on save')
  const ui = await $.ui.mount({ plugin: 'skill-suggester', surface: 'desktop', ...BAND })
  await ui.press({ key: 'c-systematic-debugging' })
  await ui.unmount()
  expect(w.filled).toEqual(['/systematic-debugging the save button '])
})

test('ranking: words, phrases, files, project pins and your answers add up', () => {
  const index = buildIndex(Object.values(SKILL_MD).map(parseSkill))
  const text = bm25(index, [{ text: 'publication figures for the journal', weight: 1 }])
  const names = Object.keys(SKILL_MD)
  const none = new Set<string>()
  expect(combine({ names, text, rules: none, files: none, pins: none, feedback: {} })[0].name).toBe('scientific-visualization')
  expect(fileSkills('C:\\x\\notes.docx')).toEqual(['docx'])
  // Dismissed often, a skill needs much stronger evidence.
  expect(combine({ names, text, rules: none, files: none, pins: none, feedback: { 'scientific-visualization': { clicked: 0, dismissed: 4 } } }).map(r => r.name)).not.toContain('scientific-visualization')
  // A phrase rule alone is enough; small talk is not.
  expect(combine({ names, text: new Map(), rules: new Set(['humanizer']), files: none, pins: none, feedback: {} }).map(r => r.name)).toEqual(['humanizer'])
  expect(combine({ names, text: bm25(index, [{ text: 'thanks looks good', weight: 1 }]), rules: none, files: none, pins: none, feedback: {} })).toEqual([])
})
