import { inMemoryProvider } from "@afora/core";

const base = inMemoryProvider();

/** A provider created without `providerOf`: it cannot be described, only imported. */
export const anonymous = {
	findOne: (...args: Parameters<typeof base.findOne>) => base.findOne(...args),
	findMany: (...args: Parameters<typeof base.findMany>) =>
		base.findMany(...args),
	insert: (...args: Parameters<typeof base.insert>) => base.insert(...args),
	update: (...args: Parameters<typeof base.update>) => base.update(...args),
	remove: (...args: Parameters<typeof base.remove>) => base.remove(...args),
	count: (...args: Parameters<typeof base.count>) => base.count(...args),
};
