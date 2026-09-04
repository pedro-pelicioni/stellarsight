import React, { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import Landing from './routes/Landing'
import Console from './routes/Console'
import NotFound from './routes/NotFound'
import './styles/base.css'
import './styles/sight.css'
import './styles/pages.css'
import './styles/playground.css'

/**
 * The playground carries the Stellar SDK and the x402 packages so it can sign a payment
 * in the browser. That is most of a megabyte nobody reading the landing page needs, so it
 * loads on demand. The explorer is small but shares the split for symmetry.
 */
const Playground = lazy(() => import('./routes/Playground'))
const Explorer = lazy(() => import('./routes/Explorer'))

const Loading = () => (
  <div className="theme">
    <main className="shell" style={{ padding: '6rem 0', color: 'var(--fg-3)' }}>
      <span className="label">loading…</span>
    </main>
  </div>
)

const router = createBrowserRouter([
  { path: '/', element: <Landing /> },
  { path: '/console', element: <Console /> },
  {
    path: '/playground',
    element: (
      <Suspense fallback={<Loading />}>
        <Playground />
      </Suspense>
    ),
  },
  {
    path: '/explorer',
    element: (
      <Suspense fallback={<Loading />}>
        <Explorer />
      </Suspense>
    ),
  },
  { path: '*', element: <NotFound /> },
])

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
