import { readdir, readFile } from "node:fs/promises";

// Cache SQL text only. Every test still owns a fresh isolated database.
let migrations: Promise<string[][]> | undefined;

export async function applyMigrations(database: D1Database) {
	migrations ??= readMigrations();
	for (const statements of await migrations) {
		// One transaction per migration preserves statement order and deferred FKs,
		// avoiding hundreds of cross-process calls for each test database.
		if (statements.length)
			await database.batch(statements.map((sql) => database.prepare(sql)));
	}
}

async function readMigrations() {
	const directory = new URL("../../drizzle/", import.meta.url);
	const files = (await readdir(directory))
		.filter((name) => /^\d+_.+\.sql$/.test(name))
		.sort();
	return Promise.all(
		files.map(async (file) =>
			(await readFile(new URL(file, directory), "utf8"))
				.split("--> statement-breakpoint")
				.map((sql) => sql.trim())
				.filter(Boolean),
		),
	);
}
