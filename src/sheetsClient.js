// Estoque da AMK Amazonika, por SABOR + TAMANHO.
// Planilha Google Sheets, aba "Estoque", colunas:
//   A: Sabor | B: Tamanho (300ml / 500ml / 1L) | C: Preço | D: Quantidade em estoque
// Modo de teste local: STOCK_BACKEND=mock usa data/estoque.json (sem Google).

const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CREDENTIALS_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
const SHEET_RANGE = "Estoque!A2:D200";

const USE_MOCK = process.env.STOCK_BACKEND === "mock";
const MOCK_FILE = path.resolve(__dirname, "../data/estoque.json");

function mockRead() {
  return JSON.parse(fs.readFileSync(MOCK_FILE, "utf-8")).map((item, i) => ({ row: i + 2, ...item }));
}
function mockWrite(rows) {
  const clean = rows.map(({ sabor, tamanho, preco, estoque }) => ({ sabor, tamanho, preco, estoque }));
  fs.writeFileSync(MOCK_FILE, JSON.stringify(clean, null, 2));
}

async function getSheetsClient() {
  const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
  // Em hospedagem sem arquivos (Railway), o JSON da conta de serviço vem numa variável de ambiente.
  const auth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes })
    : new google.auth.GoogleAuth({ keyFile: path.resolve(CREDENTIALS_FILE), scopes });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

// ---------- normalização (ignora acento, maiúscula e variações de escrita) ----------
function norm(text) {
  return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
function normSize(size) {
  const s = norm(size).replace(/\s+/g, "");
  if (/^(1|1000)(l|lt|litro|litros|ml)?$/.test(s)) return "1l";
  const m = s.match(/^(\d{3})(ml)?$/);
  return m ? `${m[1]}ml` : s;
}

/** Lista todos os itens: [{ row, sabor, tamanho, preco, estoque }] */
async function getStock() {
  if (USE_MOCK) return mockRead();
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_RANGE });
  return (res.data.values || [])
    .map((r, i) => ({
      row: i + 2,
      sabor: r[0],
      tamanho: r[1],
      preco: parseFloat(String(r[2] || "0").replace(",", ".")) || 0,
      estoque: parseInt(r[3], 10) || 0,
    }))
    .filter((item) => item.sabor && item.tamanho);
}

/**
 * Acha UM item por sabor + tamanho.
 * - Retorna null se não existir.
 * - Lança erro se o nome do sabor for ambíguo (ex.: "uva" = Uva Fresh ou Uva Roxa).
 */
async function findItem(sabor, tamanho) {
  const stock = await getStock();
  const size = normSize(tamanho);
  const wanted = norm(sabor);
  const sameSize = stock.filter((i) => normSize(i.tamanho) === size);

  const exact = sameSize.filter((i) => norm(i.sabor) === wanted);
  if (exact.length === 1) return exact[0];

  const partial = sameSize.filter((i) => norm(i.sabor).includes(wanted) || wanted.includes(norm(i.sabor)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`"${sabor}" é ambíguo. Opções: ${partial.map((i) => i.sabor).join(", ")}. Pergunte qual deles.`);
  }
  return null;
}

/** Reduz o estoque de um sabor+tamanho. Erra se não existir ou se faltar produto. */
async function deductStock(sabor, tamanho, quantity) {
  const item = await findItem(sabor, tamanho);
  if (!item) throw new Error(`"${sabor}" ${tamanho} não encontrado no estoque.`);
  if (item.estoque < quantity) {
    throw new Error(`Estoque insuficiente de ${item.sabor} ${item.tamanho}: disponível ${item.estoque}, solicitado ${quantity}.`);
  }
  const newStock = item.estoque - quantity;

  if (USE_MOCK) {
    const rows = mockRead();
    rows.find((r) => r.row === item.row).estoque = newStock;
    mockWrite(rows);
  } else {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Estoque!D${item.row}`,
      valueInputOption: "RAW",
      requestBody: { values: [[newStock]] },
    });
  }
  return { ...item, estoqueAnterior: item.estoque, estoqueAtual: newStock };
}

/** Devolve unidades ao estoque (usado ao cancelar um pedido). */
async function addStock(sabor, tamanho, quantity) {
  const item = await findItem(sabor, tamanho);
  if (!item) throw new Error(`"${sabor}" ${tamanho} não encontrado no estoque.`);
  const newStock = item.estoque + quantity;
  if (USE_MOCK) {
    const rows = mockRead();
    rows.find((r) => r.row === item.row).estoque = newStock;
    mockWrite(rows);
  } else {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Estoque!D${item.row}`,
      valueInputOption: "RAW",
      requestBody: { values: [[newStock]] },
    });
  }
  return { ...item, estoqueAnterior: item.estoque, estoqueAtual: newStock };
}

// ---------- PEDIDOS ----------
// Aba "Pedidos": A ID | B Data | C Cliente | D Telefone | E Itens | F Total | G Entrega | H Pagamento | I Status | J Itens (JSON, não editar)
const ORDERS_RANGE = "Pedidos!A2:J2000";
const ORDERS_MOCK_FILE = path.resolve(__dirname, "../data/pedidos.json");

function ordersMockRead() {
  try { return JSON.parse(fs.readFileSync(ORDERS_MOCK_FILE, "utf-8")); } catch { return []; }
}

/** Lista todos os pedidos: [{ id, data, cliente, telefone, itens:[{sabor,tamanho,quantidade,preco}], total, entrega, pagamento, status, row }] */
async function getOrders() {
  if (USE_MOCK) return ordersMockRead().map((o, i) => ({ row: i + 2, ...o }));
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: ORDERS_RANGE });
  return (res.data.values || [])
    .map((r, i) => {
      let itens = [];
      try { itens = JSON.parse(r[9] || "[]"); } catch {}
      return {
        row: i + 2, id: parseInt(r[0], 10), data: r[1], cliente: r[2], telefone: r[3],
        itens, total: parseFloat(String(r[5] || "0").replace(",", ".")) || 0,
        entrega: r[6], pagamento: r[7], status: r[8] || "Pendente",
      };
    })
    .filter((o) => o.id);
}

function itensTexto(itens) {
  return itens.map((i) => `${i.quantidade}x ${i.sabor} ${i.tamanho}`).join("; ");
}

/** Grava um pedido novo (status Pendente) e devolve { id, ... }. */
async function addOrder({ cliente, telefone, itens, total, entrega, pagamento }) {
  const existing = await getOrders();
  const id = existing.reduce((m, o) => Math.max(m, o.id || 0), 0) + 1;
  const data = new Date().toLocaleString("pt-BR", { timeZone: "America/Porto_Velho" });
  const order = { id, data, cliente, telefone, itens, total, entrega, pagamento, status: "Pendente" };
  if (USE_MOCK) {
    const rows = ordersMockRead();
    rows.push(order);
    fs.mkdirSync(path.dirname(ORDERS_MOCK_FILE), { recursive: true });
    fs.writeFileSync(ORDERS_MOCK_FILE, JSON.stringify(rows, null, 2));
  } else {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Pedidos!A:J",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[id, data, cliente, telefone, itensTexto(itens), total, entrega, pagamento, "Pendente", JSON.stringify(itens)]] },
    });
  }
  return order;
}

/** Muda o status de um pedido (Pendente / Entregue / Cancelado). */
async function setOrderStatus(id, status) {
  const orders = await getOrders();
  const order = orders.find((o) => o.id === id);
  if (!order) throw new Error(`Pedido #${id} não encontrado.`);
  if (USE_MOCK) {
    const rows = ordersMockRead();
    rows.find((o) => o.id === id).status = status;
    fs.writeFileSync(ORDERS_MOCK_FILE, JSON.stringify(rows, null, 2));
  } else {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Pedidos!I${order.row}`,
      valueInputOption: "RAW",
      requestBody: { values: [[status]] },
    });
  }
  return { ...order, status };
}

module.exports = { getStock, findItem, deductStock, addStock, getOrders, addOrder, setOrderStatus, itensTexto };
