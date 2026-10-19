import {resolve} from 'node:path';
const config = {
  // Fingerprint before any compiler cache, so cached output retains its old hash.
  plugins: {[resolve('scripts/css-source.mjs')]: {}, "@tailwindcss/postcss": {}},
};

export default config;
