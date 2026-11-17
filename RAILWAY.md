# Deploy na Railway (sem servidor próprio)

Você vai criar **dois serviços** no mesmo projeto da Railway:

1. **Evolution API** (+ Postgres), pelo template pronto da Railway.
2. **amk-bot** (este projeto), vindo de um repositório do GitHub.

## 1. Colocar o código no GitHub

1. Crie um repositório **privado** no GitHub (ex.: `amk-bot`).
2. Envie os arquivos deste projeto. O `.gitignore` já deixa de fora `.env`,
   `credentials/` e `node_modules/`. **Nunca suba chaves para o GitHub.**

## 2. Criar o projeto e a Evolution API

1. Crie conta em railway.com (pode entrar com o GitHub).
2. Abra o template **"Evolution API with Postgres"**:
   https://railway.com/deploy/evolution-api-with-postgres e clique em Deploy.
   Ele cria a Evolution API, o Postgres e um volume em
   `/evolution/instances` (guarda a sessão do WhatsApp entre reinícios).
3. Quando terminar, abra o serviço da Evolution API > aba **Variables** e copie
   o valor de `AUTHENTICATION_API_KEY`. Anote também o **nome do serviço**
   (ex.: `Evolution API`) e o domínio público dele.

## 3. Criar o serviço do bot

1. No mesmo projeto: **New > GitHub Repo** e escolha `amk-bot`. A Railway
   detecta o `Dockerfile` sozinha.
2. No serviço do bot, aba **Variables**, crie:

| Variável | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | sua chave da Anthropic |
| `EVOLUTION_API_URL` | `http://NOME-DO-SERVICO.railway.internal:8080` (nome do serviço da Evolution, sem espaços; confira em Settings > Networking) |
| `EVOLUTION_API_KEY` | o `AUTHENTICATION_API_KEY` copiado no passo 2 |
| `EVOLUTION_INSTANCE` | `amk-amazonika` |
| `ADMIN_PHONE_NUMBER` | `55DDDNUMERO` (Edeilton) |
| `STOCK_BACKEND` | `mock` (só para o primeiro teste) |
| `PIX_KEY` | deixe vazio por enquanto |

3. Em Settings > Networking do bot, **não precisa** gerar domínio público
   (a Evolution fala com ele pela rede interna).
4. O deploy roda sozinho. Em **Deployments > View logs** deve aparecer
   `Servidor do bot AMK Amazonika rodando na porta ...`.

## 4. Conectar o WhatsApp de testes

1. Abra `https://DOMINIO-DA-EVOLUTION/manager` e entre com a
   `AUTHENTICATION_API_KEY`.
2. Crie uma instância chamada **`amk-amazonika`** (canal Baileys).
3. Escaneie o QR code com o número de testes (WhatsApp > Aparelhos
   conectados > Conectar um aparelho).
4. Configure o webhook da instância (no Manager, em Webhook/Events) com:
   - URL: `http://NOME-DO-SERVICO-DO-BOT.railway.internal:3000/webhook`
   - Evento: `MESSAGES_UPSERT`
   - "Webhook by events" desligado

   Se preferir por terminal (formato da Evolution v2):
   ```
   curl -X POST https://DOMINIO-DA-EVOLUTION/webhook/set/amk-amazonika \
     -H "apikey: SUA_CHAVE" -H "Content-Type: application/json" \
     -d '{"webhook":{"enabled":true,"url":"http://NOME-DO-SERVICO-DO-BOT.railway.internal:3000/webhook","byEvents":false,"events":["MESSAGES_UPSERT"]}}'
   ```

## 5. Testar

1. De outro celular (o seu pessoal), mande "oi" para o número de testes: o bot
   responde como atendente.
2. Para testar como Edeilton, troque `ADMIN_PHONE_NUMBER` pelo seu número
   pessoal, deixe redeployar, mande "vendi 2 uva roxa 500" e volte o número do
   Edeilton depois.
3. Se não responder, veja **View logs** do bot. Se nada chega lá, o problema
   é o webhook; se chega e dá erro, o log mostra qual.

## Importante

- Com `STOCK_BACKEND=mock` o estoque fica dentro do container e **volta para
  15 a cada novo deploy**. Serve só para testar. Para valer, configure o
  Google Sheets (SETUP.md, seção 4) e, em vez do arquivo JSON, cole o
  conteúdo da chave da conta de serviço na variável
  `GOOGLE_SERVICE_ACCOUNT_JSON`; depois apague `STOCK_BACKEND`.
- A memória das conversas do bot fica em RAM: reiniciar o serviço apaga o
  histórico de conversa (o estoque na planilha não é afetado).
- Confira os planos e créditos atuais da Railway no site antes de entregar
  ao Edeilton, porque o serviço precisa ficar ligado o tempo todo.
