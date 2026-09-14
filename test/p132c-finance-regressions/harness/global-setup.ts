import type { TestProject } from 'vitest/node'
import { startDb, stopDb } from './docker-pg'

declare module 'vitest' {
  export interface ProvidedContext {
    p132cContainer: string
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const db = await startDb((line) => {
    console.log(`[p132c] ${line}`)
  })
  console.log(
    `[p132c] database container: ${db.container}${db.owned ? ' (disposable)' : ' (attached)'}`,
  )
  project.provide('p132cContainer', db.container)
  return () => stopDb(db)
}
