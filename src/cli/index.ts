#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { runCli } from './commands.js'

export { runCli } from './commands.js'
export * from './protocol.js'
export { AGENT_HELP } from './agent-help.js'
export { requestOverSocket, socketPathForEnvironment } from './socket-client.js'

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runCli(process.argv.slice(2))
}
