import { Type } from "typebox";
import { propertyOf } from "../../core/property/property";

export const Email = propertyOf({
	name: "email",
	schema: Type.String({ format: "email", maxLength: 254 }),
	default: "demo@example.com",
	preHandle: (value) => value.trim().toLowerCase(),
});

/** A phone number in E.164; spaces, dots, dashes and parentheses are dropped. */
export const Phone = propertyOf({
	name: "phone",
	schema: Type.String({ pattern: "^\\+[1-9]\\d{1,14}$" }),
	default: "+5511999999999",
	preHandle: (value) => value.replace(/[\s().-]/g, ""),
});

export const Url = propertyOf({
	name: "url",
	schema: Type.String({ format: "url", maxLength: 2048 }),
	default: "https://example.com",
	preHandle: (value) => value.trim(),
});

export const Ip = propertyOf({
	name: "ip",
	schema: Type.Union([
		Type.String({ format: "ipv4" }),
		Type.String({ format: "ipv6" }),
	]),
	default: "127.0.0.1",
	preHandle: (value) => value.trim(),
});
