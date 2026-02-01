module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
  },
  ignorePatterns: ["node_modules/", "dist/", "build/"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
};
