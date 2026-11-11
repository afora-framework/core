import { blueprintOf, entityOf, repositoryOf } from "@afora/core";

// `unique: ["slug"]` would be global. A slug unique per tenant is a unique
// key built from both: `slugKey` holds "<tenantId>:<slug>".
export class Page extends entityOf(
	blueprintOf((ctx) => ({
		tenantId: ctx.string,
		slug: ctx.string, // not ctx.slug: that one is unique on its own
		slugKey: ctx.string,
	})),
	{ unique: ["slugKey"] },
) {
	static scoped(tenantId: string, slug: string) {
		return { tenantId, slug, slugKey: `${tenantId}:${slug}` };
	}
}

export const Pages = repositoryOf({
	entity: Page,
	actions: ["create", "findBySlugKey", "findManyByTenantId"],
});

export const createPage = (tenantId: string, slug: string) =>
	Pages.create(Page.scoped(tenantId, slug));
