import globals from 'globals';

export default [
  { ignores: ['public/vendor/**', 'dist/**'] },
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: globals.browser, ecmaVersion: 'latest', sourceType: 'module' },
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
    files: ['src/**/*.mjs', 'test/**/*.mjs', 'scripts/**/*.mjs'],
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