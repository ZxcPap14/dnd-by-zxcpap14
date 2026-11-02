// Минимальный линтер: только то, что реально ловит ошибки в этом коде.
// Без @eslint/js и типов — конфиг один файл, правил немного.
export default [
  { ignores: ['dist/**', 'docs/**', 'node_modules/**', '*.bak', '.wrangler/**', 'server/relay-worker.mjs'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', localStorage: 'readonly',
        navigator: 'readonly', location: 'readonly', fetch: 'readonly',
        Image: 'readonly', Audio: 'readonly', AudioContext: 'readonly',
        RTCPeerConnection: 'readonly', WebSocket: 'readonly', Event: 'readonly',
        CustomEvent: 'readonly', requestAnimationFrame: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', console: 'readonly',
        process: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        FormData: 'readonly', Blob: 'readonly', TextEncoder: 'readonly',
        TextDecoder: 'readonly', crypto: 'readonly', performance: 'readonly',
        Buffer: 'readonly', globalThis: 'readonly', AbortController: 'readonly',
        Headers: 'readonly', Response: 'readonly', Request: 'readonly',
        getComputedStyle: 'readonly', queueMicrotask: 'readonly',
        HTMLDetailsElement: 'readonly', WebSocketPair: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-cond-assign': 'error',
      'no-self-assign': 'error',
      'no-var': 'error',
      eqeqeq: ['warn', 'smart'],
      'prefer-const': 'warn'
    }
  }
];
