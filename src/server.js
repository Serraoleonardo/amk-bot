require("dotenv").config();
const express = require("express");
const { sendTextMessage, parseIncomingMessage } = require("./evolutionClient");
const { handleMessage } = require("./claudeAssistant");

const app = express();
app.use(express.json());

// Compara telefones ignorando o DDI (55) e o "9" extra do celular (alguns números chegam sem ele).
function canonPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length > 11) d = d.slice(2);
  if (d.length === 11 && d[2] === "9") d = d.slice(0, 2) + d.slice(3);
  return d;
}
const ADMIN_PHONE_NUMBER = canonPhone(process.env.ADMIN_PHONE_NUMBER);

// Endpoint de verificação simples, útil pra checar se o servidor está no ar.
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Este é o endpoint que você deve configurar como webhook na Evolution API,
// para o evento "messages.upsert" (mensagem recebida).
app.post("/webhook", async (req, res) => {
  // Responde rápido pra Evolution API não re-enviar o mesmo webhook por timeout.
  res.sendStatus(200);

  try {
    const parsed = parseIncomingMessage(req.body);
    if (!parsed) return; // não era uma mensagem de texto de um contato (ex: status, mídia, etc.)

    const { phoneNumber, text } = parsed;
    const isAdmin = canonPhone(phoneNumber) === ADMIN_PHONE_NUMBER;

    console.log(`Mensagem recebida de ${phoneNumber} (${isAdmin ? "ADMIN" : "cliente"}): ${text}`);

    const reply = await handleMessage(phoneNumber, text, isAdmin);
    await sendTextMessage(phoneNumber, reply);
  } catch (err) {
    console.error("Erro ao processar webhook:", err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor do bot AMK Amazonika rodando na porta ${PORT}`);
});
