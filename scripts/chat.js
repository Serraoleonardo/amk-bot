// Chat de terminal para testar o bot sem WhatsApp.
// Uso:  STOCK_BACKEND=mock node scripts/chat.js            (você é um cliente)
//       STOCK_BACKEND=mock node scripts/chat.js --admin    (você é o Edeilton)
require("dotenv").config();
process.env.STOCK_BACKEND = process.env.STOCK_BACKEND || "mock";
const readline = require("readline");
const { handleMessage } = require("../src/claudeAssistant");

const isAdmin = process.argv.includes("--admin");
const phone = isAdmin ? "ADMIN" : "CLIENTE-TESTE";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`Modo: ${isAdmin ? "EDEILTON (admin)" : "CLIENTE"} | estoque em data/estoque.json | Ctrl+C para sair\n`);

(function ask() {
  rl.question("Você: ", async (text) => {
    if (!text.trim()) return ask();
    try { console.log("\nBot:", await handleMessage(phone, text, isAdmin), "\n"); }
    catch (e) { console.error("Erro:", e.message, "\n"); }
    ask();
  });
})();
