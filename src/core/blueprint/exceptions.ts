import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";

/** A plugin declares a key the blueprint context reserves; `source` is the plugin name. */
export const ReservedBlueprintKey = exceptionOf({
	layer: ExceptionLayers.Blueprint,
	name: "ReservedBlueprintKey",
	message: ({ key }: { readonly key: string }) =>
		`"${key}" is reserved and cannot be a plugin property.`,
});

/** `variantOf` was given something it cannot make a field of; `reason` says what. */
export const InvalidBlueprintVariant = exceptionOf({
	layer: ExceptionLayers.Blueprint,
	name: "InvalidBlueprintVariant",
	message: ({
		key,
		reason,
	}: {
		readonly key: string;
		readonly reason: string;
	}) => `The variant field of key "${key}" cannot be declared: ${reason}.`,
});

/** A blueprint picks a key that no plugin provides. */
export const UndeclaredBlueprintProperty = exceptionOf({
	layer: ExceptionLayers.Blueprint,
	name: "UndeclaredBlueprintProperty",
	message: ({ key }: { readonly key: string }) =>
		`Property "${key}" of the blueprint is not declared.`,
});
