import { AccessDeniedError } from "#/features/access/server/access-cache";
import { requireAdmin } from "#/features/access/server/require-admin";
import { systemPermission } from "#/features/access/system-rbac";
import {
	BodyLimitExceededError,
	readBoundedRequestJson,
} from "#/lib/bounded-stream";
import { DomainError } from "#/lib/domain-error";
import { bindServiceSupplier } from "./service-binding";

export async function handleServiceBindingRequest(
	request: Request,
	db: D1Database,
) {
	// Route handlers are outside the server-function CSRF filter.
	if (request.headers.get("origin") !== new URL(request.url).origin)
		return Response.json({ code: "origin_rejected" }, { status: 403 });
	try {
		const [user] = await Promise.all([
			requireAdmin(request, systemPermission("suppliers", "update")),
			requireAdmin(request, systemPermission("products", "update")),
		]);
		const input = await readBoundedRequestJson(request, 8192);
		return Response.json(
			await bindServiceSupplier(db, input, { actorUserId: user.id }),
		);
	} catch (error) {
		const status =
			error instanceof AccessDeniedError
				? error.status
				: error instanceof DomainError
					? error.status
					: error instanceof BodyLimitExceededError
						? 413
						: 400;
		return Response.json(
			{
				code:
					error instanceof DomainError
						? error.code
						: error instanceof AccessDeniedError
							? "access_denied"
							: "invalid_request",
			},
			{ status },
		);
	}
}
