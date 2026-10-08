import globals from 'globals';

export default [
  {
    files: ['script.js', 'products.js'],
    languageOptions: { globals: globals.browser, ecmaVersion: 'latest' },
    rules: {
      'array-callback-return': 'error',
      'eqeqeq': ['error', 'always'],
      'no-console': 'error',
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