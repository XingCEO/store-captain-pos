'use strict';

const globals = {
  // Node
  process: 'readonly', Buffer: 'readonly', __dirname: 'readonly', __filename: 'readonly',
  module: 'writable', require: 'readonly', exports: 'writable', global: 'readonly',
  console: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setImmediate: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', crypto: 'readonly',
};

const browserGlobals = {
  window: 'readonly', document: 'readonly', fetch: 'readonly', localStorage: 'readonly',
  sessionStorage: 'readonly', navigator: 'readonly', location: 'readonly',
  alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
  HTMLElement: 'readonly', Event: 'readonly', CustomEvent: 'readonly',
  FormData: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', requestAnimationFrame: 'readonly',
  console: 'readonly', crypto: 'readonly',
};

const swGlobals = {
  self: 'readonly', caches: 'readonly', indexedDB: 'readonly', IDBKeyRange: 'readonly',
  fetch: 'readonly', Request: 'readonly', Response: 'readonly', Headers: 'readonly',
  URL: 'readonly', clients: 'readonly', skipWaiting: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', console: 'readonly',
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'public/lib/qrcode.js',
      '.playwright-mcp/**',
      'migrations/**',
      'scripts/load/**',
    ],
  },
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals,
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-redeclare': 'error',
      'eqeqeq': ['warn', 'smart'],
    },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: swGlobals },
    rules: { 'no-unused-vars': 'warn', 'no-undef': 'error' },
  },
  {
    files: ['public/**/*.js'],
    ignores: ['public/sw.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: browserGlobals },
    rules: { 'no-unused-vars': 'warn', 'no-undef': 'error' },
  },
];
