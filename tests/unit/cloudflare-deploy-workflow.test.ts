import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("gates production mutations on checks of the exact main commit", () => {
	const workflow = parse(
		readFileSync(
			new URL("../../.github/workflows/deploy-cloudflare.yml", import.meta.url),
			"utf8",
		),
	);
	const job = workflow.jobs.deploy;
	expect(job.if).toBe(
		"github.repository == 'lvuu/gmshop-edge' && github.ref == 'refs/heads/main'",
	);
	expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
	// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub evaluates this literal expression.
	expect(job.steps[0].with.ref).toBe("${{ github.sha }}");
	const gateIndex = job.steps.findIndex((step: { run?: string }) =>
		step.run?.includes("bun run typecheck"),
	);
	const gate = job.steps[gateIndex];
	expect(gateIndex).toBeGreaterThan(0);
	for (const command of [
		"generate-paraglide",
		"typecheck",
		"check",
		"test",
		"build",
		"build:bun",
	])
		expect(gate.run.split("\n")).toContain(`bun run ${command}`);
	expect(gate["continue-on-error"]).toBeUndefined();
	expect(gate.env).toBeUndefined();
	expect(job["continue-on-error"]).toBeUndefined();
	const preparationIndex = job.steps.findIndex(
		(step: { run?: string }) => step.run === "bun run predeploy",
	);
	const deploymentIndex = job.steps.findIndex(
		(step: { run?: string }) => step.run === "bun run deploy",
	);
	expect(preparationIndex).toBeGreaterThan(gateIndex);
	expect(deploymentIndex).toBeGreaterThan(preparationIndex);
});
