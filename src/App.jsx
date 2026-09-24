import { useCallback, useEffect, useRef, useState } from 'react';
import OceanCanvas from './components/OceanCanvas.jsx';
import './styles.css';

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

function Arrow({ down = false, className = '' }) {
  return (
    <svg className={className} width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {down ? <path d="M12 3v17m-7-7 7 7 7-7" /> : <path d="M4 12h15m-6-6 6 6-6 6" />}
    </svg>
  );
}

function OceanMark() {
  return (
    <svg width="73" height="30" viewBox="0 0 73 30" fill="none" aria-hidden="true">
      <path d="M2 19c11 2 18-13 30-10 8 1 15 11 29 8C45 27 38 9 25 14 15 18 10 22 2 19Z" fill="currentColor" />
      <path d="M18 19c11-4 19 7 31 5 9-1 15-5 22-9-8 10-21 16-34 9-6-4-12-7-19-5Z" fill="currentColor" />
    </svg>
  );
}

function HeroTypography() {
  return (
    <>
      <p className="hero__eyebrow">FEEL THE WORLD SLOW DOWN</p>
      <div className="hero__title">Closer to<br />the ocean.</div>
      <p className="hero__description">A moment of stillness.<br />An endless sense of possibility.</p>
    </>
  );
}

function WaterDistortion() {
  return (
    <svg className="filter-definitions" aria-hidden="true" width="0" height="0">
      <defs>
        <filter id="underwater-refraction" x="-8%" y="-12%" width="116%" height="124%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.008 0.027" numOctaves="2" seed="11" result="ripple" />
          <feDisplacementMap in="SourceGraphic" in2="ripple" scale="7" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  );
}

export default function App() {
  const rootRef = useRef(null);
  const dryRef = useRef(null);
  const wetRef = useRef(null);
  const progressRef = useRef(0);
  const waterAwareRef = useRef([]);
  const distortionRef = useRef(null);
  const [paused, setPaused] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('paused') === '1'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const measureComponents = () => {
      waterAwareRef.current = Array.from(rootRef.current?.querySelectorAll('[data-water-aware]') ?? [], (element) => {
        const rect = element.getBoundingClientRect();
        return {
          element,
          x: clamp((rect.left + rect.width / 2) / window.innerWidth),
          y: (rect.top + rect.height / 2) / window.innerHeight,
          amount: Number(element.dataset.waterAware) || 1,
        };
      });
    };
    measureComponents();
    distortionRef.current = rootRef.current?.querySelector('feTurbulence');
    const onKey = (event) => {
      if (event.code !== 'Space' || event.target !== document.body) return;
      event.preventDefault();
      setPaused((value) => !value);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', measureComponents);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', measureComponents);
    };
  }, []);

  const scrollTo = useCallback((progress) => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const total = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: total * progress, behavior: reducedMotion ? 'instant' : 'smooth' });
  }, []);

  const handleFrame = useCallback((frame) => {
    const root = rootRef.current;
    if (!root) return;
    const { progress = 0, time = 0, immersion = 0, drift = {}, waterline = [] } = frame;
    progressRef.current = progress;
    root.style.setProperty('--progress', progress.toFixed(4));
    root.style.setProperty('--immersion', immersion.toFixed(4));
    root.style.setProperty('--drift-x', `${drift.x ?? 0}px`);
    root.style.setProperty('--drift-y', `${drift.y ?? 0}px`);
    root.style.setProperty('--drift-rotation', `${drift.rotation ?? 0}deg`);
    root.dataset.deep = String(progress > 0.73);
    root.dataset.return = String(progress > 0.88);

    if (waterline.length > 1) {
      const points = Array.from(waterline, (height, index) =>
        `${(index / (waterline.length - 1) * 100).toFixed(3)}% ${(clamp(height) * 100).toFixed(3)}%`);
      if (dryRef.current) dryRef.current.style.clipPath = `polygon(0% 0%, 100% 0%, ${points.slice().reverse().join(', ')})`;
      if (wetRef.current) wetRef.current.style.clipPath = `polygon(${points.join(', ')}, 100% 100%, 0% 100%)`;

      for (const { element, x, y, amount } of waterAwareRef.current) {
        const index = Math.min(waterline.length - 1, Math.round(x * (waterline.length - 1)));
        const localImmersion = clamp((y - waterline[index] + 0.025) / 0.05);
        element.style.setProperty('--local-x', `${(drift.x ?? 0) * localImmersion * amount}px`);
        element.style.setProperty('--local-y', `${(drift.y ?? 0) * localImmersion * amount}px`);
        element.style.setProperty('--local-rotation', `${(drift.rotation ?? 0) * localImmersion * amount}deg`);
        element.dataset.wet = String(localImmersion > 0.5);
      }
    }
    if (distortionRef.current) {
      const horizontalFrequency = 0.0075 + Math.sin(time * 0.32) * 0.0009;
      const verticalFrequency = 0.026 + Math.cos(time * 0.27) * 0.0017;
      distortionRef.current.setAttribute('baseFrequency', `${horizontalFrequency.toFixed(5)} ${verticalFrequency.toFixed(5)}`);
    }
  }, []);

  const handleReady = useCallback(() => setReady(true), []);
  const handleError = useCallback((message) => {
    setError(message || 'The ocean could not load.');
    setReady(true);
  }, []);

  return (
    <main className="ocean-experience" ref={rootRef} data-ready={ready} data-deep="false" data-return="false">
      <a className="skip-link" href="#ocean-controls">Skip to ocean controls</a>
      <OceanCanvas paused={paused} onFrame={handleFrame} onReady={handleReady} onError={handleError} />
      <WaterDistortion />

      <div className="scene-ui">
        <div className="announcement" data-water-aware="0.18">
          <span>A new perspective begins here.</span><Arrow />
        </div>
        <header className="site-header" aria-label="Main navigation">
          <button className="brand water-aware" type="button" data-water-aware="0.27" onClick={() => scrollTo(0)} aria-label="Ocean — return to the surface">
            <OceanMark /><span>OCEAN</span>
          </button>
          <nav className="main-nav water-aware" data-water-aware="0.2" aria-label="Explore the ocean">
            <button type="button" onClick={() => scrollTo(0)}>The surface</button>
            <button type="button" onClick={() => scrollTo(1)}>A little deeper</button>
          </nav>
          <button className="header-explore water-aware" type="button" data-water-aware="0.4" onClick={() => scrollTo(1)}>
            Explore now <Arrow />
          </button>
        </header>

        <div className="hero-visual hero-visual--dry" ref={dryRef} aria-hidden="true">
          <div className="hero__content"><HeroTypography /></div>
        </div>
        <div className="hero-visual hero-visual--wet" ref={wetRef} aria-hidden="true">
          <div className="hero__content"><HeroTypography /></div>
        </div>
        <section className="hero-interaction" aria-labelledby="ocean-title">
          <h1 id="ocean-title" className="sr-only">Closer to the ocean.</h1>
          <p className="sr-only">A moment of stillness. An endless sense of possibility. Scroll to travel from the surface into the ocean.</p>
          <div className="hero__content">
            <div className="hero__layout-spacer" aria-hidden="true"><HeroTypography /></div>
            <div className="hero__actions water-aware" data-water-aware="0.72">
              <button className="primary-action" type="button" onClick={() => scrollTo(progressRef.current > 0.88 ? 0 : 1)}>
                <span className="action-dive">Explore the ocean</span>
                <span className="action-return">Return to the surface</span>
                <Arrow />
              </button>
              <span className="hero__invitation">Take a breath. Dive in.</span>
            </div>
          </div>
        </section>

        <div className="depth-marker" aria-hidden="true">
          <span>01</span><div className="depth-marker__track"><i /></div><span>02</span>
        </div>
        <div className="below-caption water-aware" data-water-aware="0.65" aria-hidden="true">
          BELOW THE SURFACE
        </div>

        <footer className="scene-footer" id="ocean-controls">
          <div className="playback water-aware" data-water-aware="0.35">
            <button className="playback__toggle" type="button" aria-label={paused ? 'Play ocean motion' : 'Pause ocean motion'} aria-pressed={paused} onClick={() => setPaused((value) => !value)}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                {paused ? <path d="m9 6 9 6-9 6V6Z" fill="currentColor" /> : <path d="M9 6v12m6-12v12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
              </svg>
            </button>
            <span>{paused ? 'A MOMENT OF STILLNESS' : 'LIVE AT SEA'}</span>
          </div>
          <button className="scroll-cue water-aware" type="button" data-water-aware="0.35" onClick={() => scrollTo(progressRef.current > 0.88 ? 0 : 1)}>
            <span className="action-dive">SCROLL TO EXPLORE</span>
            <span className="action-return">BACK TO THE SURFACE</span>
            <Arrow down className="scroll-cue__arrow" />
          </button>
        </footer>
      </div>

      {!ready && <div className="scene-loading" role="status"><OceanMark /><span>A moment by the ocean</span><i /></div>}
      {error && <div className="scene-error" role="alert"><p>The ocean is taking a little longer.</p><span>Refresh the page to try again.</span><button type="button" onClick={() => window.location.reload()}>Try again <Arrow /></button></div>}
    </main>
  );
}
