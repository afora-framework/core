export const hashPassword = (plain: unknown) => `hash:${String(plain)}`;

export const verify = (
	user: { hash: string },
	plain: unknown,
	call: { context?: { requestId?: string } },
) => user.hash === `hash:${String(plain)}` && call.context !== undefined;
