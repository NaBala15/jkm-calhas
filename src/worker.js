/* ==========================================================================
   PORTEIRO DO SITE — JKM Calhas e Rufos

   O site continua sendo arquivo estático, escrito à mão, servido pelo
   Cloudflare. Este Worker se mete numa coisa só: antes de entregar a
   PÁGINA, ele pergunta ao banco do painel se este site está no ar.

     no ar     →  entrega o site, igual a antes
     fora      →  entrega a página de indisponível, com 503

   É o desenho que está no HOSPEDAGEM.md da Jeff Company: o painel escreve,
   o site lê. Nada é apagado, e religar é virar o interruptor de volta.

   TRÊS DECISÕES QUE VALEM LER ANTES DE MEXER:

   1. NA DÚVIDA, O SITE FICA NO AR. Banco fora do ar, consulta que estourou,
      cliente que não está cadastrado, endereço escrito diferente: tudo isso
      entrega o site normalmente. Um erro meu nunca pode derrubar o site de
      um cliente que está pagando em dia. Tirar do ar é decisão consciente,
      nunca efeito colateral.

   2. SÓ A PÁGINA PASSA POR AQUI. Imagens, CSS e fontes vão direto para os
      arquivos. Quem não recebe a página não vê as imagens de qualquer
      jeito, e assim uma visita custa uma consulta em vez de doze.

   3. A RESPOSTA FICA GUARDADA 30 SEGUNDOS. O interruptor do painel demora
      até meio minuto para valer, e em troca o site não consulta o banco a
      cada visita.

   PARA CONFERIR SE ESTÁ FUNCIONANDO: /_jc-status devolve o que o Worker
   enxerga (o endereço que ele procurou, se achou o cliente e em que estado
   está). É por onde se descobre endereço cadastrado diferente do real.
   ========================================================================== */

const VALIDADE_MS = 30000;

/* Guardado no isolate. Some quando o Cloudflare recicla, e isso não é
   problema: a consulta seguinte refaz. */
let lembrete = { ate: 0, resposta: null };

/* "https://JKMcalhas.jeffcompany.com.br/" e "jkmcalhas.jeffcompany.com.br"
   são o mesmo site. O cadastro do painel é digitado à mão, então os dois
   lados passam por aqui antes de serem comparados. */
function soOEndereco(valor) {
  return String(valor == null ? '' : valor)
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

/* Só a navegação de uma pessoa interessa. Um arquivo com extensão conhecida
   (.jpg, .css, .woff2) nunca é página; o resto se decide pelo cabeçalho
   Accept, que o navegador manda pedindo text/html. */
function ehPedidoDePagina(request, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const temExtensao = /\.[a-z0-9]{2,5}$/i.test(url.pathname);
  if (temExtensao && !/\.html?$/i.test(url.pathname)) return false;
  return (request.headers.get('accept') || '').includes('text/html');
}

/* A consulta pede TRÊS CAMPOS, e não a ficha inteira. A ficha tem WhatsApp,
   e-mail e histórico de pagamento de todo mundo — nada disso precisa entrar
   na memória de um Worker que atende a internet aberta. Aqui chega uma lista
   de endereços com liga/desliga, e mais nada.

   A comparação de endereço fica no JavaScript, e não no SQL, porque o campo
   é digitado à mão: "https://", "www." e barra no fim precisam cair dos dois
   lados antes de comparar, e isso em SQL viraria um empilhado de replace(). */
const CONSULTA =
  "SELECT json_extract(dados, '$.site.endereco') AS endereco, " +
  "json_extract(dados, '$.site.noAr') AS noAr " +
  'FROM clientes';

/* Devolve { encontrado, noAr } — ou null quando não deu para perguntar. null
   e "não encontrado" levam ao mesmo lugar: entregar o site. */
async function consultarPainel(env, endereco) {
  if (!env.DB) return null;

  const { results } = await env.DB.prepare(CONSULTA).all();

  for (const linha of results || []) {
    if (soOEndereco(linha.endereco) !== endereco) continue;
    /* json_extract devolve 1, 0 ou NULL. Só o 0 tira do ar: campo faltando
       em ficha antiga tem que significar "no ar", nunca "derruba". */
    return { encontrado: true, noAr: linha.noAr !== 0 };
  }
  return { encontrado: false, noAr: true };
}

async function estadoDoSite(env, endereco) {
  const agora = Date.now();
  if (lembrete.resposta && agora < lembrete.ate) return lembrete.resposta;

  let resposta;
  try {
    resposta = await consultarPainel(env, endereco);
  } catch (e) {
    /* Banco fora, consulta que estourou: segue a regra 1. Não guarda a
       falha, para a próxima visita tentar de novo. */
    return { encontrado: false, noAr: true, falhou: String(e && e.message || e) };
  }

  if (!resposta) return { encontrado: false, noAr: true, semBanco: true };

  lembrete = { ate: agora + VALIDADE_MS, resposta };
  return resposta;
}

/* A página que o visitante do CLIENTE vê. Ela não acusa ninguém: não fala
   em pagamento, não cita a Jeff Company e não mostra contato — nem o do
   cliente, senão tirar do ar não serviria para nada.

   503 é o código certo: diz ao Google "isto é temporário, não tire o site
   do índice". Um 404 aqui apagaria meses de busca do cliente por engano. */
function paginaIndisponivel() {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Site temporariamente indisponível</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;
       background:#0F0F10;color:#D8DBDE;
       font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.6}
  .caixa{max-width:30rem;text-align:center}
  .marca{width:44px;height:44px;margin:0 auto 24px;border-radius:12px;
         border:1px solid #2A2A2E;display:grid;place-items:center}
  .marca svg{width:22px;height:22px;stroke:#5C6066}
  h1{margin:0 0 12px;font-size:clamp(1.4rem,4vw,1.9rem);font-weight:600;color:#F4F5F6}
  p{margin:0;color:#8A8E94;font-size:1rem}
</style>
</head>
<body>
  <div class="caixa">
    <div class="marca" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linecap="round">
        <circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>
      </svg>
    </div>
    <h1>Site temporariamente indisponível</h1>
    <p>Esta página está fora do ar no momento. Tente de novo mais tarde.</p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '3600',
      'x-robots-tag': 'noindex'
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const endereco = soOEndereco(url.hostname);

    /* Diagnóstico: mostra o que o Worker enxerga, sem contar nada de outro
       cliente. É o que responde "cadastrei certo e não saiu do ar". */
    if (url.pathname === '/_jc-status') {
      const estado = await estadoDoSite(env, endereco);
      return new Response(JSON.stringify({
        endereco,
        cadastrado: estado.encontrado,
        noAr: estado.noAr,
        observacao: estado.encontrado
          ? 'o painel manda neste site'
          : 'nenhum cliente com este endereço — o site fica no ar de qualquer jeito',
        banco: estado.semBanco ? 'sem ligação com o banco' : (estado.falhou || 'ok')
      }, null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    if (ehPedidoDePagina(request, url)) {
      const estado = await estadoDoSite(env, endereco);
      if (!estado.noAr) return paginaIndisponivel();
    }

    return env.ASSETS.fetch(request);
  }
};
