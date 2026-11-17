# Guia de Deploy — Bot AMK Amazonika

Este guia parte do zero: criar o servidor, subir a Evolution API, conectar o
WhatsApp, configurar a planilha de estoque e colocar o bot no ar.

## 1. Criar o servidor (VPS)

Recomendado: **DigitalOcean, região São Paulo (SFO/NYC não — escolha "São
Paulo")**, plano mais básico (1 GB RAM já é suficiente para começar).

1. Crie uma conta em digitalocean.com.
2. Crie um novo "Droplet":
   - Imagem: **Docker on Ubuntu** (procure "Docker" na aba Marketplace — já vem
     com Docker instalado).
   - Região: **São Paulo**.
   - Plano: Basic, 1 GB RAM / 1 vCPU (o mais barato já serve pra começar).
   - Autenticação: senha ou chave SSH (chave SSH é mais seguro).
3. Anote o **IP público** do servidor.
4. Acesse via terminal: `ssh root@SEU_IP`

## 2. Subir a Evolution API + o bot

1. No servidor, instale o Git (se não vier):
   ```
   apt update && apt install -y git
   ```
2. Envie os arquivos deste projeto para o servidor. A forma mais simples é
   criar um repositório privado no GitHub com esses arquivos e clonar no
   servidor:
   ```
   git clone SEU_REPOSITORIO amk-bot
   cd amk-bot
   ```
   (Ou use `scp -r` para copiar a pasta local direto para o servidor.)
3. Copie o arquivo de variáveis de ambiente e preencha os valores reais:
   ```
   cp .env.example .env
   nano .env
   ```
4. Edite o `docker-compose.yml` e troque `AUTHENTICATION_API_KEY` por uma
   senha forte — essa mesma senha deve ir no `.env` em `EVOLUTION_API_KEY`.
5. Suba os containers:
   ```
   docker compose up -d --build
   ```
6. Confira se está tudo no ar:
   ```
   docker compose ps
   curl http://localhost:8080
   curl http://localhost:3000/health
   ```

## 3. Conectar o número de WhatsApp

1. Crie uma instância na Evolution API (substitua `SEU_IP` e a chave):
   ```
   curl -X POST http://localhost:8080/instance/create \
     -H "apikey: SUA_CHAVE_DA_EVOLUTION" \
     -H "Content-Type: application/json" \
     -d '{"instanceName": "amk-amazonika", "qrcode": true}'
   ```
2. Pegue o QR code gerado (a resposta traz um campo com a imagem em base64,
   ou, no SEU computador, abra um túnel `ssh -L 8080:localhost:8080 root@SEU_IP` e acesse
   `http://localhost:8080/instance/connect/amk-amazonika` no navegador para ver o QR code).
   As portas 8080 e 3000 ficam fechadas para a internet de propósito (só o servidor acessa).
3. No celular que vai ser o número oficial da AMK Amazonika, abra o
   WhatsApp > Aparelhos conectados > Conectar um aparelho, e escaneie o QR
   code.
4. Configure o webhook para a instância apontar para o bot:
   ```
   curl -X POST http://localhost:8080/webhook/set/amk-amazonika \
     -H "apikey: SUA_CHAVE_DA_EVOLUTION" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "http://amk-bot:3000/webhook",
       "webhook_by_events": false,
       "events": ["MESSAGES_UPSERT"]
     }'
   ```
   (Como os dois containers estão na mesma rede do Docker Compose, o bot
   pode ser referenciado pelo nome do serviço `amk-bot`, sem precisar do IP.)

## 4. Configurar a planilha de estoque (Google Sheets)

1. Crie uma planilha nova no Google Sheets.
2. Renomeie a primeira aba para **Estoque**.
3. Importe o arquivo `Planilha_Estoque_AMK_Amazonika.xlsx` (Arquivo > Importar) — ela já vem com os 7 sabores x 3 tamanhos e os preços. Colunas: `Sabor | Tamanho | Preço | Quantidade em estoque`.
4. O Edeilton preenche a coluna D com as quantidades reais (0 para o que não existe).
5. Acesse [console.cloud.google.com](https://console.cloud.google.com),
   crie um projeto (ou use um existente).
6. Ative a **Google Sheets API** para esse projeto (menu "APIs e Serviços" >
   "Ativar APIs e Serviços" > busque "Google Sheets API").
7. Crie uma **conta de serviço** (Service Account) em "APIs e Serviços" >
   "Credenciais" > "Criar credenciais" > "Conta de serviço".
8. Depois de criada, gere uma **chave JSON** para essa conta de serviço e
   baixe o arquivo.
9. Coloque esse arquivo no servidor em `amk-bot/credentials/google-service-account.json`.
10. Abra o arquivo JSON baixado e copie o valor de `client_email` (algo como
    `xxx@xxx.iam.gserviceaccount.com`).
11. Na planilha do Google Sheets, clique em "Compartilhar" e adicione esse
    e-mail como **Editor**.
12. Copie o ID da planilha (está na URL, entre `/d/` e `/edit`) e cole em
    `GOOGLE_SHEET_ID` no `.env`.

## 5. Testar

1. Mande uma mensagem de um número de cliente qualquer para o número da
   AMK Amazonika — o bot deve responder como atendente.
2. Mande uma mensagem do número do Edeilton (o mesmo definido em
   `ADMIN_PHONE_NUMBER` no `.env`) dizendo algo como "vendi 2 gengibre
   agora" — o bot deve confirmar a baixa no estoque.
3. Confira a planilha para ver se a quantidade foi atualizada.

## 6. Acompanhar os logs

```
docker compose logs -f amk-bot
```

## Observações importantes

- O número de WhatsApp conectado via Evolution API deve ficar com o celular
  ligado e conectado à internet (mesmo que o app fique em segundo plano),
  pois o WhatsApp Web/Business funciona espelhando esse aparelho.
- Este bot usa um número comum do WhatsApp (via QR code), não a API oficial
  do WhatsApp Business (Meta Cloud API). Para um volume grande de mensagens
  ou crescimento maior do negócio, vale considerar migrar para a API oficial
  no futuro.
- Reveja periodicamente as mensagens trocadas para garantir que o bot está
  respondendo bem — o comportamento pode ser ajustado editando os textos em
  `CUSTOMER_SYSTEM_PROMPT` e `ADMIN_SYSTEM_PROMPT` no arquivo
  `src/claudeAssistant.js`.
