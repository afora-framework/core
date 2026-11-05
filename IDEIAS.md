# Afora — ideias e visão de produto

Registro das ideias discutidas em 26 e 27 de outubro de 2026.

Este documento descreve uma direção de evolução, não uma lista de recursos já implementados nem um compromisso de entrega. Os nomes de APIs apresentados são conceituais. As questões técnicas ao final permanecem abertas.

## Visão

Construir um produto baseado no Afora que permita criar, estender e operar aplicações por código, por uma definição JSON, por um painel e por agentes de IA conectados através de MCP.

A proposta começa com a construção de backends completos e complexos, executados em um PaaS, e pode evoluir para incluir a criação de interfaces web conectadas aos mesmos contratos e operações.

O Afora seria a base de modelagem e execução. O produto reuniria essa base, um catálogo de plugins, ferramentas de autoria e a infraestrutura de publicação e operação.

## Novas abstrações

As próximas ideias para a biblioteca incluem:

| Ideia          | Papel a explorar                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Command**    | Declarar e compor operações específicas da aplicação. Definir sua relação com os use-cases existentes.                            |
| **Singleton**  | Oferecer compartilhamento de instâncias e controle de ciclo de vida, com escopo ainda a definir.                                  |
| **Repository** | Conectar operações e entidades à persistência por contratos substituíveis.                                                        |
| **Strategy**   | Permitir selecionar e substituir políticas ou implementações de comportamento.                                                    |
| **Output**     | Organizar a saída da aplicação e sua representação para consumidores. Definir sua relação com o contrato de resposta do use-case. |

Essas abstrações devem apoiar a composição da aplicação. Suas APIs e garantias ainda precisam ser desenhadas.

## Command builder com contexto de capacidades

Criar um `commandBuilder` que receba uma entidade e bibliotecas de use-cases padrão ou genéricos, permitindo construir operações bem específicas.

A experiência de composição deve se parecer com o `ctx` de `blueprintOf`: o usuário acessa um contexto com capacidades disponíveis e seleciona os use-cases que deseja utilizar.

Assinatura conceitual:

```ts
commandBuilder(Entity, [StandardUseCases, CustomUseCases], (ctx) => {
	// Selecionar e compor os use-cases disponíveis no contexto.
});
```

O builder deve considerar o conjunto de dependências dos use-cases selecionados para permitir construir e executar o comando resultante.

Objetivos:

- Reutilizar comportamentos genéricos em casos de uso específicos.
- Oferecer descoberta das capacidades pelo contexto e pelo autocomplete.
- Preservar os contratos e a inferência de tipos durante a composição.
- Permitir bibliotecas padrão e bibliotecas fornecidas pelo usuário.
- Organizar as dependências necessárias ao conjunto de operações selecionadas.

Ainda é necessário definir se a seleção disponibiliza capacidades para uma implementação explícita ou também declara um fluxo executado automaticamente. Ordem, passagem de dados, ramificações e tratamento de falhas dependem dessa escolha.

## Representação da aplicação em JSON

Permitir exportar a aplicação inteira para um formato JSON e construir uma aplicação a partir desse formato.

A definição deve poder representar os elementos declarativos da aplicação, como:

- Plugins utilizados e suas versões.
- Propriedades, blueprints e entidades.
- Use-cases, comandos e sua composição.
- Dependências, configurações e referências a implementações.
- Interfaces e suas conexões com operações, quando a camada web existir.

A intenção é que código e JSON sejam caminhos de autoria compatíveis, permitindo inspecionar, compartilhar e reconstruir a aplicação.

### Limite a resolver

JSON representa dados e relações, mas não transporta automaticamente implementações arbitrárias de funções TypeScript. Comportamentos personalizados precisam de uma representação declarativa ou de referências a implementações disponíveis em plugins.

Portanto, o significado de “aplicação inteira” precisa distinguir:

- A definição da aplicação.
- Os plugins e implementações necessários para executá-la.
- A configuração e os recursos fornecidos pelo ambiente.
- Os dados persistidos, cuja inclusão em exportações ainda não foi definida.

## Plugins de propriedades e use-cases

Criar um formato de plugins que forneça propriedades e use-cases reutilizáveis. O usuário poderá estender as capacidades disponíveis para o desenvolvimento por JSON instalando ou registrando esses plugins.

Os plugins formariam o catálogo acessível tanto pelo `ctx` quanto pelas referências presentes no JSON.

Dois caminhos de extensão:

1. **Por código:** criar novas propriedades, comportamentos e integrações em um plugin.
2. **Por JSON:** configurar e combinar as capacidades oferecidas pelos plugins para definir uma aplicação específica.

Um plugin de comércio, por exemplo, poderia oferecer propriedades de dinheiro e SKU, além de operações para calcular totais ou reservar estoque. Esse exemplo ilustra a proposta; não define uma biblioteca padrão já planejada.

Para apoiar ferramentas e IA, os plugins precisam expor contratos inspecionáveis: identificadores, versões, configurações, entradas, saídas e dependências.

## Produto: painel, PaaS e MCP

Construir um produto no qual o usuário possa criar um backend completo usando Afora, com painel de gerenciamento, hospedagem em um PaaS e acesso por MCP.

| Componente  | Responsabilidade pretendida                                              |
| ----------- | ------------------------------------------------------------------------ |
| **Afora**   | Modelagem, contratos, composição e execução dos comportamentos.          |
| **Plugins** | Capacidades reutilizáveis e extensões de domínio ou infraestrutura.      |
| **JSON**    | Definição exportável e reconstruível da aplicação.                       |
| **Painel**  | Criação, edição, inspeção, configuração e acompanhamento das aplicações. |
| **MCP**     | Acesso estruturado para agentes de IA criarem e modificarem backends.    |
| **PaaS**    | Publicação, execução e operação das aplicações.                          |

### Autoria por IA

O MCP deve permitir que a IA conheça as capacidades disponíveis e construa backends complexos com elas.

O fluxo pretendido inclui descobrir plugins, declarar entidades, selecionar e compor use-cases, conectar dependências e preparar a aplicação para execução.

Validação, testes, revisões e diagnóstico são capacidades a considerar para que o agente consiga corrigir suas alterações e para que o usuário consiga compreender o resultado.

Uma direção arquitetural discutida é fazer painel e MCP utilizarem a mesma API de gerenciamento e a mesma definição versionada da aplicação, mantendo as alterações visíveis e editáveis por ambos.

## Expansão para Web e criação de interfaces

Permitir que o Afora também seja utilizado na criação de interfaces, com integração a React, Vue, Angular e Svelte.

A ambição vai além de consumir uma API: permitir declarar a interface com Afora e conectá-la às propriedades, contratos e operações da aplicação.

Três capacidades a explorar:

1. **Contratos compartilhados:** utilizar tipos e validações apropriados tanto no cliente quanto no servidor.
2. **Conexão com operações:** chamar comandos e apresentar seus estados, resultados e erros na interface.
3. **Definição visual:** descrever páginas, formulários, tabelas, componentes, ações e navegação.

Uma possível arquitetura é manter um modelo de interface independente de framework e oferecer adaptadores de renderização para cada integração.

As definições visuais também poderiam ser exportadas e construídas por JSON. Plugins poderiam futuramente fornecer componentes e comportamentos de interface junto às capacidades de domínio.

### Relação entre domínio e apresentação

Os contratos do domínio podem orientar campos, validações e ações, mas a apresentação precisa de definições próprias: rótulos, layout, visibilidade, navegação e componentes personalizados.

O mesmo contrato pode ser utilizado por diferentes interfaces. A proposta deve preservar essa liberdade e permitir que uma alteração de contrato revele quais interfaces precisam ser ajustadas.

O código enviado ao navegador deve conter somente as capacidades destinadas ao cliente. Persistência privilegiada, segredos e decisões de autorização continuam sendo responsabilidades do servidor.

## Experiência pretendida de ponta a ponta

```text
Plugins de propriedades e use-cases
                 ↓
Definição de entidades e composição de comandos
                 ↓
Aplicação descrita por código ou JSON
                 ↓
Autoria e inspeção pelo painel ou por IA via MCP
                 ↓
Backend publicado no PaaS
                 ↓
Interfaces conectadas aos contratos e operações
```

O usuário deve conseguir construir a aplicação com capacidades reutilizáveis, acrescentar comportamentos específicos e alternar entre as ferramentas de autoria sem perder a consistência dos contratos.

## Decisões em aberto

- Qual é a diferença precisa entre Command e UseCase?
- O `commandBuilder` recebe uma classe/definição de entidade ou uma instância?
- Como declarar ordem, passagem de dados, condições e paralelismo entre operações?
- Como reunir dependências transitivas e resolver conflitos de nomes ou de escopo?
- Como substituir uma capacidade genérica por uma implementação específica?
- Como representar comportamentos personalizados no processo de exportação e importação?
- Como versionar o JSON, os plugins e os contratos entre aplicações?
- Quais garantias de transação, concorrência, idempotência e entrega de eventos o runtime oferecerá?
- Como tratar autenticação, autorização, isolamento, segredos e migrações no PaaS?
- Como revisar, testar e publicar mudanças feitas por pessoas ou agentes?
- A camada visual interpretará definições em runtime, gerará código ou oferecerá os dois caminhos?
- Como garantir consistência de comportamento entre os adaptadores web?

## Experimentos sugeridos na discussão

Estas são sugestões de validação, não prioridades ou compromissos já aprovados:

1. Compor comandos distintos a partir das mesmas capacidades e testar substituição de dependências.
2. Declarar uma operação em TypeScript, exportá-la para JSON, reconstruí-la e verificar o mesmo comportamento.
3. Criar um plugin externo ao núcleo e utilizá-lo pelos dois caminhos de autoria.
4. Publicar um backend de escopo delimitado com persistência, autorização e tratamento de falhas.
5. Conectar um formulário ao contrato de um comando e executar o fluxo completo.
6. Validar a camada de UI em um framework e depois em um segundo, antes de ampliar o suporte.

O objetivo desses experimentos é comprovar a composição entre as peças e descobrir os limites da API antes de ampliar a plataforma.
