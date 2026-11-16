import {
	applicationOf,
	blueprintOf,
	commandOf,
	outputOf,
	serviceOf,
	useCaseOf,
} from "@afora/core";
import { hono } from "@afora/hono";

// Where files go: S3, R2, a disk. Only the use case knows it is there.
export interface Storage {
	put(key: string, file: Blob): Promise<string>; // gives the public URL
}
const StorageService = serviceOf<Storage>("storage");

class UploadAvatar extends useCaseOf({
	name: "UploadAvatar",
	blueprint: blueprintOf((ctx) => ({
		userId: ctx.string,
		avatar: ctx.fileOf({
			types: ["image/png", "image/jpeg"],
			maxBytes: 1_000_000,
		}),
	})),
	response: blueprintOf((ctx) => ({ url: ctx.url, bytes: ctx.integer })),
	route: { method: "put", path: "/users/{userId}/avatar" },
	dependencies: { storage: StorageService },
}) {
	override async execute() {
		const { userId, avatar } = this.input;
		const url = await this.dependencies.storage.put(
			`avatars/${userId}`,
			avatar,
		);
		return { url, bytes: avatar.size }; // what was made of the file, not the file
	}
}

const Users = commandOf({
	name: "Users",
	useCases: { uploadAvatar: UploadAvatar },
});
const Api = outputOf({ name: "Api", commands: [Users], pipe: [hono({})] });

export const appWith = (storage: Storage) =>
	applicationOf({
		name: "avatars",
		useCases: { UploadAvatar },
		commands: { Users },
		outputs: { Api },
		services: { storage: () => storage },
	});
