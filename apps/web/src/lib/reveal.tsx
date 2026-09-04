import { useEffect, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/**
 * Scroll-triggered reveal, done with one shared IntersectionObserver.
 *
 * Observe the block, and when it is *meaningfully* on screen — not the instant
 * its first pixel crosses the fold — flip it from a hidden to a visible state and
 * stop observing. The negative bottom root margin is what buys the "meaningfully";
 * without it, blocks animate while still under the fold and the reader never sees
 * the motion.
 *
 * Everything past that point is CSS (see base.css): the observer only sets
 * `data-in`, and descendants stagger off their own `--i`. No scroll listener,
 * no per-frame work, nothing to clean up but the observer entry.
 */

/* Armed only once JS is running. Without this the hidden state would be baked
   into the stylesheet and a failed bundle would leave a blank page. */
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-reveal', 'on')
}

let io: IntersectionObserver | null = null

function observer(): IntersectionObserver {
  if (io) return io
  io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.setAttribute('data-in', '')
        io?.unobserve(entry.target)
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0 },
  )
  return io
}

/** Ref for a block whose descendants should reveal when it scrolls into view. */
function useReveal<T extends Element>() {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // No IntersectionObserver (or a very old engine): show everything at once.
    if (typeof IntersectionObserver === 'undefined') {
      el.setAttribute('data-in', '')
      return
    }
    const obs = observer()
    obs.observe(el)
    return () => obs.unobserve(el)
  }, [])
  return ref
}

/** A plain block that arms its `.rise` descendants when it scrolls into view. */
export function RevealGroup({
  className,
  children,
  style,
  id,
}: {
  className?: string
  children: ReactNode
  style?: CSSProperties
  id?: string
}) {
  const ref = useReveal<HTMLDivElement>()
  return (
    <div ref={ref} className={className} style={style} id={id}>
      {children}
    </div>
  )
}
