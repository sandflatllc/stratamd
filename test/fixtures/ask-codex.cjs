#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
let input = ''
process.stdin.on('data', chunk => input += chunk)
process.stdin.on('end', () => {
  if (process.env.ASK_FIXTURE_RECORD) fs.writeFileSync(process.env.ASK_FIXTURE_RECORD, JSON.stringify({args,input,cwd:process.cwd(),home:process.env.CODEX_HOME,pid:process.pid}))
  if (process.env.ASK_FIXTURE_MODE === 'orphan') {
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
    child.unref(); return
  }
  if (process.env.ASK_FIXTURE_MODE === 'hang') { setInterval(() => {}, 1000); return }
  if (process.env.ASK_FIXTURE_MODE === 'fail') { process.exitCode=2; return }
  if (process.env.ASK_FIXTURE_MODE === 'tool') console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'bad'}}))
  if (process.env.ASK_FIXTURE_MODE === 'tool-no-newline') process.stdout.write(JSON.stringify({type:'item.started',item:{type:'command_execution'}}))
  fs.writeFileSync(args[args.indexOf('--output-last-message')+1], process.env.ASK_FIXTURE_MODE === 'malformed' ? 'oops' : '{"asks":[{"quote":"Which date?"}]}')
})
