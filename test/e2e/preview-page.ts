import { createServer, type Server } from 'node:http'

/**
 * A small dev-server stand-in for the preview specs (docs/plans/open/visual-review):
 * a form that keeps state, a scrollable body, a button that opens a dialog, a
 * clock that repaints every 200 ms, and a stamped React-like page for the
 * source ladders. Everything is served from loopback, the address rules'
 * http case.
 */
export interface PreviewPageServer {
  origin: string
  /** "The code changed": the clients page is served with a different button until reset. */
  setVariant(variant: 'original' | 'bigger'): void
  close(): Promise<void>
}

const CLIENTS = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Clients · Mesa Office</title>
<style>
body { margin: 0; font-family: sans-serif; color: #1d2130; background: #f6f7fb; }
header { display: flex; align-items: center; padding: 20px 24px; }
h1 { margin: 0; font-size: 22px; }
#new-client { margin-left: auto; padding: 8px 14px; border: 0; border-radius: 8px; background: #5b4aa8; color: #fff; font-weight: 700; }
table { width: 640px; margin: 0 24px; border-collapse: collapse; background: #fff; }
th { text-align: left; padding: 10px 12px; background: #f2f3f8; }
td { padding: 11px 12px; border-bottom: 1px solid #eef0f5; }
form { margin: 20px 24px; display: grid; gap: 8px; width: 320px; }
.filler { height: 1400px; }
dialog { padding: 16px; border: 1px solid #ccc; border-radius: 10px; }
</style></head>
<body>
<header><h1>Clients</h1><button id="new-client" type="button" data-insp-path="src/pages/Clients.tsx:41:9" data-testid="new-client">New client</button></header>
<table data-insp-path="src/pages/Clients.tsx:52:7"><thead><tr><th>Name</th><th>Owner</th><th>Balance</th></tr></thead>
<tbody><tr><td>Harbor Dental</td><td>Priya</td><td>$1,240.00</td></tr><tr><td>Northside Vet</td><td>Marcus</td><td>$0.00</td></tr></tbody></table>
<form id="client-form" onsubmit="event.preventDefault(); document.getElementById('saved').textContent = 'Saved ' + document.getElementById('name').value">
  <label>Client name <input id="name" name="name" placeholder="Client name" autocomplete="off"></label>
  <label>Notes <textarea id="notes" name="notes"></textarea></label>
  <button type="submit">Save client</button>
  <output id="saved"></output>
</form>
<p id="clock">--:--:--</p>
<div class="filler"></div>
<p id="bottom">The end of the page.</p>
<dialog id="dialog"><p>A dialog for the record.</p><button id="close-dialog" type="button">Close</button></dialog>
<script>
document.getElementById('new-client').addEventListener('click', () => document.getElementById('dialog').showModal())
document.getElementById('close-dialog').addEventListener('click', () => document.getElementById('dialog').close())
setInterval(() => { document.getElementById('clock').textContent = new Date().toISOString().slice(11, 19) }, 200)
</script>
</body></html>`

const INVOICES = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Invoices · Mesa Office</title></head>
<body style="font-family: sans-serif; margin: 24px"><h1>Invoices</h1>
<form id="invoice-form" onsubmit="event.preventDefault(); document.getElementById('total').textContent = 'Total ' + document.getElementById('amount').value">
  <label>Amount <input id="amount" name="amount" autocomplete="off"></label>
  <button type="submit">Add invoice</button>
  <output id="total"></output>
</form>
<p id="late">Nothing is late.</p>
</body></html>`

/** A React-looking page without build-time stamps: the fiber ladder case. */
const REACT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Schedule · Mesa Office</title></head>
<body style="font-family: sans-serif; margin: 24px"><div id="root"></div>
<script>
const root = document.getElementById('root')
const button = document.createElement('button'); button.textContent = 'Book a visit'; button.id = 'book'
const fiber = { type: { name: 'BookButton' }, _debugSource: { fileName: '/srv/mesa/src/schedule/BookButton.tsx', lineNumber: 18, columnNumber: 5 }, return: { type: { name: 'SchedulePage' }, _debugSource: { fileName: '/srv/mesa/src/pages/Schedule.tsx', lineNumber: 30, columnNumber: 7 }, return: null } }
button['__reactFiber$test'] = fiber
root.appendChild(button)
</script>
</body></html>`

/** A static page with no source at all. */
const STATIC = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About · Mesa Office</title></head><body style="font-family: sans-serif; margin: 24px"><h1>About</h1><p id="blurb">Mesa Office keeps small practices organized.</p></body></html>`

export async function startPreviewPage(): Promise<PreviewPageServer> {
  let variant: 'original' | 'bigger' = 'original'
  const server: Server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    if (request.url?.startsWith('/invoices')) { response.end(INVOICES); return }
    if (request.url?.startsWith('/schedule')) { response.end(REACT); return }
    if (request.url?.startsWith('/about')) { response.end(STATIC); return }
    if (request.url?.startsWith('/gone')) { response.writeHead(404).end('<!doctype html><title>Not here</title><p>Not here.</p>'); return }
    response.end(variant === 'bigger' ? CLIENTS.replace('#new-client { margin-left: auto; padding: 8px 14px;', '#new-client { margin-left: auto; padding: 14px 22px; font-size: 20px;') : CLIENTS)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The preview page did not bind')
  return { origin: `http://127.0.0.1:${address.port}`, setVariant: (value) => { variant = value }, close: () => new Promise((resolve) => server.close(() => resolve())) }
}
