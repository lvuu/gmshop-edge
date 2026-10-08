import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
		// Miniflare-backed D1 suites must not start concurrently; parallel
		// isolates contend for the local runtime and produce nondeterministic
		// hook/test timeouts. Test files remain independently runnable.
		fileParallelism: false,
		maxWorkers: 1,
		reporters: ["verbose"],
		exclude: [
			...configDefaults.exclude,
			"tests/unit/server/node-data-operations.test.ts",
			"tests/unit/server/node-runtime-adapters.test.ts",
			"tests/unit/server/node-server-runtime.test.ts",
		],
		coverage: { reporter: ["text", "json"] },
	},
});
