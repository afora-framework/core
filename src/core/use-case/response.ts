import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import type {
	AnyBlueprint,
	AnyBlueprintList,
	BlueprintListValue,
	BlueprintValue,
	IBlueprint,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { parseField } from "../parse/parse";
import type { ParseResult } from "../parse/types/parse.interface";
import { maskValueOf } from "../record/mask";
import { takeStatus } from "./status";

/**
 * What the `response` of a use case says it gives: the fields of an object
 * blueprint, or a list made by `listOf` (e.g. `listOf(Article)`).
 */
export type UseCaseOutput = IBlueprintCollection | AnyBlueprintList;

/** The `response` of a use case: an object blueprint or a list. */
export type AnyUseCaseResponse = AnyBlueprint | AnyBlueprintList;

/** The `response` declared for `Output`: the list itself, or the blueprint of the fields. */
export type ResponseBlueprint<Output extends UseCaseOutput> =
	Output extends AnyBlueprintList
		? Output
		: IBlueprint<Extract<Output, IBlueprintCollection>>;

/**
 * What the `response` setting takes for `Output`: the blueprint of its fields,
 * or the list it is. Written as a union so that `Output` is inferred from
 * either.
 */
export type ResponseSetting<Output extends UseCaseOutput> =
	| IBlueprint<Extract<Output, IBlueprintCollection>>
	| Extract<Output, AnyBlueprintList>;

/** The value a use case whose response gives `Output` resolves with. */
export type ResponseValue<Output extends UseCaseOutput> =
	Output extends AnyBlueprintList
		? Readonly<BlueprintListValue<Output>>
		: BlueprintValue<Extract<Output, IBlueprintCollection>>;

/**
 * The value of a `response`: of a list, a read-only array of its items
 * (e.g. `readonly Article[]`, frozen at run time); of a blueprint, its object.
 */
export type ResponseOf<Response> = Response extends AnyBlueprintList
	? Readonly<BlueprintListValue<Response>>
	: Response extends { readonly properties: infer Properties }
		? BlueprintValue<Extract<Properties, IBlueprintCollection>>
		: never;

/** Whether `value` can be the `response` of a use case: a non-optional object blueprint or list. */
export function isUseCaseResponse(value: unknown): value is AnyUseCaseResponse {
	return (
		(isBlueprint(value) || isBlueprintList(value)) &&
		(value as { optional: boolean }).optional === false
	);
}

/**
 * `value` handled by `response`: the frozen object a blueprint gives, or the
 * frozen array a list gives, or the issues that reject it (item paths start
 * with the index, e.g. `[1, "title"]`).
 */
export function parseResponse(
	response: AnyUseCaseResponse,
	value: unknown,
): ParseResult<unknown> {
	const parsed = parseField(
		response,
		value,
		[],
		isBlueprintList(response) ? "list" : "blueprint",
		true,
	);
	if (!parsed.issues && typeof parsed.value === "object" && parsed.value) {
		responses.set(parsed.value, response);
	}
	return parsed;
}

/** The `response` each value `parseResponse` gave was handled by. */
const responses = new WeakMap<object, AnyUseCaseResponse>();

/**
 * `value`, what an operation whose response is `response` resolved with (its
 * body, when it carries a status), noted as handled by `response` unless it
 * already is, so that it is sent masked by the response the operation
 * declares even when it is not the value `parseResponse` gave (a copy a
 * transform made of it, say).
 * @internal
 */
export function respondedWith<Value>(
	response: AnyUseCaseResponse | undefined,
	value: Value,
): Value {
	const { body } = takeStatus(value);
	if (
		response !== undefined &&
		typeof body === "object" &&
		body !== null &&
		!responses.has(body)
	) {
		responses.set(body, response);
	}
	return value;
}

/**
 * What `value` sends out of the process: a value `parseResponse` gave, with
 * what is sensitive masked by its response (a `Password` always, the
 * `sensitive` keys of a record's blueprint, at any depth); anything else as
 * it is (a record masks itself through its `toJSON`).
 */
export function responseJsonOf(value: unknown): unknown {
	const response =
		typeof value === "object" && value !== null
			? responses.get(value)
			: undefined;
	return response === undefined ? value : maskValueOf(response, value);
}

/**
 * The fields of the object `response`, or `undefined` for a list, which has
 * no keys of its own.
 */
export function responsePropertiesOf(
	response: AnyUseCaseResponse,
): IBlueprintCollection | undefined {
	return isBlueprintList(response) ? undefined : response.properties;
}
