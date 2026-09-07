import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { observations } from './verification/records.mjs'
const root = resolve(process.env.STRATAMD_VERIFY_HOME || join(homedir(), '.cache/stratamd-verification'))
const directory = join(root, 'tasks')
const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
const tasks = await Promise.all(files.filter(file => file.endsWith('.json')).map(async file => JSON.parse(await readFile(join(directory, file), 'utf8'))))
console.log(JSON.stringify(observations(tasks), null, 2))
