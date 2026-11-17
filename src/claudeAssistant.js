const Anthropic = require("@anthropic-ai/sdk");
const { getStock, findItem, deductStock, addStock, getOrders, addOrder, setOrderStatus, itensTexto } = require("./sheetsClient");
const { sendTextMessage } = require("./evolutionClient");

// Garante que src/sheetsClient.js e src/claudeAssistant.js são da mesma versão (evita deploy pela metade).
for (const [name, fn] of Object.entries({ getStock, findItem, deductStock, addStock, getOrders, addOrder, setOrderStatus, itensTexto })) {
  if (typeof fn !== "function") {
    throw new Error(`Arquivos de versões diferentes: src/sheetsClient.js não tem "${name}". Atualize os DOIS arquivos (sheetsClient.js e claudeAssistant.js).`);
  }
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Memória de conversa simples em memória (reinicia se o processo reiniciar).
// A conversa termina quando um pedido é registrado, ou após 6 horas sem mensagens.
const conversations = new Map(); // phoneNumber -> { messages: [{role, content}, ...], last: timestamp }
const IDLE_MS = 6 * 60 * 60 * 1000;

function getHistory(phoneNumber) {
  const c = conversations.get(phoneNumber);
  if (!c || Date.now() - c.last > IDLE_MS) {
    conversations.set(phoneNumber, { messages: [], last: Date.now() });
  }
  return conversations.get(phoneNumber).messages;
}

function pushHistory(phoneNumber, role, content) {
  const history = getHistory(phoneNumber);
  history.push({ role, content });
  conversations.get(phoneNumber).last = Date.now();
  // mantém só as últimas 20 mensagens para não estourar o contexto
  if (history.length > 20) history.splice(0, history.length - 20);
}

/** Compara telefones ignorando DDI (55) e o "9" extra; se não for número, compara o texto. */
function phoneKey(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.length < 8) return String(p || "");
  if (d.startsWith("55") && d.length > 11) d = d.slice(2);
  if (d.length === 11 && d[2] === "9") d = d.slice(0, 2) + d.slice(3);
  return d;
}

// ---------- Ferramentas disponíveis para o Claude ----------

const customerTools = [
  {
    name: "consultar_estoque",
    description: "Consulta o catálogo completo de sabores de kombucha disponíveis, com preço e quantidade em estoque.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "registrar_pedido",
    description: "Registra um pedido do cliente e desconta os itens do estoque. Só use depois de confirmar com o cliente os itens, quantidades, nome, entrega e pagamento. A equipe é avisada automaticamente.",
    input_schema: {
      type: "object",
      properties: {
        nome_cliente: { type: "string", description: "Nome do cliente" },
        entrega: { type: "string", description: "Endereço/cidade de entrega, ou \"Retirada\"" },
        pagamento: { type: "string", description: "Forma de pagamento: Pix, Cartão ou Dinheiro (só retirada)" },
        itens: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sabor: { type: "string" },
              tamanho: { type: "string", description: "300ml, 500ml ou 1L" },
              quantidade: { type: "integer" },
            },
            required: ["sabor", "tamanho", "quantidade"],
          },
        },
      },
      required: ["nome_cliente", "entrega", "pagamento", "itens"],
    },
  },
  {
    name: "cancelar_pedido",
    description: "Cancela um pedido PENDENTE (ainda não entregue) do próprio cliente que está conversando e devolve os itens ao estoque. Use quando o cliente pedir para cancelar um pedido JÁ REGISTRADO. Sem 'id', cancela o único pedido pendente dele; se houver mais de um, a ferramenta lista e você pergunta qual número cancelar.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer", description: "Número do pedido (opcional se só houver um pendente)" } },
    },
  },
  {
    name: "descartar_pedido_em_andamento",
    description: "Use quando o cliente desistir de um pedido que ainda estava sendo montado (NÃO registrado). Limpa a conversa para recomeçar do zero.",
    input_schema: { type: "object", properties: {} },
  },
];

const adminTools = [
  {
    name: "consultar_estoque",
    description: "Consulta o estoque atual de todos os sabores.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "baixar_estoque_manual",
    description: "Registra uma venda física feita pelo próprio Edeilton, descontando a quantidade informada do estoque do sabor indicado.",
    input_schema: {
      type: "object",
      properties: {
        sabor: { type: "string" },
        tamanho: { type: "string", description: "300ml, 500ml ou 1L" },
        quantidade: { type: "integer" },
      },
      required: ["sabor", "tamanho", "quantidade"],
    },
  },
  {
    name: "listar_pedidos",
    description: "Lista os pedidos dos clientes. Por padrão só os pendentes (ainda não entregues nem cancelados).",
    input_schema: {
      type: "object",
      properties: { filtro: { type: "string", enum: ["pendentes", "todos"], description: "pendentes (padrão) ou todos" } },
    },
  },
  {
    name: "atualizar_pedido",
    description: "Marca um pedido pendente como entregue ou cancelado. Cancelar devolve os itens ao estoque.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Número do pedido" },
        status: { type: "string", enum: ["entregue", "cancelado"] },
      },
      required: ["id", "status"],
    },
  },
];

// Evita duas operações de estoque/pedido ao mesmo tempo (duas pessoas pedindo juntas).
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(fn, fn);
  lockChain = run.catch(() => {});
  return run;
}

const ADMIN_PHONE_NUMBER = (process.env.ADMIN_PHONE_NUMBER || "").replace(/\D/g, "");

/** Avisa o Edeilton no WhatsApp pessoal. Retorna true se enviou. Nunca lança erro. */
async function notifyAdmin(text) {
  if (process.env.NOTIFY_ADMIN === "off" || !process.env.EVOLUTION_API_URL || !ADMIN_PHONE_NUMBER) {
    console.log("[aviso ao Edeilton não enviado — modo de teste]\n" + text);
    return false;
  }
  try {
    await sendTextMessage(ADMIN_PHONE_NUMBER, text);
    return true;
  } catch (err) {
    console.error("Falha ao avisar o Edeilton:", err.message);
    return false;
  }
}

const money = (n) => `R$${Number(n).toFixed(2)}`;
function formatOrder(o) {
  return `#${o.id} | ${o.data} | ${o.cliente} (wa.me/${String(o.telefone).replace(/\D/g, "")}) | ${itensTexto(o.itens)} | ${money(o.total)} | ${o.entrega} | ${o.pagamento} | ${o.status}`;
}

async function executeTool(toolName, toolInput, ctx = {}) {
  if (toolName === "consultar_estoque") {
    const stock = await getStock();
    return stock
      .map((i) => `${i.sabor} | ${i.tamanho} | R$${i.preco.toFixed(2)} | ${i.estoque > 0 ? `${i.estoque} em estoque` : "ESGOTADO"}`)
      .join("\n");
  }

  if (toolName === "registrar_pedido") {
    return withLock(async () => {
      // Valida TODOS os itens antes de baixar qualquer um (evita pedido pela metade).
      // Soma itens repetidos (mesmo sabor+tamanho) para validar o total.
      const totals = new Map();
      for (const it of toolInput.itens) {
        const found = await findItem(it.sabor, it.tamanho);
        if (!found) throw new Error(`"${it.sabor}" ${it.tamanho} não encontrado no estoque.`);
        const acc = (totals.get(found.row) || 0) + it.quantidade;
        totals.set(found.row, acc);
        if (found.estoque < acc) {
          throw new Error(`Estoque insuficiente de ${found.sabor} ${found.tamanho}: disponível ${found.estoque}, pedido ${acc}.`);
        }
      }
      const itens = [];
      let total = 0;
      for (const it of toolInput.itens) {
        const r = await deductStock(it.sabor, it.tamanho, it.quantidade);
        total += r.preco * it.quantidade;
        itens.push({ sabor: r.sabor, tamanho: r.tamanho, quantidade: it.quantidade, preco: r.preco });
      }
      let order;
      try {
        order = await addOrder({
          cliente: toolInput.nome_cliente,
          telefone: ctx.phone || "",
          itens,
          total,
          entrega: toolInput.entrega,
          pagamento: toolInput.pagamento,
        });
      } catch (err) {
        // não deixa o estoque descontado sem pedido registrado
        for (const it of itens) await addStock(it.sabor, it.tamanho, it.quantidade).catch(() => {});
        throw err;
      }
      const avisou = await notifyAdmin(
        `🛒 *Novo pedido #${order.id}*\n` +
        `Cliente: ${order.cliente} (wa.me/${String(order.telefone).replace(/\D/g, "")})\n` +
        `Itens: ${itensTexto(itens)}\n` +
        `Total: ${money(total)}\n` +
        `Entrega: ${order.entrega}\n` +
        `Pagamento: ${order.pagamento}\n\n` +
        `Responda aqui: "pedido ${order.id} entregue" ou "cancela pedido ${order.id}".`
      );
      ctx.resetAfter = true; // pedido fechado: a conversa termina aqui
      return `Pedido #${order.id} registrado para ${order.cliente}: ${itensTexto(itens)}. TOTAL: ${money(total)}. ` +
        (avisou ? "A equipe já foi avisada." : "ATENÇÃO: não foi possível avisar a equipe agora; diga ao cliente que o pedido está registrado e que nossa equipe confirmará assim que possível.");
    });
  }

  if (toolName === "cancelar_pedido") {
    return withLock(async () => {
      if (!ctx.phone) throw new Error("Não consegui identificar o telefone do cliente.");
      const mine = (await getOrders()).filter((o) => phoneKey(o.telefone) === phoneKey(ctx.phone));
      const pendentes = mine.filter((o) => o.status === "Pendente");
      let target;
      if (toolInput.id) {
        target = pendentes.find((o) => o.id === toolInput.id);
        if (!target) {
          const other = mine.find((o) => o.id === toolInput.id);
          if (other) throw new Error(`O pedido #${other.id} já está ${other.status} e não pode ser cancelado por aqui; a equipe resolve.`);
          throw new Error(`Não encontrei o pedido #${toolInput.id} neste número.`);
        }
      } else if (pendentes.length === 0) {
        return "Este cliente não tem nenhum pedido pendente para cancelar (pedidos já entregues ou cancelados não podem ser cancelados por aqui).";
      } else if (pendentes.length > 1) {
        return `Este cliente tem mais de um pedido pendente: ${pendentes.map((o) => `#${o.id} (${itensTexto(o.itens)}, ${money(o.total)})`).join(" | ")}. Pergunte qual número ele quer cancelar.`;
      } else {
        target = pendentes[0];
      }
      for (const it of target.itens) await addStock(it.sabor, it.tamanho, it.quantidade);
      await setOrderStatus(target.id, "Cancelado");
      await notifyAdmin(
        `❌ *Pedido #${target.id} cancelado pelo cliente*\n` +
        `Cliente: ${target.cliente} (wa.me/${String(target.telefone).replace(/\D/g, "")})\n` +
        `Itens: ${itensTexto(target.itens)} (${money(target.total)})\n` +
        `Os itens já voltaram ao estoque.`
      );
      ctx.resetAfter = true;
      return `Pedido #${target.id} cancelado: ${itensTexto(target.itens)}. Os itens voltaram ao estoque e a equipe foi avisada.`;
    });
  }

  if (toolName === "descartar_pedido_em_andamento") {
    ctx.resetAfter = true;
    return "Pedido em andamento descartado. A conversa será reiniciada.";
  }

  if (toolName === "listar_pedidos") {
    const todos = (toolInput.filtro || "pendentes") === "todos";
    const orders = (await getOrders()).filter((o) => todos || o.status === "Pendente");
    if (orders.length === 0) return todos ? "Nenhum pedido registrado ainda." : "Nenhum pedido pendente.";
    return orders.map(formatOrder).join("\n");
  }

  if (toolName === "atualizar_pedido") {
    return withLock(async () => {
      const order = (await getOrders()).find((o) => o.id === toolInput.id);
      if (!order) throw new Error(`Pedido #${toolInput.id} não encontrado.`);
      if (order.status !== "Pendente") throw new Error(`Pedido #${order.id} já está ${order.status}; só dá para alterar pedidos pendentes.`);
      if (toolInput.status === "cancelado") {
        for (const it of order.itens) await addStock(it.sabor, it.tamanho, it.quantidade);
        await setOrderStatus(order.id, "Cancelado");
        return `Pedido #${order.id} cancelado e itens devolvidos ao estoque: ${itensTexto(order.itens)}.`;
      }
      await setOrderStatus(order.id, "Entregue");
      return `Pedido #${order.id} (${order.cliente}) marcado como entregue.`;
    });
  }

  if (toolName === "baixar_estoque_manual") {
    const r = await withLock(() => deductStock(toolInput.sabor, toolInput.tamanho, toolInput.quantidade));
    return `Baixa registrada: ${toolInput.quantidade}x ${r.sabor} ${r.tamanho}. Estoque anterior: ${r.estoqueAnterior}, estoque atual: ${r.estoqueAtual}.`;
  }

  return `Ferramenta desconhecida: ${toolName}`;
}

const PIX_KEY = process.env.PIX_KEY || "";

const CUSTOMER_SYSTEM_PROMPT = `Você é o atendente virtual da Amazônika (marca Amazônika Kombucha), produtora de kombucha artesanal em Ji-Paraná - RO.
Slogan: "Natureza. Saúde. Equilíbrio." É uma bebida natural, de fermentação natural, probiótica, leve e refrescante.
Seu papel é atender clientes pelo WhatsApp, apresentar o catálogo, tirar dúvidas e fechar pedidos.

CATÁLOGO (confirme sempre o estoque real com a ferramenta consultar_estoque):
- Sabores: Morango c/ Hibisco, Uva Fresh, Uva Roxa, Guaraná da Amazônia, Limão com Gengibre, Açaí da Amazônia, Abacaxi c/ Hortelã e Limão.
- Tamanhos e preços: 300 ml = R$13,00 | 500 ml = R$16,00 | 1 litro = R$28,00.
- Nem todo sabor existe em todos os tamanhos: o que vale é o que a ferramenta consultar_estoque mostrar.

PAGAMENTO:
- Pix${PIX_KEY ? ` (chave: ${PIX_KEY})` : " (nossa equipe envia a chave Pix ao cliente depois de confirmado o pedido)"}.
- Cartão, parcelado em até 3x conforme o valor da compra.
- Dinheiro SOMENTE se o cliente vier retirar o pedido.

ENTREGA:
- Entrega sem custo (por enquanto) em Ji-Paraná, Cacoal, Machadinho, Ouro Preto do Oeste, Jaru, Ariquemes e Estrela de Rondônia. Não cobre nem mencione frete.
- Para outras cidades ou retirada, diga que nossa equipe combina diretamente com o cliente.

ONDE ENCONTRAR (pontos de venda parceiros), se o cliente preferir comprar em loja:
- 1º Distrito: Empório Sementeira, Empório Nutri Rutes, Empório Nutrieve, Empório da Agricultura Familiar (Mercado Ozame), Vera Cruz, Comida Árabe da Val, Danilo Barbearia, Prime Distribuidora.
- 2º Distrito: Empório Sementeira, Empório Nutrieve, Lanche da Marli (T-12), Mercado União (Brasil com T-22).

REGRAS:
- Seja simpático, direto e use linguagem natural de WhatsApp (mensagens curtas, sem formalidade excessiva).
- FORMATO (WhatsApp): para negrito use UM asterisco de cada lado, assim: *texto* (títulos, nome do cliente, total). NUNCA use dois asteriscos (**), itálico, títulos com #, tabelas nem linhas "---". Separe as informações com quebras de linha e use emojis. Para listar itens, uma linha por item começando com "•".
- SABORES: ao listar ou citar sabores, coloque o emoji do sabor antes do nome: Morango c/ Hibisco 🍓, Uva Fresh 🍇, Uva Roxa 🍇, Guaraná da Amazônia 🌿, Limão com Gengibre 🍋, Açaí da Amazônia 🫐, Abacaxi c/ Hortelã e Limão 🍍.
- Para fechar pedido você precisa de: sabor, TAMANHO, quantidade, nome do cliente, cidade/endereço de entrega (ou retirada) e forma de pagamento. Pergunte o que faltar.
- Confirme o resumo (itens, total, entrega e pagamento) com o cliente ANTES de usar registrar_pedido.
- CONVERSA NOVA A CADA PEDIDO: quando um pedido é registrado, aquela conversa termina. Se o cliente voltar a escrever, é um atendimento novo: comece do zero, cumprimente e NUNCA repita nem pergunte sobre itens do pedido anterior (a não ser que ele peça para cancelar).
- CANCELAMENTO: se o cliente disser "cancelar" ou quiser desistir: (a) se ele estava montando um pedido que ainda NÃO foi registrado, use descartar_pedido_em_andamento e diga que tudo bem, sem problema; (b) se quer cancelar um pedido JÁ registrado, use cancelar_pedido você mesmo, sem encaminhar para a equipe; (c) se não estiver claro qual dos dois, pergunte. Pedido já entregue não pode ser cancelado por aqui: diga que a equipe resolve.
- Depois de registrar, diga o número do pedido e que nossa equipe foi avisada e vai entrar em contato para combinar entrega e pagamento (se o resultado da ferramenta disser que não foi possível avisar a equipe, diga que o pedido está registrado e que nossa equipe confirmará assim que possível). Avise também que, se quiser cancelar antes da entrega, é só mandar "cancelar". Não prometa horário de entrega.
- Nunca invente preço, sabor ou estoque. Se estiver ESGOTADO ou sem quantidade suficiente, avise e sugira outro sabor/tamanho.
- Se o nome do sabor for ambíguo (ex.: "uva"), pergunte qual (Uva Fresh ou Uva Roxa).
- Não dê conselho médico. Se perguntarem sobre saúde, diga apenas que é bebida probiótica de fermentação natural e que gestantes, crianças e quem tem condições de saúde devem consultar o médico antes de consumir. Pode conter álcool de até 0,5%.
- Ao encerrar um atendimento ou pedido, agradeça de forma curta e simples (ex.: "Obrigado por escolher a Amazônika Kombucha! 🍃"), sem repetir o slogan. Não use a palavra "Amazônia" em saudações, slogans ou despedidas; ela só aparece nos nomes dos sabores.
- Com o cliente, chame o negócio sempre de "Amazônika" ou "Amazônika Kombucha". Nunca use a sigla "AMK" nem cite o nome do Edeilton: fale "nossa equipe".
- Não fale de assuntos fora do atendimento da Amazônika.`;

const ADMIN_SYSTEM_PROMPT = `Você é o assistente de gestão da Amazônika (negócio do Edeilton) no WhatsApp. Não chame o admin por nenhum nome (pode ser o Edeilton ou outra pessoa da equipe); cumprimente sem nome.
Quando ele avisar sobre uma venda física (ex: "vendi 2 uva roxa 500 agora", "saiu 1 de 1 litro de açaí"), extraia sabor, TAMANHO (300ml, 500ml ou 1L) e quantidade e registre a baixa com a ferramenta baixar_estoque_manual.
Se ele não disser o tamanho, ou o sabor for ambíguo (ex.: "uva"), pergunte antes de baixar — nunca chute.
Depois de baixar, confirme e informe o novo saldo daquele item.
Se ele perguntar sobre estoque, use consultar_estoque e responda de forma resumida (alerte itens ESGOTADOS ou com poucas unidades).
Pedidos de clientes: quando ele perguntar "tem pedido?", "o que falta entregar?" etc., use listar_pedidos. Quando disser que entregou ("pedido 12 entregue") ou cancelou ("cancela o pedido 12"), use atualizar_pedido. Cancelar devolve os itens ao estoque; se o número do pedido não estiver claro, liste os pendentes e pergunte.
Se uma ferramenta devolver "Erro: ...", escreva o texto técnico do erro na resposta (o admin precisa dele para o suporte). Seja direto e breve. Para destacar algo use negrito do WhatsApp com UM asterisco de cada lado (*assim*), nunca dois.`;

/**
 * Converte Markdown para o formato do WhatsApp: **negrito** vira *negrito*, títulos viram negrito,
 * listas viram "•" e linhas "---" somem. Mantém emojis e quebras de linha.
 */
function brandSafety(text) {
  return String(text || "")
    .replace(/\bAMK\s+Amaz[oô]nika\b/gi, "Amazônika")
    .replace(/\bAMK\b/g, "Amazônika")
    .replace(/Natureza\.\s*Saúde\.\s*Equilíbrio\.\s*Amazônia\.?/gi, "Natureza. Saúde. Equilíbrio.");
}

function cleanForWhatsApp(text) {
  return String(text || "")
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, "") // linhas "---", "***", "___"
    .replace(/^\s*#{1,6}\s*(.+?)\s*$/gm, "*$1*") // títulos "## Texto" viram negrito
    .replace(/^(\s*)[*-]\s+/gm, "$1• ") // listas com "-" ou "*" viram "•"
    .replace(/\*{2,}([^*\n]+?)\*{2,}/g, "*$1*") // **negrito** (Markdown) -> *negrito* (WhatsApp)
    .replace(/__([^_\n]+?)__/g, "*$1*") // __negrito__ -> *negrito*
    .replace(/\*{2,}/g, "") // sobras de asteriscos duplos
    .replace(/\*\*/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Processa uma mensagem recebida e retorna o texto de resposta a ser enviado de volta.
 * @param {string} phoneNumber
 * @param {string} text
 * @param {boolean} isAdmin - true se a mensagem vier do número do Edeilton
 */
async function handleMessage(phoneNumber, text, isAdmin) {
  const systemPrompt = isAdmin ? ADMIN_SYSTEM_PROMPT : CUSTOMER_SYSTEM_PROMPT;
  const tools = isAdmin ? adminTools : customerTools;

  pushHistory(phoneNumber, "user", text);
  const ctx = { phone: phoneNumber, resetAfter: false };

  let messages = [...getHistory(phoneNumber)];
  let finalText = "";

  // Loop de tool-use: o Claude pode pedir para executar uma ferramenta antes de responder de fato.
  for (let i = 0; i < 5; i++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages,
    });

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      finalText = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      break;
    }

    // Executa cada ferramenta pedida e devolve o resultado ao Claude
    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      let result;
      try {
        result = await executeTool(block.name, block.input, ctx);
      } catch (err) {
        console.error(`Erro na ferramenta ${block.name}:`, err.stack || err.message);
        result = `Erro: ${err.message}`;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: String(result),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  finalText = cleanForWhatsApp(finalText);
  if (!isAdmin) finalText = brandSafety(finalText);
  if (ctx.resetAfter) conversations.delete(phoneNumber); // pedido fechado/cancelado: próxima mensagem começa conversa nova
  else pushHistory(phoneNumber, "assistant", finalText);
  return finalText || "Desculpa, não consegui processar sua mensagem agora. Pode repetir?";
}

module.exports = { handleMessage, executeTool, cleanForWhatsApp, brandSafety, _conversations: conversations };
