/**
 * ============================================================
 * HAMBURGUERIA PIX - Backend Node.js + Express
 * Integração com Mercado Pago PIX Dinâmico
 * ============================================================
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { MercadoPagoConfig, Payment } = require("mercadopago");

const app = express();
app.use(express.json());
app.use(cors()); // Em produção, restrinja para seu domínio frontend

// ============================================================
// CONFIGURAÇÃO DO MERCADO PAGO
// ============================================================

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN?.trim(),
  options: {
    timeout: 5000,
    idempotencyKey: undefined, // será gerado por pedido
  },
});

const paymentClient = new Payment(mpClient);

// ============================================================
// BANCO DE DADOS EM MEMÓRIA (substitua por banco real)
// Em produção: use PostgreSQL, MySQL, MongoDB, etc.
// ============================================================

const pedidos = new Map(); // Map<pedidoId, dadosPedido>

// ============================================================
// ENDPOINT: POST /criar-pedido
// Cria o pedido + pagamento PIX no Mercado Pago
// ============================================================

app.post("/criar-pedido", async (req, res) => {
  try {
    const { itens, cliente } = req.body;

    // --- Validação básica ---
    if (!itens || !Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ erro: "Envie pelo menos 1 item no pedido." });
    }

    // --- Calcula o total do pedido ---
    const total = itens.reduce((soma, item) => {
      if (!item.nome || !item.quantidade || !item.preco) {
        throw new Error(`Item inválido: ${JSON.stringify(item)}`);
      }
      return soma + item.quantidade * item.preco;
    }, 0);

    // --- Gera ID único para o pedido ---
    const pedidoId = uuidv4();

    // --- Monta a descrição dos itens para o PIX ---
    const descricao = itens
      .map((i) => `${i.quantidade}x ${i.nome}`)
      .join(", ");

    // --- Cria o pagamento PIX no Mercado Pago ---
    // Documentação: https://www.mercadopago.com.br/developers/pt/reference/payments/_payments/post
    const pagamento = await paymentClient.create({
      body: {
        transaction_amount: parseFloat(total.toFixed(2)),
        description: `Pedido King Angus #${pedidoId.slice(0, 8)}`,
        payment_method_id: "pix",
        payer: {
          email: cliente?.email || "cliente@kingangus.com",
          first_name: cliente?.nome?.split(' ')[0] || "Cliente",
          last_name:  cliente?.nome?.split(' ').slice(1).join(' ') || "King Angus",
          identification: {
            type: "CPF",
            number: cliente?.cpf?.replace(/\D/g,'') || "00000000000",
          },
        },
        external_reference: pedidoId,
        ...(process.env.WEBHOOK_BASE_URL && {
          notification_url: `${process.env.WEBHOOK_BASE_URL}/webhook`,
        }),
      },
      requestOptions: {
        idempotencyKey: pedidoId,
      },
    });

    // --- Extrai os dados do QR Code da resposta ---
    const pixData = pagamento.point_of_interaction?.transaction_data;

    if (!pixData) {
      throw new Error("Mercado Pago não retornou dados do PIX. Verifique seu token.");
    }

    // --- Salva o pedido em memória ---
    const pedido = {
      id: pedidoId,
      itens,
      total: parseFloat(total.toFixed(2)),
      status: "aguardando_pagamento",
      pagamento_id: pagamento.id,
      criado_em: new Date().toISOString(),
    };
    pedidos.set(pedidoId, pedido);

    console.log(`✅ Pedido criado: ${pedidoId} | Total: R$${total.toFixed(2)} | MP ID: ${pagamento.id}`);

    // --- Retorna os dados para o frontend ---
    return res.status(201).json({
      sucesso: true,
      pedido_id: pedidoId,
      pagamento_id: pagamento.id,
      total: pedido.total,
      status: "aguardando_pagamento",
      pix: {
        qr_code: pixData.qr_code,              // texto "copia e cola"
        qr_code_base64: pixData.qr_code_base64, // imagem base64
        expiracao: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
    });
  } catch (erro) {
    // Log completo para diagnóstico
    console.error("❌ Erro ao criar pedido — objeto completo:");
    console.error(JSON.stringify(erro, Object.getOwnPropertyNames(erro), 2));
    const detalhe = erro?.cause?.message || erro?.message || String(erro);
    const status  = erro?.status || erro?.cause?.status;
    console.error("   Status HTTP da API MP:", status);
    console.error("   Token carregado:", process.env.MP_ACCESS_TOKEN?.slice(0, 15) || "NÃO CARREGADO");
    return res.status(500).json({
      erro: "Falha ao criar o pedido.",
      detalhes: detalhe,
      status_mp: status,
    });
  }
});

// ============================================================
// ENDPOINT: GET /status-pedido/:pedidoId
// Frontend faz polling para verificar se pagamento foi aprovado
// ============================================================

app.get("/status-pedido/:pedidoId", async (req, res) => {
  const { pedidoId } = req.params;
  const pedido = pedidos.get(pedidoId);

  if (!pedido) {
    return res.status(404).json({ erro: "Pedido não encontrado." });
  }

  // Consulta status diretamente na API do Mercado Pago (fonte da verdade)
  try {
    const pagamento = await paymentClient.get({ id: pedido.pagamento_id });

    // Sincroniza status local com Mercado Pago
    if (pagamento.status === "approved" && pedido.status !== "pago") {
      pedido.status = "pago";
      pedido.pago_em = new Date().toISOString();
      pedidos.set(pedidoId, pedido);
      console.log(`💰 Pedido ${pedidoId} confirmado via polling`);
    }

    return res.json({
      pedido_id: pedidoId,
      status: pedido.status,
      status_mp: pagamento.status, // approved | pending | rejected | cancelled
      total: pedido.total,
    });
  } catch (erro) {
    // Retorna status local mesmo se MP falhar
    return res.json({ pedido_id: pedidoId, status: pedido.status, total: pedido.total });
  }
});

// ============================================================
// ENDPOINT: POST /webhook
// Mercado Pago envia notificações aqui automaticamente
// ============================================================

app.post("/webhook", async (req, res) => {
  try {
    const { type, data } = req.body;

    console.log(`🔔 Webhook recebido | Tipo: ${type} | ID: ${data?.id}`);

    // O MP envia vários tipos de eventos; só processamos pagamentos
    if (type !== "payment") {
      return res.sendStatus(200); // responde 200 para o MP não retentar
    }

    const pagamentoId = data?.id;
    if (!pagamentoId) {
      return res.sendStatus(400);
    }

    // --- Consulta os detalhes do pagamento na API do MP ---
    const pagamento = await paymentClient.get({ id: pagamentoId });

    console.log(`   Status MP: ${pagamento.status} | Ref externa: ${pagamento.external_reference}`);

    // external_reference = nosso pedidoId, que enviamos ao criar o pagamento
    const pedidoId = pagamento.external_reference;
    const pedido = pedidos.get(pedidoId);

    if (!pedido) {
      console.warn(`   ⚠️ Pedido ${pedidoId} não encontrado no nosso sistema`);
      return res.sendStatus(200); // não retenta, mas loga
    }

    // --- Processa conforme o status do pagamento ---
    switch (pagamento.status) {
      case "approved":
        pedido.status = "pago";
        pedido.pago_em = new Date().toISOString();
        pedidos.set(pedidoId, pedido);
        console.log(`   ✅ Pedido ${pedidoId} APROVADO — enviando para cozinha!`);
        // 👉 Aqui você emite evento WebSocket, envia push, salva no banco, etc.
        notificarCozinha(pedido);
        break;

      case "rejected":
        pedido.status = "rejeitado";
        pedidos.set(pedidoId, pedido);
        console.log(`   ❌ Pedido ${pedidoId} REJEITADO`);
        break;

      case "cancelled":
        pedido.status = "cancelado";
        pedidos.set(pedidoId, pedido);
        console.log(`   🚫 Pedido ${pedidoId} CANCELADO`);
        break;

      default:
        console.log(`   ⏳ Status intermediário: ${pagamento.status}`);
    }

    // IMPORTANTE: sempre responda 200 para o Mercado Pago não retentar
    return res.sendStatus(200);
  } catch (erro) {
    console.error("❌ Erro no webhook:", erro.message);
    return res.sendStatus(500);
  }
});

// ============================================================
// FUNÇÃO: Notifica a cozinha (implemente conforme seu sistema)
// Exemplos: WebSocket, email, impressora, banco de dados...
// ============================================================

function notificarCozinha(pedido) {
  // Exemplo básico — substitua pela sua lógica:
  console.log(`
  ╔══════════════════════════════╗
  ║  🍔 NOVO PEDIDO NA COZINHA!  ║
  ╠══════════════════════════════╣
  ║ ID: ${pedido.id.slice(0, 8)}               ║
  ║ Total: R$${pedido.total.toFixed(2).padEnd(20)}║
  ╚══════════════════════════════╝`);

  pedido.itens.forEach((item) => {
    console.log(`  → ${item.quantidade}x ${item.nome} — R$${item.preco.toFixed(2)}`);
  });
}

// ============================================================
// INICIA O SERVIDOR
// ============================================================

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`🌍 Ambiente: ${process.env.NODE_ENV || "desenvolvimento"}`);
  console.log(`🔑 Token MP: ${process.env.MP_ACCESS_TOKEN?.slice(0, 10)}...`);
  console.log(`📡 Webhook URL: ${process.env.WEBHOOK_BASE_URL}/webhook\n`);
});
