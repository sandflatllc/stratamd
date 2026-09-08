import { useEffect, useState } from 'react'
import { engineStorage } from './engineStorage'

type Answers = Record<string, Record<string, string>>
const changed = 'strata-held-user-inputs'
function read(key: string): Answers {
  try {
    const value: unknown = JSON.parse(engineStorage.getItem(key) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, answers]) => answers && typeof answers === 'object' && !Array.isArray(answers) && Object.values(answers).every(answer => typeof answer === 'string')))
  } catch { return {} }
}

/** Provider questions wait with other held context, scoped to this engine and thread. */
export function useHeldUserInputs(threadId: string | undefined) {
  const key = `held-user-inputs:${threadId ?? ''}`
  const [snapshot, setSnapshot] = useState(() => ({ key, answers: read(key) }))
  useEffect(() => {
    const refresh = () => setSnapshot({ key, answers: read(key) })
    refresh()
    window.addEventListener(changed, refresh)
    return () => window.removeEventListener(changed, refresh)
  }, [key])
  const write = (requestId: string, value: Record<string, string> | null) => {
    const answers = read(key)
    if (value) answers[requestId] = value
    else delete answers[requestId]
    engineStorage.setItem(key, JSON.stringify(answers))
    setSnapshot({ key, answers })
    window.dispatchEvent(new Event(changed))
  }
  return { answers: snapshot.key === key ? snapshot.answers : read(key), hold: (id: string, answers: Record<string, string>) => write(id, answers), remove: (id: string) => write(id, null) }
}
