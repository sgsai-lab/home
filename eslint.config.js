import globals from 'globals';

export default [
  {
    files: ['app.js', 'script.js', 'products.js', 'components/**/*.js', 'sections/**/*.js'],
    languageOptions: { globals: globals.browser, ecmaVersion: 'latest' },
    rules: {
      'array-callback-return': 'error',
      'eqeqeq': ['error', 'always'],
      'no-console': ['error', { allow: ['error'] }],
      'no-implicit-coercion': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error'
    }
  },
  {
    files: ['server.mjs', 'test/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: globals.node, ecmaVersion: 'latest' },
    rules: {
      'array-callback-return': 'error',
      'eqeqeq': ['error', 'always'],
      'no-console': ['error', { allow: ['error', 'log'] }],
      'no-implicit-coercion': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error'
    }
  }
];