// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // *.test.ts run under Node's built-in test runner (node --test), not RN.
    ignores: ['dist/*', '**/*.test.ts'],
  },
]);
