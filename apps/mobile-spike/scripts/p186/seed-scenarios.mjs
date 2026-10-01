#!/usr/bin/env node
/**
 * Seeds / cleans the P184 adversarial-scenario catalog rows in the P186 isolated stack (LOCAL ONLY).
 * The P185 script does the work; this wrapper only points it at the P186 stack and evidence folder.
 *
 *   node scripts/p186/seed-scenarios.mjs seed | clean | show
 */
import './env.mjs'
await import('../p185/scenario-catalog.mjs')
