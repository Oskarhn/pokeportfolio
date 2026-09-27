/**
 * Pure link/content-safety checks for a Markdown file's text, used by
 * scripts/check-doc-links.mjs (P176 §21: relative links resolve, no secret-shaped strings
 * committed). Kept dependency-free (no remark/markdown-it) since the only thing needed is
 * `[text](path)` extraction, not full Markdown parsing.
 */

const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g

/** @param {string} text @returns {string[]} every markdown link target, in order of appearance */
export function extractLinkTargets(text) {
  const targets = []
  for (const match of text.matchAll(LINK_RE)) {
    targets.push(match[1].trim())
  }
  return targets
}

/**
 * @param {string} target a raw link target as written in the markdown
 * @returns {{ kind: 'external' | 'anchor' | 'relative' }}
 */
export function classifyLinkTarget(target) {
  if (/^[a-z]+:\/\//i.test(target) || target.startsWith('mailto:')) return { kind: 'external' }
  if (target.startsWith('#')) return { kind: 'anchor' }
  return { kind: 'relative' }
}

/** Strips a trailing `#fragment` from a relative link target, if present. */
export function stripFragment(target) {
  const hashIndex = target.indexOf('#')
  return hashIndex === -1 ? target : target.slice(0, hashIndex)
}

// Secret-SHAPE patterns only (mirrors the spirit of scripts/lib in the P160 branch's
// public-env-guard, reimplemented minimally here since that branch is not merged). Never matches
// on prose mentioning "secret" — only on actual token shapes.
const SECRET_SHAPE_PATTERNS = [
  { name: 'supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{10,}/ },
  { name: 'supabase publishable/legacy service key with real payload', re: /\bsb_secret\b/ },
  {
    name: 'JWT-shaped token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'generic private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

/** @param {string} text @returns {string[]} names of secret-shaped patterns found (deduped) */
export function findSecretShapes(text) {
  const found = new Set()
  for (const { name, re } of SECRET_SHAPE_PATTERNS) {
    if (re.test(text)) found.add(name)
  }
  return [...found]
}

// A "stale sandbox path" — a temp/scratch directory from an agent session, which must never end
// up committed into durable documentation (it's meaningless to a later session or another machine).
const SANDBOX_PATH_RE =
  /AppData\\Local\\Temp\\claude\\|\/tmp\/claude\/|\\scratchpad\\|\/scratchpad\//

/** @param {string} text @returns {boolean} true if the text references an agent scratch/temp path */
export function referencesSandboxPath(text) {
  return SANDBOX_PATH_RE.test(text)
}
