import {resolve} from 'node:path';
const config = {
  plugins: {"@tailwindcss/postcss": {}, [resolve('scripts/css-source.mjs')]: {}},
};

export default config;
