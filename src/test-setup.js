/**
 * Global test setup for Vitest.
 * - Loads @testing-library/jest-dom matchers (toBeInTheDocument, etc.)
 * - Stubs browser globals that components rely on but jsdom does not provide.
 */
import '@testing-library/jest-dom/vitest';

// Provide __APP_VERSION__ and __BUILD_TIME__ (injected by Vite at build time)
globalThis.__APP_VERSION__ = 'test';
globalThis.__BUILD_TIME__ = '2024-01-01T00:00:00.000Z';

// Provide a localStorage/sessionStorage shim if not available (node env)
// or if the existing one lacks .clear()
function ensureStorage(name) {
  if (typeof globalThis[name] === 'undefined' || typeof globalThis[name].clear !== 'function') {
    const store = {};
    globalThis[name] = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      clear: () => { for (const k in store) delete store[k]; },
      get length() { return Object.keys(store).length; },
      key: (i) => Object.keys(store)[i] ?? null,
    };
  }
}
ensureStorage('localStorage');
ensureStorage('sessionStorage');

// Minimal matchMedia stub (needed by some CSS-in-JS / responsive code)
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// Stub canvas getContext (jsdom doesn't ship a real canvas)
if (typeof window !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function () {
    return {
      fillRect: () => {},
      clearRect: () => {},
      getImageData: () => ({ data: [] }),
      putImageData: () => {},
      createImageData: () => ([]),
      setTransform: () => {},
      drawImage: () => {},
      save: () => {},
      fillText: () => {},
      restore: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      stroke: () => {},
      translate: () => {},
      scale: () => {},
      rotate: () => {},
      arc: () => {},
      fill: () => {},
      measureText: () => ({ width: 0 }),
      transform: () => {},
      rect: () => {},
      clip: () => {},
      font: '',
      textAlign: '',
      textBaseline: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineCap: '',
      lineJoin: '',
      globalAlpha: 1,
      globalCompositeOperation: '',
      setLineDash: () => {},
      getLineDash: () => [],
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
    };
  };
}
