/**
 * Boots a disposable finance database and leaves it running (prints the container name). For
 * manual exploration and mutation experiments only; remove it with `docker rm -f -v <name>`.
 *
 *   pnpm exec tsx test/p132c-finance-regressions/harness/boot-keep.ts
 */
import { startDb } from './docker-pg'

process.env.P132C_KEEP_CONTAINER = '1'
const db = await startDb((line) => {
  console.log(line)
})
console.log(`CONTAINER=${db.container}`)
