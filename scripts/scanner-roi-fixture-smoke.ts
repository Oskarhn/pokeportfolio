#!/usr/bin/env tsx
/**
 * F-34/P88 §23 — real-OCR smoke test against EVERY layout family's rendered fixture, not just the
 * original vintage-only one. A manual engineering gate (same discipline as scanner-ocr-smoke.mjs
 * — deterministic Tesseract output is too environment-sensitive for a flake-free CI unit suite),
 * but a REAL one: crops each fixture at the actual roi.ts fraction rectangles and runs the real,
 * staged Tesseract engine against each crop, asserting the layout-appropriate candidate correctly
 * reads its own text.
 *
 * Run: pnpm scanner:roi-fixture:smoke
 * Requires: tests/fixtures/scanner/*.png (scripts/generate-scanner-fixture.mjs) and the staged
 * OCR assets (pnpm build, or scripts/prepare-scanner-assets.mjs).
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createWorker, OEM, PSM } from 'tesseract.js'
import {
  NAME_ROI_CANDIDATES,
  NUMBER_ROI_CANDIDATES,
  roiPixelRect,
  type NamedRoiCandidate,
} from '../src/features/scanner/roi'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = resolve(repoRoot, 'public', 'scanner-assets', 'v7')
const fixtureDir = join(repoRoot, 'tests', 'fixtures', 'scanner')

interface Case {
  file: string
  layout: 'vintage' | 'modern' | 'energy'
  expectedNameCandidateId: string
  expectedNameSubstring: string
  expectedNumberCandidateId: string | null
  expectedNumberSubstring: string | null
}

const CASES: Case[] = [
  {
    file: 'synthetic-card.png',
    layout: 'vintage',
    expectedNameCandidateId: 'classic-top-left',
    expectedNameSubstring: 'TESTASAURUS',
    expectedNumberCandidateId: 'classic-bottom-right',
    expectedNumberSubstring: '049',
  },
  {
    file: 'synthetic-card-modern.png',
    layout: 'modern',
    expectedNameCandidateId: 'modern-full-width',
    expectedNameSubstring: 'FAUXOSAUR',
    expectedNumberCandidateId: 'modern-bottom-left',
    expectedNumberSubstring: '049',
  },
  {
    file: 'synthetic-card-trainer.png',
    layout: 'modern',
    expectedNameCandidateId: 'modern-full-width',
    expectedNameSubstring: 'ORDERS',
    expectedNumberCandidateId: 'modern-bottom-left',
    expectedNumberSubstring: '178',
  },
  {
    file: 'synthetic-card-energy.png',
    layout: 'energy',
    expectedNameCandidateId: 'energy-bottom-band',
    expectedNameSubstring: 'ENERGY',
    expectedNumberCandidateId: null,
    expectedNumberSubstring: null,
  },
]

if (!existsSync(join(assetsDir, 'eng.traineddata.gz'))) {
  console.error('Staged assets missing. Run: pnpm build (or scripts/prepare-scanner-assets.mjs).')
  process.exit(1)
}

async function cropToPngBuffer(imagePath: string, candidate: NamedRoiCandidate): Promise<Buffer> {
  const meta = await sharp(imagePath).metadata()
  const width = meta.width
  const height = meta.height
  const rect = roiPixelRect({ left: 0, top: 0, width, height }, candidate.fractions)
  return sharp(imagePath)
    .extract({
      left: rect.left,
      top: rect.top,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    })
    .greyscale()
    .png()
    .toBuffer()
}

async function main() {
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    langPath: assetsDir,
    gzip: true,
    logger: () => {},
  })
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, user_defined_dpi: '300' })

  let failures = 0
  try {
    for (const testCase of CASES) {
      const imagePath = join(fixtureDir, testCase.file)
      console.log(`\n=== ${testCase.file} (${testCase.layout}) ===`)

      for (const candidate of NAME_ROI_CANDIDATES) {
        const buffer = await cropToPngBuffer(imagePath, candidate)
        const { data } = await worker.recognize(buffer)
        const text = data.text.trim()
        const isExpectedWinner = candidate.id === testCase.expectedNameCandidateId
        const containsExpected = text.toUpperCase().includes(testCase.expectedNameSubstring)
        console.log(
          `  name/${candidate.id}: "${text}" (confidence ${data.confidence.toFixed(1)})` +
            (isExpectedWinner ? '  <- expected winner' : ''),
        )
        if (isExpectedWinner && !containsExpected) {
          failures += 1
          console.error(
            `    FAIL: expected candidate ${candidate.id} to read "${testCase.expectedNameSubstring}"`,
          )
        }
      }

      if (testCase.expectedNumberCandidateId !== null) {
        for (const candidate of NUMBER_ROI_CANDIDATES) {
          const buffer = await cropToPngBuffer(imagePath, candidate)
          const { data } = await worker.recognize(buffer)
          const text = data.text.trim()
          const isExpectedWinner = candidate.id === testCase.expectedNumberCandidateId
          const containsExpected =
            testCase.expectedNumberSubstring !== null &&
            text.includes(testCase.expectedNumberSubstring)
          console.log(
            `  number/${candidate.id}: "${text}" (confidence ${data.confidence.toFixed(1)})` +
              (isExpectedWinner ? '  <- expected winner' : ''),
          )
          if (isExpectedWinner && !containsExpected) {
            failures += 1
            console.error(
              `    FAIL: expected candidate ${candidate.id} to read "${String(testCase.expectedNumberSubstring)}"`,
            )
          }
        }
      }
    }
  } finally {
    await worker.terminate()
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s)`)
  process.exitCode = failures === 0 ? 0 : 1
}

await main()
