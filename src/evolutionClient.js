// Cliente simples para enviar mensagens através da Evolution API.
// Documentação da Evolution API: https://doc.evolution-api.com/

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;

/**
 * Envia uma mensagem de texto simples para um número de WhatsApp.
 * @param {string} phoneNumber - número no formato internacional, só dígitos (ex: 55DDDNUMERO)
 * @param {string} text - texto da mensagem
 */
async function sendTextMessage(phoneNumber, text) {
  const url = `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({
      number: phoneNumber,
      text: text,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Falha ao enviar mensagem via Evolution API: ${response.status} - ${errorBody}`);
  }

  return response.json();
}

/**
 * Extrai o número de telefone e o texto de uma mensagem recebida via webhook da Evolution API.
 * O formato exato do payload pode variar conforme a versão da Evolution API — ajuste se necessário
 * observando o payload real que chega no seu endpoint /webhook (dê um console.log(req.body) para conferir).
 */
function parseIncomingMessage(webhookBody) {
  try {
    const data = webhookBody.data;
    if (!data || !data.message) return null;

    // Ignora mensagens enviadas pelo próprio bot (fromMe)
    if (data.key?.fromMe) return null;

    // Versões novas do WhatsApp podem mandar um id "@lid" no remoteJid; o número real vem em outro campo.
    let remoteJid = data.key?.remoteJid || "";
    if (remoteJid.endsWith("@lid")) {
      remoteJid = data.key?.remoteJidAlt || data.key?.senderPn || data.senderPn || remoteJid;
    }
    if (remoteJid.endsWith("@g.us")) return null; // ignora grupos
    const phoneNumber = remoteJid.split("@")[0];

    const text =
      data.message.conversation ||
      data.message.extendedTextMessage?.text ||
      null;

    if (!phoneNumber || !text) return null;

    return { phoneNumber, text };
  } catch (err) {
    console.error("Erro ao interpretar mensagem recebida:", err);
    return null;
  }
}

module.exports = { sendTextMessage, parseIncomingMessage };
