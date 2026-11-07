module.exports = [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'readonly', exports: 'readonly',
        __dirname: 'readonly', __filename: 'readonly',
        process: 'readonly', console: 'readonly',
        Buffer: 'readonly', setTimeout: 'readonly', setInterval: 'readonly',
        clearTimeout: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly', clearImmediate: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^err$|^e$|^next$', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-constant-condition': 'warn',
      'no-debugger': 'error',
      'no-duplicate-case': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-extra-semi': 'warn',
      'no-unreachable': 'warn',
      'eqeqeq': ['warn', 'smart'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    files: ['src/__tests__/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly', it: 'readonly', test: 'readonly',
        expect: 'readonly', beforeAll: 'readonly', afterAll: 'readonly',
        beforeEach: 'readonly', afterEach: 'readonly', jest: 'readonly',
      },
    },
  },
  // Frontend (public/js/): single rule guarding the v5.0 promise that
  // inline event handlers (onclick=, onchange=, etc.) are NOT used.
  // CSP relies on this — `script-src-attr 'none'` would break otherwise.
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', console: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly',
        fetch: 'readonly', WebSocket: 'readonly', URL: 'readonly',
        FormData: 'readonly', Blob: 'readonly', File: 'readonly',
        setTimeout: 'readonly', setInterval: 'readonly',
        clearTimeout: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        Event: 'readonly', CustomEvent: 'readonly', MouseEvent: 'readonly',
        XMLHttpRequest: 'readonly', alert: 'readonly', confirm: 'readonly',
        prompt: 'readonly', location: 'readonly', history: 'readonly',
        navigator: 'readonly', getComputedStyle: 'readonly',
      },
    },
    rules: {
      // The only frontend rule we enforce — no inline handlers, ever.
      // Reason: CSP `script-src-attr 'none'` blocks them; v5.0 milestone.
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/on(click|change|submit|input|keyup|keydown|mouseover|mouseout|focus|blur|load|error)\\s*=\\s*[\"']/]",
          message: 'Inline event handlers (onclick=, onchange=, etc.) are forbidden in template strings — use addEventListener after render. CSP `script-src-attr none` blocks them at runtime.',
        },
        {
          selector: "TemplateElement[value.raw=/on(click|change|submit|input|keyup|keydown|mouseover|mouseout|focus|blur|load|error)\\s*=\\s*[\"']/]",
          message: 'Inline event handlers (onclick=, onchange=, etc.) are forbidden in template literals — use addEventListener after render. CSP `script-src-attr none` blocks them at runtime.',
        },
      ],
    },
  },
];
