export const examples = [
	{
		name: "Primeiros passos",
		description: "Normalização e records",
		code: `import { blueprintOf, recordOf } from "@afora/core";

const Profile = blueprintOf((ctx) => ({
  name: ctx.string,
  email: ctx.email,
  slug: ctx.slug,
}));

class User extends recordOf(Profile, { change: ["name"] }) {}

const user = new User({
  name: "Ana",
  email: "  ANA@EXAMPLE.COM  ",
  slug: "Olá mundo!",
});

console.log("Valores normalizados", user.toJSON());
user.change.name("Ana Reis");
console.log("Depois da mudança", user.toJSON());

// Experimente user. para explorar os métodos disponíveis.
`,
	},
	{
		name: "Validação",
		description: "Resultados e erros por campo",
		code: `import { blueprintOf, Email } from "@afora/core";

console.log("Email válido", Email.safeParse("  ANA@EXAMPLE.COM  "));
console.log("Email inválido", Email.safeParse("isso não é um email"));

const Input = blueprintOf((ctx) => ({
  email: ctx.email,
  age: ctx.integer,
}));

console.log("Problemas de entrada", Input.safeParse({ email: "ops", age: "vinte" }));
`,
	},
	{
		name: "Dados sensíveis",
		description: "Hashing real com Bun e masking",
		code: `import { blueprintOf, Password, recordOf } from "@afora/core";

class Account extends recordOf(blueprintOf((ctx) => ({
  email: ctx.email,
  password: ctx.password,
}))) {}

const password = await Password.hash("Str0ng!Pass");
const account = new Account({ email: "ana@example.com", password: password.value });

console.log("Saída pública", account.toJSON());
console.log("JSON", JSON.stringify(account));
console.log("Senha confere?", await password.verify("Str0ng!Pass"));
`,
	},
	{
		name: "Entidades e eventos",
		description: "Identidade e mudanças de estado",
		code: `import { blueprintOf, entityOf, eventOf, type EventDefinition } from "@afora/core";

class User extends entityOf(
  blueprintOf((ctx) => ({ name: ctx.string })),
  { change: ["name"], onUpdate: () => Renamed },
) {}

const Renamed: EventDefinition = eventOf("user.renamed", User, async (user) => {
  console.log("Evento recebido", user.name);
});

const user = new User({ name: "Ana" });
console.log("Nova entidade", user.toJSON());
user.change.name("Ana Reis");
console.log("Entidade atualizada", user.toJSON());
console.log("Eventos pendentes", user.pullEvents());
`,
	},
	{
		name: "Repositório",
		description: "Persistência em memória e busca tipada",
		code: `import { blueprintOf, entityOf, repositoryOf } from "@afora/core";

class User extends entityOf(
  blueprintOf((ctx) => ({ name: ctx.string, email: ctx.email })),
  { unique: ["email"] },
) {}

const users = repositoryOf({
  entity: User,
  actions: ["create", "findByEmail", "count"],
});

await users.create({ name: "Ana", email: "ANA@example.com" });
console.log("Busca", (await users.findByEmail("ana@example.com"))?.toJSON());
console.log("Total", await users.count());
`,
	},
	{
		name: "Caso de uso",
		description: "Entrada, execução e resposta",
		code: `import { blueprintOf, entityOf, useCaseOf } from "@afora/core";

const Input = blueprintOf((ctx) => ({ name: ctx.string, email: ctx.email }));
class User extends entityOf(Input) {}

class Register extends useCaseOf({
  name: "Register",
  blueprint: Input,
  response: blueprintOf(() => ({ user: User })),
}) {
  override async execute() {
    return { user: new User(this.input) };
  }
}

const operation = new Register({ name: "Ana", email: "ANA@example.com" });
console.log("Resposta", await operation.execute());
`,
	},
	{
		name: "Exceções em camadas",
		description: "Origem e caminho do erro",
		code: `import { Email, ExceptionLayers, guard } from "@afora/core";

guard({ layer: ExceptionLayers.Output, source: "POST /users" }, () =>
  guard({ layer: ExceptionLayers.UseCase, source: "Register" }, () => {
    return new Email("email inválido");
  }),
);
`,
	},
];
