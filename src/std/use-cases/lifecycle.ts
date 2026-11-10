import { listOf } from "../../core/blueprint/list";
import type { BlueprintField } from "../../core/blueprint/types/blueprint.interface";
import { UseCaseEntityNotFound } from "../../core/use-case/exceptions";
import { useCasePluginOf } from "../../core/use-case/plugin";
import type {
	UseCaseCompilation,
	UseCaseTargetInfo,
} from "../../core/use-case/types/plugin.interface";
import {
	asOf,
	checkOptions,
	contextOf,
	entityUseCase,
	errorOf,
	fields,
	idOf,
	literal,
	loadSteps,
	metaOf,
	type Options,
	ownerOf,
	type Step,
	valuesOf,
} from "./shared";
import type { ArchiveMaker, PublishMaker, TagMaker } from "./types";

/**
 * A use case that calls `method` of the entity of an id and stores it,
 * after the changes of the option `set`, each to a change key.
 */
function invoking(
	target: UseCaseTargetInfo,
	options: Options,
	verb: string,
	method: string,
): UseCaseCompilation {
	const set = valuesOf(target, options, "set");
	const changes: Step[] = Object.entries(set).map(([key, value]) => {
		if (!target.changeKeys.includes(key)) {
			target.unavailable(`set.${key} is not a change key of the entity`);
		}
		return { change: "$item", key, value: literal(value) };
	});
	return entityUseCase(target, options, verb, ["set"], () => ({
		steps: [
			...changes,
			{ invoke: "$item", method },
			{ update: "repository", value: "$item", as: "saved" },
		],
		result: "$saved",
	}));
}

const lifecycle = (plugin: string) => ({
	requires: { actions: ["findById", "update"], plugins: [plugin] },
});

/** Publishes the entity of an id. */
export const publish = useCasePluginOf<"publish", PublishMaker>("publish", {
	description: "Publishes the publishable entity of an id and stores it.",
	...lifecycle("publishable"),
	compile: (target, options) => invoking(target, options, "Publish", "publish"),
});

/** Makes the entity of an id a draft again. */
export const unpublish = useCasePluginOf<"unpublish", PublishMaker>(
	"unpublish",
	{
		description:
			"Makes the publishable entity of an id a draft again and stores it.",
		...lifecycle("publishable"),
		compile: (target, options) =>
			invoking(target, options, "Unpublish", "unpublish"),
	},
);

/** Archives the entity of an id. */
export const archive = useCasePluginOf<"archive", ArchiveMaker>("archive", {
	description: "Archives the archivable entity of an id and stores it.",
	...lifecycle("archivable"),
	compile: (target, options) => invoking(target, options, "Archive", "archive"),
});

/** Makes the archived entity of an id active again. */
export const unarchive = useCasePluginOf<"unarchive", ArchiveMaker>(
	"unarchive",
	{
		description:
			"Makes the archived entity of an id active again and stores it.",
		...lifecycle("archivable"),
		// The record plugin calls it `restore`; the use case of that name is
		// the one of soft deletion.
		compile: (target, options) =>
			invoking(target, options, "Unarchive", "restore"),
	},
);

/** A use case that calls `tag` or `untag` with the tags of the input. */
function tagging(
	target: UseCaseTargetInfo,
	options: Options,
	verb: string,
	method: string,
): UseCaseCompilation {
	checkOptions(target, options, ["as", "owner"]);
	const owner = ownerOf(target, options);
	const notFound = errorOf(target, options, "notFound", UseCaseEntityNotFound);
	const { item } = target.field("tags").field as unknown as {
		readonly item: BlueprintField;
	};
	return {
		...metaOf(target, options, verb),
		blueprint: fields(() => ({
			id: idOf(target),
			tags: listOf(item, { minItems: 1 }),
		})),
		response: fields(() => ({ [asOf(target, options)]: target.entity })),
		...contextOf(owner),
		dependencies: { repository: target.repository },
		errors: [notFound],
		steps: [
			...loadSteps(owner, notFound),
			{ invoke: "$item", method, args: "$input.tags" },
			{ update: "repository", value: "$item", as: "saved" },
			{ return: { [asOf(target, options)]: "$saved" } },
		],
	};
}

/** Adds tags to the entity of an id. */
export const tag = useCasePluginOf<"tag", TagMaker>("tag", {
	description: "Adds tags to the taggable entity of an id and stores it.",
	...lifecycle("taggable"),
	compile: (target, options) => tagging(target, options, "Tag", "tag"),
});

/** Removes tags from the entity of an id. */
export const untag = useCasePluginOf<"untag", TagMaker>("untag", {
	description: "Removes tags from the taggable entity of an id and stores it.",
	...lifecycle("taggable"),
	compile: (target, options) => tagging(target, options, "Untag", "untag"),
});
