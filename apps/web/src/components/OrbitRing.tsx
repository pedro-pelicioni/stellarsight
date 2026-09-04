import type { CSSProperties } from 'react'
import { DottedGlobe } from './DottedGlobe'
import '../styles/orbit.css'

/**
 * Concentric rings of labelled nodes turning around one centre.
 *
 * Why it is here: STELLARSIGHT's argument for the Bazaar is that there is exactly ONE
 * public index, and every client — whatever transport it speaks — comes to the
 * same catalog. This draws that sentence: the centre is the index (the existing
 * `DottedGlobe`, reused rather than rewritten), and the things in orbit are the
 * real surfaces that call it — the two resource kinds the catalog holds, and the
 * four MCP tools the server exposes. Nothing is invented for decoration; every
 * label on a ring also appears as text elsewhere on the page, because this block
 * is `aria-hidden` and must never be the only place a fact is stated.
 *
 * The technique, and why there is no JavaScript loop:
 *
 *   1. Each node hangs off an `.orbit__arm` — an absolutely positioned box the
 *      size of its ring, given a static `rotate(var(--a))` for its start angle
 *      and one keyframe that carries it to `var(--a) + 360deg`. The arm turns,
 *      so the seat pinned to the top of its box sweeps the circle.
 *   2. The label runs the mirror keyframe (`-a` → `-a - 360deg`) over the same
 *      duration, so it counter-rotates exactly and stays upright the whole way.
 *   3. Ring direction alternates by index, which costs one extra declaration:
 *      `animation-direction: reverse` on both halves of an odd ring reverses the
 *      pair together and leaves the start angles untouched.
 *
 *   Only `transform` animates, on the compositor, with no rAF loop, no layout
 *   and no per-frame JavaScript. `prefers-reduced-motion: reduce` drops the two
 *   animations and the static transforms underneath them hold the composed
 *   arrangement — every node still sits at its own angle, upright and legible.
 *
 * The geometry is the interesting part. Horizontal text on concentric circles
 * collides: a label at 3 o'clock on one ring reaches straight into its
 * neighbour. So the radii are not chosen, they are SOLVED — outward-in, from the
 * width each ring's longest label actually needs:
 *
 *   reserve(ring)  = longest label × CHAR_EM + PAD_EM      (half a chip, in em)
 *   R(outermost)   = 50% − reserve(outermost)
 *   R(i)           = R(i+1) − reserve(i+1) − reserve(i) − GAP_EM
 *
 * which guarantees, at any width, that no chip can reach the next ring's chips
 * and that the outermost chip stops exactly at the component's own edge. Every
 * reserve is in `em` of the label type, and styles/orbit.css sizes that type
 * against the container, so the whole composition holds its proportions instead
 * of being tuned per breakpoint.
 *
 * Solving the radii is necessary but NOT sufficient to keep the page from
 * scrolling sideways: a rotated arm's scrollable-overflow rect is much larger
 * than the arm's visible footprint, and it escapes even when every chip is
 * comfortably inside. `.orbit` therefore also clips — see the note on
 * `overflow` in styles/orbit.css. The arithmetic here is what makes that clip
 * free, because nothing drawn is ever near the edge it clips at.
 */

/** Rings past this are dropped. Three is already the visual ceiling. */
const MAX_RINGS = 3
/** Advance + tracking of one monospace character, halved. DM Mono is 0.6em. */
const CHAR_EM = 0.35
/** Half a chip's padding and border, plus slack for a substituted font. */
const PAD_EM = 0.9
/** Clear air between one ring's chips and the next ring's chips. */
const GAP_EM = 1.2
/** Degrees each ring's start angles are turned, so rings never line up. */
const RING_PHASE = 29

/**
 * The default cast: what actually orbits the Bazaar. The two resource kinds the
 * catalog indexes on the inside, the four MCP tools on the outside — the same
 * four named in the "MCP server" card on the landing page.
 */
const ORBIT_RINGS_DEFAULT: readonly (readonly string[])[] = [
  ['HTTP', 'MCP'],
  ['stellarsight_search', 'stellarsight_browse', 'stellarsight_describe', 'stellarsight_pay'],
]

/** Seconds per revolution, innermost first. Slow, and deliberately unrelated. */
const ORBIT_PERIODS_DEFAULT: readonly number[] = [58, 91, 137]

type LaidRing = {
  labels: readonly string[]
  /** CSS length for the ring's diameter. */
  diameter: string
  /** Seconds per revolution. */
  period: number
  /** Odd rings turn the other way. */
  ccw: boolean
}

type Layout = {
  rings: readonly LaidRing[]
  /** Diameter left for the centre once every ring has taken its reserve. */
  core: string
  /** The same two numbers for the narrow layout, where only the outer ring shows. */
  soloDiameter: string
  soloCore: string
}

/** Half the width of the widest label in a ring, in `em` of the label type. */
function reserveEm(labels: readonly string[]): number {
  let longest = 0
  for (const label of labels) longest = Math.max(longest, label.length)
  return longest * CHAR_EM + PAD_EM
}

/**
 * A diameter, as the container's width less twice an `em` reserve. The floor is
 * not cosmetic: at an absurd width the subtraction goes negative, and `max()`
 * keeps the arrangement degraded-but-drawn instead of collapsed to nothing.
 */
function diameter(reserve: number, floor: string): string {
  return `max(${floor}, calc(100% - ${(reserve * 2).toFixed(3)}em))`
}

function layout(input: readonly (readonly string[])[], periods: readonly number[]): Layout {
  const kept = input
    .map((ring) => ring.map((label) => label.trim()).filter((label) => label.length > 0))
    .filter((ring) => ring.length > 0)
    .slice(0, MAX_RINGS)

  if (kept.length === 0) {
    return { rings: [], core: '0px', soloDiameter: '0px', soloCore: '0px' }
  }

  const reserves = kept.map(reserveEm)
  const last = kept.length - 1

  // Solve outward-in: the outermost ring gets the edge, everything else is
  // pushed in far enough that its chips cannot reach the ring outside it.
  const offsets = new Array<number>(kept.length)
  offsets[last] = reserves[last]
  for (let i = last - 1; i >= 0; i--) {
    offsets[i] = offsets[i + 1] + reserves[i + 1] + reserves[i] + GAP_EM
  }

  const rings: LaidRing[] = kept.map((labels, i) => {
    const raw = periods[i] ?? ORBIT_PERIODS_DEFAULT[i] ?? 60 + i * 34
    const period = Number.isFinite(raw) ? Math.min(600, Math.max(12, raw)) : 60
    return {
      labels,
      diameter: diameter(offsets[i], '2.5rem'),
      period,
      ccw: i % 2 === 1,
    }
  })

  return {
    rings,
    core: diameter(offsets[0] + reserves[0] + GAP_EM, '2rem'),
    // Narrow layout: the inner rings are hidden, so the outer one is re-solved
    // as if it were alone and the centre takes back everything they reserved.
    soloDiameter: diameter(reserves[last], '2.5rem'),
    soloCore: diameter(reserves[last] * 2 + GAP_EM, '2rem'),
  }
}

export type OrbitRingProps = {
  /**
   * Node labels, innermost ring first. Keep them short — the layout reserves
   * room for the longest one on every ring, so a long label costs radius.
   * At most three rings; empty rings and blank labels are dropped.
   */
  rings?: readonly (readonly string[])[]
  /** Seconds per revolution, innermost first. Clamped to 12…600s. */
  periods?: readonly number[]
  /** Points in the centre sphere. Small centre, so fewer than the globe default. */
  points?: number
  className?: string
}

export function OrbitRing({
  rings = ORBIT_RINGS_DEFAULT,
  periods = ORBIT_PERIODS_DEFAULT,
  points = 420,
  className,
}: OrbitRingProps) {
  const laid = layout(rings, periods)
  if (laid.rings.length === 0) return null

  const rootStyle: CSSProperties = {
    ['--core' as string]: laid.core,
    ['--core-solo' as string]: laid.soloCore,
    ['--d-solo' as string]: laid.soloDiameter,
  }

  return (
    <div className={className ? `orbit ${className}` : 'orbit'} style={rootStyle} aria-hidden="true">
      {/* First in source, and below every ring, so that in the degenerate
          floor case a chip passes over the sphere rather than under it. */}
      <span className="orbit__core">
        <DottedGlobe points={points} nodes={5} rpm={0.7} tiltDeg={19} />
      </span>

      {laid.rings.map((ring, i) => {
        const classes = ['orbit__ring']
        if (ring.ccw) classes.push('orbit__ring--ccw')
        if (i === laid.rings.length - 1) classes.push('orbit__ring--outer')
        const ringStyle: CSSProperties = {
          ['--d' as string]: ring.diameter,
          ['--dur' as string]: `${ring.period}s`,
          ['--z' as string]: i + 1,
        }
        return (
          <div className={classes.join(' ')} style={ringStyle} key={`ring-${i}`}>
            {ring.labels.map((label, j) => {
              const angle = (360 / ring.labels.length) * j + i * RING_PHASE
              const armStyle: CSSProperties = { ['--a' as string]: `${angle.toFixed(2)}deg` }
              return (
                <div className="orbit__arm" style={armStyle} key={`${label}-${j}`}>
                  <span className="orbit__seat">
                    <span className="orbit__tag">{label}</span>
                  </span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
