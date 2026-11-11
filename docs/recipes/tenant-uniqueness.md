# Uniqueness across tenants

A slug must be unique inside a tenant, not in the whole table: two tenants can both have `home`.

```ts
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
```

`unique` names single keys, and a `Slug` property is unique on its own, which is why the slug here is a plain string. For a rule over two values, keep a key that holds both (`slugKey`, `"<tenantId>:<slug>"`) and declare that key unique. The repository then enforces it, in memory and in any provider, and generates `findBySlugKey`. The static `scoped` is the one place that builds the three values, so they cannot disagree.

A duplicate in the same tenant throws `RepositoryUniqueViolation` with `details.key` set to `"slugKey"`, which an output answers with 409. `findManyByTenantId` lists the pages of one tenant: `findManyBy<Key>` exists for any key.

More: [Records](../records.md) (`unique`), [Repositories](../repositories.md), [Access](../auth.md) (`owner`, to take the tenant from the caller instead of the input).
