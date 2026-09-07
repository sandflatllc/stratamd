import { readFileSync, readdirSync, existsSync } from 'node:fs'
const expected = JSON.parse(readFileSync('expected.json', 'utf8'))
const docs = { short: readFileSync('reply-short.md', 'utf8'), long: readFileSync('reply-long.md', 'utf8') }
const norm = s => s.replace(/\s+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim()
const span = (doc, quote) => { const i = norm(doc).indexOf(norm(quote)); return i < 0 ? null : [i, i + norm(quote).length] }
const overlaps = (a, b) => a && b && a[0] < b[1] && b[0] < a[1]
const timings = existsSync('out/timings.jsonl') ? readFileSync('out/timings.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const rows = []
for (const file of readdirSync('out').filter(f => f.endsWith('.json')).sort()) {
  const m = file.match(/^(.+)-(short|long)-(\d+)\.json$/); if (!m) continue
  const [, tag, doc, run] = m
  let asks; try { asks = JSON.parse(readFileSync(`out/${file}`, 'utf8')).asks } catch (e) { rows.push({ tag, doc, run, error: 'bad json' }); continue }
  const exp = expected[doc]; const text = docs[doc]
  const got = asks.map(a => ({ ...a, span: span(text, a.quote) }))
  const hits = exp.asks.map(e => ({ id: e.id, hit: got.some(g => overlaps(g.span, span(text, e.quote))) }))
  const trapHits = exp.traps.map(t => ({ id: t.id, hit: got.some(g => overlaps(g.span, span(text, t.quote))) })).filter(t => t.hit).map(t => t.id)
  const optionalHits = exp.optional.map(o => ({ id: o.id, hit: got.some(g => overlaps(g.span, span(text, o.quote))) })).filter(o => o.hit).map(o => o.id)
  const known = [...exp.asks, ...exp.traps, ...exp.optional].map(e => span(text, e.quote))
  const unknown = got.filter(g => g.span && !known.some(k => overlaps(g.span, k))).map(g => g.quote.slice(0, 60))
  const unverbatim = got.filter(g => !g.span).map(g => g.quote.slice(0, 60))
  const t = timings.find(x => x.tag === tag && x.doc === doc && String(x.run) === run)
  rows.push({ tag, doc, run, ms: t?.ms, found: `${hits.filter(h => h.hit).length}/${exp.asks.length}`, missed: hits.filter(h => !h.hit).map(h => h.id).join(','), traps: trapHits.join(','), optional: optionalHits.join(','), extra: unknown.length, unverbatim: unverbatim.length, })
  if (process.argv.includes('-v')) { console.log(`\n## ${tag} ${doc} run ${run}`); for (const g of got) console.log(`- ${g.question}\n    quote: ${g.quote.slice(0, 100)}${g.span ? '' : '  (NOT VERBATIM)'}`); if (unknown.length) console.log('  extra:', unknown); }
}
console.table(rows)
