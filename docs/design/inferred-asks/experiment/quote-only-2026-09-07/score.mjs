import { readFile } from 'node:fs/promises'
const root = new URL('./', import.meta.url)
const cases = new Map(JSON.parse(await readFile(new URL('cases.json', root))).map(c => [c.id, c]))
const norm = text => text.toLowerCase().replace(/\s+/g, ' ').trim()
for (const file of ['runs.jsonl', 'follow-up.jsonl']) {
 const rows = (await readFile(new URL(file, root), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
 for (const variant of new Set(rows.map(r => r.variant))) {
  let hits=0, extras=0, expected=0
  const group=rows.filter(r=>r.variant===variant), times=group.map(r=>r.seconds).sort((a,b)=>a-b)
  for (const row of group) {
   const labels=cases.get(row.case).expected.map(e=>norm(e.anchor)), quotes=(row.output?.asks??[]).map(a=>norm(a.quote))
   const matches=(a,b)=>a.includes(b)||b.includes(a)
   expected+=labels.length; hits+=labels.filter(e=>quotes.some(q=>matches(e,q))).length
   extras+=quotes.filter(q=>!labels.some(e=>matches(e,q))).length
  }
  console.log({variant,calls:group.length,hits,expected,extras,mean:times.reduce((a,b)=>a+b,0)/times.length,median:(times[times.length/2-1]+times[times.length/2])/2,slowest:times.at(-1)})
 }
}
