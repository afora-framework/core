# T05: record and entity metadata

The 1.0 plan stopped after T04 on `release/1.0` (commit `1c804c7`).
T01–T04 are present; T05–T33 remain. Before resuming, `bun test` passed
377 tests and `bun run test:type-perf` passed 36 tests and 16 snapshots.

## Public contract

`Meta` is an exported unique symbol. A record instance exposes a read-only,
non-enumerable `[Meta]` getter returning immutable declaration metadata:
`{ blueprint: IBlueprint<Properties>, options: RecordSettings<Properties> }`.
The metadata references the existing class statics. String members `blueprint`
and `options` are removed from instances and can be domain fields. Metadata is
shared by instances of the same declaration and does not appear in spread or JSON.

`RecordValue`, `RecordEffects` and `RecordChange` accept both record instances
(via `Meta`) and classes (via static `blueprint`). Slice input compatibility uses
the instance's metadata rather than a string `blueprint` member.

The fixed reserved record names are `onSet`, `onSetAll`, `set`, `toJSON`, and
the standard Object prototype names. `change` stays conditionally reserved when
change methods are declared. The entity additions stay `destroy`, `isDeleted`,
`equals`, `onDestroy`, `emit`, `pullEvents`, plus the four identity fields.
Subclass and plugin member collisions remain rejected.

## JSON and corresponding generated code

No new spec syntax is needed. These existing fields become legal:

```json
{
  "version": 1,
  "name": "MetadataFields",
  "records": {
    "DetailsRecord": { "fields": { "blueprint": "string", "options": "string" } }
  }
}
```

The generated declaration continues to use the existing builders:

```ts
const Details = blueprintOf((ctx) => ({
  blueprint: ctx.string,
  options: ctx.string,
}));
class DetailsRecord extends recordOf(Details) {}
// value.blueprint and value.options are domain data.
// value[Meta].blueprint === DetailsRecord.blueprint
```

The codegen catalog reads reserved keys from core. Application descriptions,
OpenAPI and plugin composition already read class statics and keep their format.
Tests must cover masking, persistence, equality, plugins, slicing, subclass
collisions, and JSON round trips with these newly allowed names.

## Execution guard

Run the required checks without updating type-performance snapshots. The plan
explicitly says to stop and report if they change. In particular, removal of
the two instance members can intentionally change editor completions; that
still requires reporting before proceeding to T06–T33.
