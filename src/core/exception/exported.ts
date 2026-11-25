import * as Application from "../application/exceptions";
import * as Blueprint from "../blueprint/exceptions";
import * as Command from "../command/exceptions";
import * as Entity from "../entity/exceptions";
import * as Environment from "../environment/environment";
import * as EventPolicy from "../event-policy/exceptions";
import * as Log from "../logger/exceptions";
import * as OpenAPI from "../openapi/exceptions";
import * as Output from "../output/exceptions";
import * as Property from "../property/exceptions";
import * as RecordKeys from "../record/exceptions";
import * as Repository from "../repository/exceptions";
import * as Tracing from "../tracing/exceptions";
import * as UseCaseSteps from "../use-case/exceptions";
import * as UseCase from "../use-case/use-case";
import { isMarkedExported, markExported } from "./exported-mark";

/**
 * The exceptions the package exports, to tell a use case's `errors` that need
 * no registration. The core lists the modules that declare them; modules the
 * core cannot import (`std`) add theirs with `markExported` (`exported-mark.ts`), so the core
 * never reaches into `std`, and those modules do not reach the ones listed here.
 */
let collected = false;

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
			EventPolicy,
			Log,
			OpenAPI,
			Output,
			Property,
			RecordKeys,
			Repository,
			Tracing,
			UseCase,
			UseCaseSteps,
		]) {
			markExported(...Object.values(module));
		}
	}
	return isMarkedExported(Declared);
}
