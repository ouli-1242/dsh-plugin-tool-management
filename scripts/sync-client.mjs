// Sync the browser half into the build output.
//
// src/client.js is intentionally excluded from tsconfig.json (it is plain
// browser JavaScript, not host-side TS), so `tsc` alone never writes
// lib/client.js. Without this step the shipped client bundle silently keeps
// running old code even though src/client.js was edited — exactly the failure
// mode that produced "switch does nothing" (a stale lib/client.js referencing
// a symbol that no longer existed).
import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
copyFileSync(join(root, 'src', 'client.js'), join(root, 'lib', 'client.js'))
console.log('[dsh-plugin-tool-management] synced src/client.js -> lib/client.js')
