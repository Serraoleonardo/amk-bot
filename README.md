# Bot AMK Amazonika

Bot de atendimento e vendas via WhatsApp para a AMK Amazonika, feito como
extensão voluntária do projeto de extensão da UCB.

## O que ele faz

- **Atende clientes** em conversa livre pelo WhatsApp, usando Claude para
  entender o pedido, consultar o estoque (Google Sheets) e fechar vendas.
- **Reconhece o Edeilton** pelo número de telefone dele: quando ele avisa
  sobre uma venda física (ex: "vendi 2 gengibre agora"), o bot interpreta a
  mensagem e dá baixa automaticamente no estoque da planilha.

## Arquitetura

```
WhatsApp  <-->  Evolution API  <-->  Bot (Node.js/Express)  <-->  Claude API
                                            |
                                            v
                                     Google Sheets (estoque)
```

- `src/server.js` — recebe os webhooks da Evolution API e decide se a
  mensagem é do Edeilton (admin) ou de um cliente.
- `src/claudeAssistant.js` — conversa com o Claude, com duas "personas"
  (atendente de vendas / assistente do Edeilton) e ferramentas para
  consultar e atualizar o estoque.
- `src/sheetsClient.js` — lê e atualiza a planilha do Google Sheets.
- `src/evolutionClient.js` — envia mensagens de volta pelo WhatsApp.

## Como colocar no ar

Na Railway: [`RAILWAY.md`](./RAILWAY.md). Em VPS próprio: [`SETUP.md`](./SETUP.md) — cobre desde
criar o servidor até testar o bot funcionando.

## Rodando localmente (para testes/desenvolvimento)

```bash
npm install
cp .env.example .env
# preencha o .env com suas chaves
npm start
```

Isso sobe só o servidor Node — você ainda precisa de uma Evolution API
rodando em algum lugar (local via Docker ou já no servidor) apontando o
webhook para este servidor.

## Testando localmente (sem WhatsApp, sem Google)

O modo `mock` guarda o estoque em `data/estoque.json`.

```bash
npm install
npm test                 # testes offline da lógica de estoque (sem API)
cp .env.example .env     # preencha só ANTHROPIC_API_KEY para os chats abaixo
npm run chat             # você conversa como CLIENTE
npm run chat:admin       # você conversa como EDEILTON ("vendi 2 gengibre")
```

Depois confira em `data/estoque.json` se as quantidades mudaram.
Em produção, não defina `STOCK_BACKEND`: o bot usa o Google Sheets.
