import { createFileRoute } from "@tanstack/react-router";
import { handleServiceBindingRequest } from "#/features/suppliers/server/service-binding-api";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/admin/suppliers/service-binding")({
	server: {
		handlers: {
			POST: ({ request }) => {
				const { DB } = getCloudflareEnv(request);
				if (!DB)
					return Response.json(
						{ code: "service_unavailable" },
						{ status: 503 },
					);
				return handleServiceBindingRequest(request, DB);
			},
		},
	},
});
