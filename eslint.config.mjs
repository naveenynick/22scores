import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescriptConfig from "eslint-config-next/typescript";

/**
 * Flat ESLint config. eslint-config-next 16 ships native flat-config arrays,
 * so they are spread directly (no FlatCompat shim needed).
 */
const config = [
  {
    ignores: [".next/**", "node_modules/**", "drizzle/**", "next-env.d.ts"],
  },
  ...coreWebVitals,
  ...typescriptConfig,
  {
    rules: {
      // `_`-prefixed parameters are deliberately unused (stub overrides).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];

export default config;
