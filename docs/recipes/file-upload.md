# Uploading a file to a storage

You want an endpoint that takes an image in a `multipart/form-data` body, checks it, puts it in a storage (S3, R2, a disk) and answers where it went, without the use case knowing which storage it is.

```ts
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
```

`ctx.fileOf({ types, maxBytes })` makes `avatar` a file of the input. Every HTTP sink reads it from a multipart body, checks its type and size against the declaration, and checks that a file declared as a PNG or JPEG starts with the bytes of one; anything else is a 400 with an issue at `avatar`, before `execute` runs. The OpenAPI document describes the body as a form.

The storage is a [service](../use-cases.md#services): `serviceOf<Storage>("storage")` declares it, and the application makes it with `services`, once per call (the factory gets the context, the caller and the environments, for a bucket name or a key). In a test, give it in memory, as here, or pass it to one call with `execute({ storage })`.

Two things to know. An entity cannot hold a file (`EntityHoldsFile`): store the URL or the key on the entity, and the response gives what was made of the file, since a `Blob` serializes as `{}`. And the size of the whole body is the server's limit to set (Fastify's `bodyLimit`, a limit in front of Hono or Express); `maxBytes` checks each file once it is read.

More: [Files](../std-properties.md#files), [Outputs](../outputs.md) (how a multipart body is read), [Services](../use-cases.md#services), [Troubleshooting](../troubleshooting.md#uploads-415-413-invalidfilecontent).
