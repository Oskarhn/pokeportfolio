/**
 * P185 accessibility-tree analysis for the device drivers. Pure functions over uiautomator nodes
 * (see android-adb.mjs parseNodes), so the rules are testable without a device.
 *
 * Why a SWEEP and not one snapshot: uiautomator reports only what is on screen right now. P184's
 * 360 dp / 200 % lookup read the viewport left over after its own scrolling, so the heading and the
 * confidence badge — scrolled out of the window — were "not found" although they were present.
 * Here every node is judged where it was best visible across the whole scroll range.
 */

const idOf = (n) => n.id.replace(/^.*:id\//, '')

/** React Native maps accessibilityRole to these Android classes; the sweep must cover all of them. */
export const INTERACTIVE_CLASSES = [
  'android.widget.Button',
  'android.widget.RadioButton',
  'android.widget.CheckBox',
  'android.widget.Switch',
  'android.widget.ToggleButton',
]

/** App-owned interactive nodes: clickable or one of the interactive classes, with a testID. */
export function isInteractive(n) {
  if (n.bounds === null || n.bounds === undefined) return false
  const id = idOf(n)
  if (id === '' || /^(content|action_bar|p184-)/.test(id)) return false
  return n.clickable || INTERACTIVE_CLASSES.includes(n.cls)
}

export function roleOf(n) {
  if (n.cls === 'android.widget.RadioButton') return 'radio'
  if (n.cls === 'android.widget.CheckBox') return 'checkbox'
  if (n.cls === 'android.widget.Switch' || n.cls === 'android.widget.ToggleButton') return 'switch'
  if (n.cls === 'android.widget.Button') return 'button'
  return n.clickable ? 'clickable' : 'other'
}

function visibleFraction(b, area) {
  const w = b.x2 - b.x1
  const h = b.y2 - b.y1
  if (w <= 0 || h <= 0) return 0
  const ix = Math.max(0, Math.min(b.x2, area.x2) - Math.max(b.x1, area.x1))
  const iy = Math.max(0, Math.min(b.y2, area.y2) - Math.max(b.y1, area.y1))
  return (ix * iy) / (w * h)
}
const intersects = (a, b) => {
  const ix = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)
  const iy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1)
  return ix > 4 && iy > 4
}

/** The touchable area of one dump: the content root, above the tab bar. */
export function viewportOf(nodes, screenW) {
  const content = nodes.find((n) => idOf(n) === 'content')?.bounds
  const tabTop = Math.min(
    ...nodes.filter((n) => n.bounds && idOf(n).startsWith('tab-')).map((n) => n.bounds.y1),
    Number.POSITIVE_INFINITY,
  )
  return {
    x1: 0,
    x2: screenW,
    y1: content?.y1 ?? 0,
    y2: Number.isFinite(tabTop) ? tabTop : (content?.y2 ?? 99999),
    tabTop: Number.isFinite(tabTop) ? tabTop : null,
  }
}

/**
 * @param {Array<Array<object>>} dumps one dump per scroll position
 * @param {{dpi: number, width: number, minDp?: number}} env
 */
export function auditSweep(dumps, { dpi, width, minDp = 48 }) {
  const dp = dpi / 160
  const minPx = Math.floor((minDp - 1) * dp) // 1 dp of rounding tolerance
  const best = new Map() // key -> { node, fraction, dumpIndex }
  const all = new Map() // key -> first node seen (any visibility), for text lookups
  dumps.forEach((nodes, dumpIndex) => {
    const vp = viewportOf(nodes, width)
    for (const n of nodes) {
      if (!n.bounds) continue
      const key = `${idOf(n)}|${n.text}|${n.desc}`
      if (!all.has(key)) all.set(key, { node: n, dumpIndex })
      if (!isInteractive(n)) continue
      if (vp.tabTop !== null && idOf(n).startsWith('tab-')) continue
      const fraction = visibleFraction(n.bounds, vp)
      const cur = best.get(key)
      if (!cur || fraction > cur.fraction) best.set(key, { node: n, fraction, dumpIndex, vp })
    }
  })
  const interactive = [...best.values()].filter(({ node }) => !idOf(node).startsWith('tab-'))
  const unreachable = interactive.filter((x) => x.fraction < 0.99).map((x) => idOf(x.node))
  const small = interactive
    .filter(({ node, fraction }) => {
      if (fraction < 0.99) return false // reported as unreachable instead
      const b = node.bounds
      return b.x2 - b.x1 < minPx || b.y2 - b.y1 < minPx
    })
    .map(({ node }) => ({
      id: idOf(node),
      role: roleOf(node),
      w: Math.round((node.bounds.x2 - node.bounds.x1) / dp),
      h: Math.round((node.bounds.y2 - node.bounds.y1) / dp),
    }))
  const unlabeled = interactive
    .filter(({ node }) => node.text === '' && node.desc === '')
    .map(({ node }) => idOf(node))
  const offscreenX = interactive
    .filter(({ node }) => node.bounds.x1 < 0 || node.bounds.x2 > width)
    .map(({ node }) => idOf(node))
  // Overlap / footer obstruction: judged within the dump where each node was best visible.
  const overlaps = []
  const obstructed = []
  dumps.forEach((nodes, i) => {
    const vp = viewportOf(nodes, width)
    const here = interactive.filter((x) => x.dumpIndex === i && x.fraction >= 0.99)
    for (let a = 0; a < here.length; a += 1) {
      if (vp.tabTop !== null && here[a].node.bounds.y2 > vp.tabTop + 4)
        obstructed.push(idOf(here[a].node))
      for (let b = a + 1; b < here.length; b += 1) {
        const A = here[a].node
        const B = here[b].node
        if (intersects(A.bounds, B.bounds)) overlaps.push([idOf(A), idOf(B)])
      }
    }
  })
  const roles = {}
  for (const { node } of interactive) roles[roleOf(node)] = (roles[roleOf(node)] ?? 0) + 1
  return {
    interactive: interactive.length,
    roles,
    unreachable,
    small,
    unlabeled,
    offscreenX,
    overlaps,
    obstructed,
    screens: dumps.length,
    all: [...all.values()].map((x) => ({ ...x.node, dumpIndex: x.dumpIndex })),
  }
}

/** First node (in any dump) whose text or description matches `re`, with the dump it was in. */
export function textSeen(audit, re) {
  const hit = audit.all.find((n) => re.test(n.text) || re.test(n.desc))
  return hit ? { text: hit.text || hit.desc, dumpIndex: hit.dumpIndex } : null
}

/** Internal identifiers a person must never hear: a UUID, or a model/similarity score. */
export const LEAK =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|similarity|cosine|score\s*[:=]?\s*0?\.\d/i

export function leaks(audit) {
  return audit.all
    .filter((n) => LEAK.test(n.text) || LEAK.test(n.desc))
    .map((n) => (n.text || n.desc).slice(0, 80))
}

export const CONFIDENCE_WORDS = {
  high: /High confidence/,
  review_medium: /Needs confirmation/,
  review_low: /Low confidence/,
}
