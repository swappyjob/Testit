// Ketcher bundles an SVG dependency (raphael) that loads itself via a UMD-style
// `require('raphael')` call. In Vite's ESM output there is no global `require`,
// so this crashes at runtime with "require is not defined". We provide a minimal
// global `require` that resolves raphael from the bundle. This module MUST be
// imported BEFORE ketcher-react so the shim exists when Ketcher initialises.
import Raphael from 'raphael';

if (typeof window !== 'undefined' && typeof window.require !== 'function') {
  window.require = (name) => {
    if (name === 'raphael') return Raphael;
    // Ketcher's other require() calls are wrapped in try/catch or feature-guarded,
    // so throwing lets them fall back to their intended browser path.
    throw new Error('require() is not available for module: ' + name);
  };
}
