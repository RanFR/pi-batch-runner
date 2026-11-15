// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
	{ ignores: ["node_modules/", "dist/", "coverage/"] },
	eslint.configs.recommended,
	tseslint.configs.recommended,
	// Prettier owns formatting; keep lint output free of formatting noise.
	eslintConfigPrettier,
	{
		rules: {
			// Array-index `!` is the idiomatic counterpart of noUncheckedIndexedAccess
			// (tsconfig); avoid blanket bans and rely on review for genuinely
			// unnecessary assertions.
			"@typescript-eslint/no-non-null-assertion": "off",
			// The extension API and test fakes intentionally shape-match pi types.
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-empty-object-type": "off",
		},
	},
);
