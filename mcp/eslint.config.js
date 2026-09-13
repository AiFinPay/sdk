import js from "@eslint/js";
import globals from "globals";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
  js.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: [
      "node_modules",
      "dist",
      "coverage",
      "*.log",
      "**/*.mjs",
    ],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        fetch: "readonly",
        Response: "readonly",
        Request: "readonly",
        WebSocket: "readonly",
        Buffer: "readonly",
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "no-empty": "off",
      "no-unused-vars": "off",
      "no-console": "off",
      "no-regex-spaces": "off",
      "no-octal": "off",
    },
  },
];
