// Teste offline da lógica de estoque/ferramentas (não usa a API do Claude).
process.env.STOCK_BACKEND = "mock";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const file = path.resolve(__dirname, "../data/estoque.json");
const backup = fs.readFileSync(file, "utf-8");
// o teste precisa de um item esgotado: usa 10 em cada item e zera Morango c/ Hibisco 1L só durante o teste (o arquivo é restaurado no fim)
{
  const rows = JSON.parse(backup);
  rows.forEach((r) => { r.estoque = r.sabor === "Morango c/ Hibisco" && r.tamanho === "1L" ? 0 : 10; });
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
}
const { executeTool } = require("../src/claudeAssistant");
const read = () => JSON.parse(fs.readFileSync(file, "utf-8"));
const qty = (sabor, tam) => read().find((i) => i.sabor === sabor && i.tamanho === tam).estoque;

(async () => {
  try {
    let r = await executeTool("consultar_estoque", {});
    assert(r.includes("Açaí da Amazônia | 500ml | R$16.00 | 10 em estoque"), r);
    assert(r.includes("ESGOTADO"));

    // baixa manual com variações de escrita (sem acento, "1 litro", etc.)
    r = await executeTool("baixar_estoque_manual", { sabor: "acai", tamanho: "500", quantidade: 2 });
    assert(r.includes("anterior: 10") && r.includes("atual: 8"), r);
    r = await executeTool("baixar_estoque_manual", { sabor: "guarana", tamanho: "1 litro", quantidade: 1 });
    assert.strictEqual(qty("Guaraná da Amazônia", "1L"), 9);

    // nome ambíguo: "uva" = Uva Fresh ou Uva Roxa -> deve pedir esclarecimento e NÃO baixar
    await assert.rejects(() => executeTool("baixar_estoque_manual", { sabor: "uva", tamanho: "300ml", quantidade: 1 }), /ambíguo/);
    assert.strictEqual(qty("Uva Fresh", "300ml"), 10);
    // mas "uva roxa" é exato
    await executeTool("baixar_estoque_manual", { sabor: "uva roxa", tamanho: "300ml", quantidade: 1 });
    assert.strictEqual(qty("Uva Roxa", "300ml"), 9);

    // pedido com total correto (2x300ml=26 + 1x1L=28 = 54)
    r = await executeTool("registrar_pedido", { nome_cliente: "Maria", itens: [{ sabor: "Limão com Gengibre", tamanho: "300ml", quantidade: 2 }, { sabor: "Limão com Gengibre", tamanho: "1L", quantidade: 1 }] });
    assert(r.includes("TOTAL: R$54.00"), r);

    // item esgotado (Morango c/ Hibisco 1L está zerado no arquivo de teste): pedido inteiro é recusado e NADA é baixado
    const antes = fs.readFileSync(file, "utf-8");
    await assert.rejects(() => executeTool("registrar_pedido", { nome_cliente: "João", itens: [{ sabor: "Uva Fresh", tamanho: "300ml", quantidade: 1 }, { sabor: "Morango c/ Hibisco", tamanho: "1L", quantidade: 1 }] }), /insuficiente/);
    assert.strictEqual(fs.readFileSync(file, "utf-8"), antes, "pedido parcial alterou o estoque");

    // mesmo item repetido no pedido: soma antes de validar (11 > 10)
    await assert.rejects(() => executeTool("registrar_pedido", { nome_cliente: "Ana", itens: [{ sabor: "Uva Fresh", tamanho: "500ml", quantidade: 6 }, { sabor: "Uva Fresh", tamanho: "500ml", quantidade: 5 }] }), /insuficiente/);
    assert.strictEqual(qty("Uva Fresh", "500ml"), 10);

    await assert.rejects(() => executeTool("baixar_estoque_manual", { sabor: "Morango", tamanho: "300ml", quantidade: 1 }).then(() => executeTool("baixar_estoque_manual", { sabor: "Banana", tamanho: "300ml", quantidade: 1 })));
    console.log("✅ Todos os testes de estoque passaram");
  } finally {
    fs.writeFileSync(file, backup);
  }
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
