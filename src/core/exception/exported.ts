import * as Application from "../application/exceptions";
import * as Blueprint from "../blueprint/exceptions";
import * as Command from "../command/exceptions";
import * as Entity from "../entity/exceptions";
import * as Environment from "../environment/environment";
import * as OpenAPI from "../openapi/exceptions";
import * as Output from "../output/exceptions";
import * as Property from "../property/exceptions";
import * as RecordKeys from "../record/exceptions";
import * as Repository from "../repository/exceptions";
import * as UseCaseSteps from "../use-case/exceptions";
import * as UseCase from "../use-case/use-case";
import { isDeclaredException } from "./exception";

/**
 * The exceptions the package exports, to tell a use case's `errors` that need
 * no registration. The core lists the modules that declare them; modules the
 * core cannot import (`std`) add theirs with `markExported`, so the core
 * never reaches into `std`.
 */
const exported = new WeakSet<object>();
let collected = false;

/** Counts `Exception` classes the package exports from a module the core cannot import. */
export function markExported(...classes: readonly unknown[]): void {
	for (const Declared of classes) {
		if (isDeclaredException(Declared)) exported.add(Declared);
	}
}

/** Whether `Declared` is an exception class exported by the package. */
export function isExportedException(Declared: unknown): boolean {
	if (!collected) {
		collected = true;
		for (const module of [
			Application,
			Blueprint,
			Command,
			Entity,
			Environment,
			OpenAPI,
			Output,
			Property,
			RecordKeys,
			Repository,
			UseCase,
			UseCaseSteps,
		]) {
			markExported(...Object.values(module));
		}
	}
	return typeof Declared === "function" && exported.has(Declared);
}
