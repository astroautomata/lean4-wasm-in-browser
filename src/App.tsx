import './App.css'

const destinations = [
  { title: 'Start here: The Visual Natural Numbers Game', description: 'Prove the fundamental properties of arithmetic from scratch!', href: '/lean4game/index.html#/g/local/NNG4/visual', accent: 'violet', symbol: '∀' },
  { title: 'Elevator Pitch', description: "Take a brief tour of Visual Lean's three modes.", href: '/lean4game/index.html#/g/local/VisualTest/visual', accent: 'teal', symbol: '→' },
  { title: 'The Natural Numbers Game Classic', description: 'Play the Natural Numbers Game as it was originally designed, typing Lean code yourself.', href: '/lean4game/index.html#/g/local/NNG4', accent: 'blue', symbol: 'ℕ' },
] as const

function App() {
  return (
    <main className="landing-page">
      <section className="landing-hero" aria-labelledby="site-title">
        <div className="hero-mark" aria-hidden="true"><span>⊢</span></div>
        <h1 id="site-title">Visual Lean</h1>
        <p>An experimental graphical user interface for writing Lean code.</p>
        <p>Lean verification runs locally on both desktop and mobile through WASM.</p>
      </section>

      <nav className="destination-list" aria-label="Visual Lean experiences">
        {destinations.map((destination, index) => (
          <a className={`destination destination-${destination.accent}`} href={destination.href} key={destination.href}>
            <span className="destination-number" aria-hidden="true">0{index + 1}</span>
            <span className="destination-copy">
              <span className="destination-title">{destination.title}</span>
              <span className="destination-description">{destination.description}</span>
            </span>
            <span className="destination-symbol" aria-hidden="true">{destination.symbol}</span>
            <span className="destination-arrow" aria-hidden="true">↗</span>
          </a>
        ))}
      </nav>

      <footer className="credits" id="credits">
        <h2 className="credits-heading">Credits</h2>
        <p>Visual Lean was designed and orchestrated by <a href="https://autumnofautumn.com/">Autumn Mapes</a> under the advisement of <a href="https://gowers.wordpress.com/">Timothy Gowers</a>, <a href="https://astroautomata.com/">Miles Cranmer</a>, and <a href="https://www.damtp.cam.ac.uk/user/mjc249/home.html">Matthew Colbrook</a>.</p>
        <p>Visual Lean was coded with the help of Codex and Claude Code.</p>
        <p>Visual Lean is built on a WASM port of Lean 4, <a href="https://github.com/cauli/lean4-wasm-in-browser">Lean4.js</a>.</p>
        <p>The Natural Numbers Game was originally designed by Kevin Buzzard and Mohammad Pedramfar for Lean 3, and later ported to Lean 4 by Kevin Buzzard and Jon Eugster.</p>
        <p>The code for Visual Lean can be found <a href="https://github.com/ryyanmapes/lean4game">publically on Github</a>. Visual Lean is distributed with a license info tbd</p>
      </footer>
    </main>
  )
}

export default App
