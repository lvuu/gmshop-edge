import { createFileRoute } from "@tanstack/react-router";
import { handleDhruSupplierCallback } from "#/features/suppliers/server/dhru-callback";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/suppliers/dhru/callback/$accountId")(
	{
		server: {
			handlers: {
				POST: async ({ request, params }) => {
					const { DB } = getCloudflareEnv(request);
					if (!DB) return Response.json({ ok: false }, { status: 503 });
					return handleDhruSupplierCallback(request, params.accountId, DB);
				},
			},
		},
	},
);
