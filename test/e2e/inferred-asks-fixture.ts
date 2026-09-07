import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { anchorAsks, askSourceHash } from '../../src/core/asks'
import { credentialPath } from './cockpit-engine-harness'
import type { Scenario } from './harness'
/** Persist real scanner output before launch; fake external engines never call a real provider. */
export async function seedAsks(scenario: Scenario, source: string, quotes: string[]) {
  const asks=anchorAsks('m1',source,quotes.map(quote=>({quote})))
  await writeFile(join(dirname(credentialPath(scenario)), 'engine-conversations.json'), JSON.stringify({formatVersion:1,threads:{t1:{replies:{},pending:[],answered:[],dismissed:[],asks:{m1:{sourceHash:askSourceHash(source),state:'done',asks}}}}}))
  return asks
}
