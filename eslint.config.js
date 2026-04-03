import { fileURLToPath } from "node:url";

import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import ts from "typescript-eslint";

const gitignorePath = fileURLToPath(new URL("./.gitignore", import.meta.url));

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	...ts.configs.recommended,
	prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		},
		plugins: {
			"simple-import-sort": simpleImportSort
		},
		rules: {
			"no-undef": "off",
			"simple-import-sort/imports": "error",
			"simple-import-sort/exports": "error",
			"no-empty-function": "off",
			"@typescript-eslint/no-empty-function": "error",
			"@typescript-eslint/no-inferrable-types": "error"
		}
	},
	{
		files: ["**/*.ts", "**/*.css.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				parser: ts.parser
			}
		},
		// Rules that require type information:
		rules: {
			"@typescript-eslint/no-deprecated": "error",
			"@typescript-eslint/no-unnecessary-condition": "error",
			"@typescript-eslint/no-unnecessary-type-arguments": "error",
			"@typescript-eslint/no-unnecessary-boolean-literal-compare": "error"
		}
	}
);
