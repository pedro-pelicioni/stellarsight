import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { StellarsightMark } from '../components/Marks'

/**
 * The catch-all. The SPA rewrite in vercel.json answers 200 for every path, so the page
 * itself has to say that nothing lives here — to the reader, and to crawlers via `noindex`.
 */
export default function NotFound() {
  const { pathname } = useLocation()
  useEffect(() => {
    const previous = document.title
    document.title = 'Not found — STELLARSIGHT'
    // The rewrite answers 200, so the page has to tell crawlers itself that it is not one.
    const robots = document.createElement('meta')
    robots.name = 'robots'
    robots.content = 'noindex'
    document.head.appendChild(robots)
    return () => {
      document.title = previous
      robots.remove()
    }
  }, [])

  return (
    <div className="theme">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <span className="grain" aria-hidden="true" />

      <header className="topbar topbar--solid">
        <div className="shell topbar__in">
          <Link className="topbar__mark" to="/" aria-label="STELLARSIGHT home">
            <StellarsightMark />
            <span>STELLARSIGHT</span>
          </Link>
          <nav className="topbar__nav" aria-label="Sections">
            <Link to="/">Home</Link>
            <Link to="/console">Console</Link>
            <Link to="/playground">Playground</Link>
            <Link to="/explorer">Explorer</Link>
          </nav>
        </div>
      </header>

      <main id="main" className="shell" style={{ padding: '6rem 0 8rem' }}>
        <span className="label">404</span>
        <h1 className="console__title">
          Nothing is listed at <em>{pathname}</em>.
        </h1>
        <p className="xp-lede">
          The pages that exist: the <Link to="/">landing</Link>, the{' '}
          <Link to="/console">discovery console</Link>, the <Link to="/explorer">settlement explorer</Link>{' '}
          and the <Link to="/playground">playground</Link>. The discovery API lives under{' '}
          <code>/discovery/*</code> and answers a wrong path there in JSON, naming the endpoints that exist.
        </p>
      </main>
    </div>
  )
}
