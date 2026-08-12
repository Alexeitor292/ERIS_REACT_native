// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // *.test.ts run under Node's built-in test runner (node --test), not RN.
    ignores: ['dist/*', '**/*.test.ts'],
  },
  {
    // Field-facing incident copy intentionally uses normal contractions (for
    // example "phone's") in JSX text. Keep the exception local to this screen;
    // all other Expo/React lint rules remain active.
    files: ['src/components/CreateIncidentScreen.tsx'],
    rules: {
      'react/no-unescaped-entities': 'off',
    },
  },
]);
