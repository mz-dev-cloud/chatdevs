let usuarioAtual = null;
let chatAtualId = null;
let chatAtualTipo = null; // 'private' | 'group'
let chatAtualOutro = null; // { id, username, email, photoUrl } do outro usuário (só em chat privado)
let chatAtualRemovido = false; // true quando o usuário foi removido desse grupo (modo fantasma: só leitura)
let chatAtualModoEnvio = 'todos'; // 'todos' | 'admins' | 'dono' — quem pode mandar mensagem no grupo atual
let chatAtualSouAdmin = false;
let chatAtualSouDono = false;
let chatAtualMembros = []; // [{id, username, photoUrl}] só quando o chat aberto é um grupo — usado nas sugestões de @menção
let mencaoAtiva = null; // { inicio, fim } = posição do "@algo" que está sendo digitado no input, ou null se não tem popup aberto
let respondendoA = null; // { id, userId, userName, snippet } da mensagem sendo respondida
let mensagensCacheAtual = new Map(); // msg.id -> msg, só do chat aberto no momento (pra montar a citação da resposta)
let socket = null;
let gravador = null;
let chunksGravacao = [];
let tipoGravando = null;
let filtroConversas = 'todas'; // 'todas' | 'grupo' | 'arquivadas'
let chatFixada = null; // { messageId, snippet } da conversa aberta
const EMOJIS_REACAO = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
let todasAsConversas = []; // cache da última lista carregada

// ---------- Controle de telas ----------
function mostrarTela(nome) {
  document.querySelectorAll('.screen').forEach(el => el.classList.add('oculto'));
  document.getElementById(nome + '-screen').classList.remove('oculto');
}

// ---------- Navegação mobile (lista de conversas <-> conteúdo principal) ----------
// No celular não cabe sidebar + área principal lado a lado, então elas viram
// duas "telas" cheias controladas por essa classe (ver style.css). No PC essa
// classe não tem efeito nenhum, o layout continua lado a lado como sempre foi.
function mostrarHomeMobile() {
  const shell = document.getElementById('chat-screen');
  if (!shell) return;

  shell.classList.add('mobile-home');
  shell.classList.remove('mostrar-main');
}

function mostrarPainelMobile() {
  const shell = document.getElementById('chat-screen');
  if (!shell) return;

  shell.classList.remove('mobile-home');
  shell.classList.add('mostrar-main');
}

function mostrarListaMobile() {
  const shell = document.getElementById('chat-screen');
  if (!shell) return;

  shell.classList.remove('mobile-home', 'mostrar-main');
}

// ---------- Inicialização ----------
window.onload = () => {
  setTimeout(() => {
    const salvo = localStorage.getItem('usuario');
    if (salvo) {
      usuarioAtual = JSON.parse(salvo);
      entrarNoChat();
    } else {
      mostrarTela('login');
    }
  }, 1700); // tempo da barra de progresso
};

// ---------- Contas (trocar sem logar de novo) ----------
function carregarContas() {
  try { return JSON.parse(localStorage.getItem('contas') || '[]'); }
  catch (e) { return []; }
}
function salvarConta(usuario) {
  usuarioAtual = usuario;
  localStorage.setItem('usuario', JSON.stringify(usuario));
  const resumo = { id: usuario.id, username: usuario.username, email: usuario.email, photoUrl: usuario.photoUrl || null };
  const contas = carregarContas().filter(c => c.id !== usuario.id);
  contas.unshift(resumo);
  localStorage.setItem('contas', JSON.stringify(contas));
}
function garantirContaNaLista() {
  if (!usuarioAtual) return;
  const contas = carregarContas();
  if (!contas.find(c => c.id === usuarioAtual.id)) {
    contas.unshift({ id: usuarioAtual.id, username: usuarioAtual.username, email: usuarioAtual.email, photoUrl: usuarioAtual.photoUrl || null });
    localStorage.setItem('contas', JSON.stringify(contas));
  }
}

function abrirTrocaConta() {
  renderContasDropdown();
  alternarDropdown('menu-contas');
}

function renderContasDropdown() {
  const contas = carregarContas();
  const el = document.getElementById('menu-contas');
  const linhas = contas.map(c => {
    const ativa = usuarioAtual && c.id === usuarioAtual.id;
    return `
      <div class="dropdown-item dropdown-clicavel conta-item ${ativa ? 'conta-ativa' : ''}" onclick="${ativa ? '' : `trocarConta('${c.id}')`}">
        <span class="conta-info">
          <span class="avatar-circle avatar-circle--sm">${avatarInnerHtml(c.username, c.photoUrl)}</span>
          <span>${escapeHtml(c.username)}</span>
        </span>
        ${ativa
          ? '<span class="conta-check">✓</span>'
          : `<span class="conta-remover" onclick="removerConta('${c.id}', event)" title="Remover da lista">✕</span>`}
      </div>`;
  }).join('');

  el.innerHTML = linhas + `
    <div class="dropdown-item dropdown-clicavel" onclick="adicionarConta()">
      <span>+ Adicionar conta</span>
    </div>`;
}

function trocarConta(id) {
  const contas = carregarContas();
  const conta = contas.find(c => c.id === id);
  if (!conta) return;
  localStorage.setItem('usuario', JSON.stringify(conta));
  location.reload();
}

function removerConta(id, event) {
  event.stopPropagation();
  const contas = carregarContas().filter(c => c.id !== id);
  localStorage.setItem('contas', JSON.stringify(contas));
  if (usuarioAtual && usuarioAtual.id === id) {
    sair();
    return;
  }
  renderContasDropdown();
}

function adicionarConta() {
  document.getElementById('menu-contas').classList.add('oculto');
  if (socket) { socket.disconnect(); socket = null; }
  mostrarTela('login');
}

function esqueceuSenha() {
  mostrarAviso('Recuperação de senha ainda não foi implementada.');
}

// ---------- Avisos (substituem os alert() feios) ----------
function mostrarAviso(mensagem, tipo) {
  const el = document.createElement('div');
  el.className = 'toast toast-' + (tipo || 'erro');
  el.textContent = mensagem;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('mostrar'));
  setTimeout(() => {
    el.classList.remove('mostrar');
    setTimeout(() => el.remove(), 250);
  }, 3500);
}

// ---------- Modal (substitui os prompt() feios) ----------
function abrirModal({ titulo, campos, textoBotao }) {
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');

    const camposHtml = campos.map(c => `
      <label class="modal-label">${escapeHtml(c.label)}
        ${c.tipo === 'textarea'
          ? `<textarea class="modal-input" id="modal-campo-${c.id}" rows="3" placeholder="${escapeHtml(c.placeholder || '')}">${escapeHtml(c.valor || '')}</textarea>`
          : `<input class="modal-input" id="modal-campo-${c.id}" type="text" placeholder="${escapeHtml(c.placeholder || '')}" value="${escapeHtml(c.valor || '')}">`}
      </label>`).join('');

    root.innerHTML = `
      <div class="modal-overlay" id="modal-overlay">
        <div class="modal-box">
          <h3 class="modal-title">${escapeHtml(titulo)}</h3>
          ${camposHtml}
          <div class="modal-actions">
            <button class="btn-outline btn-compacto" id="modal-cancelar" type="button">Cancelar</button>
            <button class="btn-ok btn-compacto" id="modal-confirmar" type="button">${escapeHtml(textoBotao)}</button>
          </div>
        </div>
      </div>`;

    const overlay = document.getElementById('modal-overlay');
    const fechar = valor => { root.innerHTML = ''; resolve(valor); };

    document.getElementById('modal-cancelar').onclick = () => fechar(null);
    overlay.onclick = e => { if (e.target === overlay) fechar(null); };
    document.addEventListener('keydown', function escFecha(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', escFecha); fechar(null); }
    });

    document.getElementById('modal-confirmar').onclick = () => {
      const valores = {};
      campos.forEach(c => { valores[c.id] = document.getElementById(`modal-campo-${c.id}`).value.trim(); });
      fechar(valores);
    };

    const primeiroInput = root.querySelector('.modal-input');
    if (primeiroInput) {
      primeiroInput.focus();
      primeiroInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') document.getElementById('modal-confirmar').click();
      });
    }
  });
}

// ---------- Configurações (tema, fundo, fonte, negrito, cor das msgs) ----------
const CONFIG_PADRAO = { tema: 'dark', fundo: 'nenhum', fonte: 'inter', negrito: false, cor: 'ambar' };

function carregarConfig() {
  try {
    return Object.assign({}, CONFIG_PADRAO, JSON.parse(localStorage.getItem('config') || '{}'));
  } catch (e) {
    return Object.assign({}, CONFIG_PADRAO);
  }
}
function salvarConfig(config) {
  localStorage.setItem('config', JSON.stringify(config));
}
function aplicarConfig(config) {
  const html = document.documentElement;
  html.setAttribute('data-theme', config.tema);
  html.setAttribute('data-fundo', config.fundo);
  html.setAttribute('data-fonte', config.fonte);
  html.setAttribute('data-negrito', config.negrito ? '1' : '0');
  html.setAttribute('data-cor-enviada', config.cor);
}
function definirConfig(chave, valor) {
  const config = carregarConfig();
  config[chave] = valor;
  salvarConfig(config);
  aplicarConfig(config);
  renderConfigModal();
}

function abrirConfiguracoes() {
  document.getElementById('menu-conta').classList.add('oculto');
  renderConfigModal();
}

async function abrirBloqueados() {
  document.getElementById('menu-conta').classList.add('oculto');
  await renderBloqueadosModal();
}

async function renderBloqueadosModal() {
  const resp = await fetch('/api/blocks?userId=' + usuarioAtual.id);
  const data = await resp.json();
  const root = document.getElementById('modal-root');

  const linhas = (data.bloqueados || []).length
    ? data.bloqueados.map(u => `
        <div class="dropdown-item conta-item">
          <span class="conta-info">
            <span class="avatar-circle avatar-circle--sm">${escapeHtml(u.username.charAt(0).toUpperCase())}</span>
            <span>${escapeHtml(u.username)}</span>
          </span>
          <button class="btn-outline btn-compacto" onclick="desbloquearDoModal('${u.id}')">Desbloquear</button>
        </div>`).join('')
    : '<p class="modal-texto">Você não bloqueou ninguém.</p>';

  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box">
        <h3 class="modal-title">Usuários bloqueados</h3>
        <div class="lista-contatos">${linhas}</div>
        <div class="modal-actions">
          <button class="btn-ok btn-compacto" id="modal-fechar-bloqueados" type="button">Fechar</button>
        </div>
      </div>
    </div>`;

  document.getElementById('modal-fechar-bloqueados').onclick = () => { root.innerHTML = ''; };
  document.getElementById('modal-overlay').onclick = e => { if (e.target.id === 'modal-overlay') root.innerHTML = ''; };
}

async function desbloquearDoModal(blockedId) {
  await fetch('/api/unblock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id, blockedId })
  });
  renderBloqueadosModal();
}

function renderConfigModal() {
  const c = carregarConfig();
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box modal-config">
        <h3 class="modal-title">Configurações</h3>

        <div class="config-grupo">
          <span class="config-label">Tema</span>
          <div class="swatches">
            <button class="swatch-tema swatch-dark ${c.tema === 'dark' ? 'ativo' : ''}" onclick="definirConfig('tema','dark')" title="Grafite premium" aria-label="Tema grafite"></button>
            <button class="swatch-tema swatch-light ${c.tema === 'light' ? 'ativo' : ''}" onclick="definirConfig('tema','light')" title="Claro" aria-label="Tema claro"></button>
            <button class="swatch-tema swatch-amoled ${c.tema === 'amoled' ? 'ativo' : ''}" onclick="definirConfig('tema','amoled')" title="Preto AMOLED" aria-label="Tema AMOLED"></button>
            <button class="swatch-tema swatch-midnight ${c.tema === 'midnight' ? 'ativo' : ''}" onclick="definirConfig('tema','midnight')" title="Meia-noite" aria-label="Tema meia-noite"></button>
            <button class="swatch-tema swatch-ocean ${c.tema === 'ocean' ? 'ativo' : ''}" onclick="definirConfig('tema','ocean')" title="Oceano" aria-label="Tema oceano"></button>
            <button class="swatch-tema swatch-violet ${c.tema === 'violet' ? 'ativo' : ''}" onclick="definirConfig('tema','violet')" title="Violeta" aria-label="Tema violeta"></button>
            <button class="swatch-tema swatch-forest ${c.tema === 'forest' ? 'ativo' : ''}" onclick="definirConfig('tema','forest')" title="Floresta" aria-label="Tema floresta"></button>
          </div>
        </div>

        <div class="config-grupo">
          <span class="config-label">Fundo das conversas</span>
          <div class="swatches">
            <button class="swatch-fundo ${c.fundo === 'nenhum'   ? 'ativo' : ''}" onclick="definirConfig('fundo','nenhum')"   title="Nenhum"></button>
            <button class="swatch-fundo fundo-pontos   ${c.fundo === 'pontos'   ? 'ativo' : ''}" onclick="definirConfig('fundo','pontos')"   title="Pontilhado"></button>
            <button class="swatch-fundo fundo-diagonal ${c.fundo === 'diagonal' ? 'ativo' : ''}" onclick="definirConfig('fundo','diagonal')" title="Diagonal"></button>
            <button class="swatch-fundo fundo-bolhas   ${c.fundo === 'bolhas'   ? 'ativo' : ''}" onclick="definirConfig('fundo','bolhas')"   title="Bolhas"></button>
            <button class="swatch-fundo fundo-aurora   ${c.fundo === 'aurora'   ? 'ativo' : ''}" onclick="definirConfig('fundo','aurora')"   title="Aurora"></button>
            <button class="swatch-fundo fundo-grade    ${c.fundo === 'grade'    ? 'ativo' : ''}" onclick="definirConfig('fundo','grade')"    title="Grade"></button>
            <button class="swatch-fundo fundo-hexagono ${c.fundo === 'hexagono' ? 'ativo' : ''}" onclick="definirConfig('fundo','hexagono')" title="Hexágono"></button>
            <button class="swatch-fundo fundo-nuvens   ${c.fundo === 'nuvens'   ? 'ativo' : ''}" onclick="definirConfig('fundo','nuvens')"   title="Nuvens"></button>
            <button class="swatch-fundo fundo-noise    ${c.fundo === 'noise'    ? 'ativo' : ''}" onclick="definirConfig('fundo','noise')"    title="Granulado"></button>
            <button class="swatch-fundo fundo-ondas    ${c.fundo === 'ondas'    ? 'ativo' : ''}" onclick="definirConfig('fundo','ondas')"    title="Ondas"></button>
          </div>
        </div>

        <div class="config-grupo">
          <span class="config-label">Fonte</span>
          <div class="swatches">
            <button class="chip ${c.fonte === 'inter' ? 'ativo' : ''}" onclick="definirConfig('fonte','inter')">Padrão</button>
            <button class="chip ${c.fonte === 'sistema' ? 'ativo' : ''}" onclick="definirConfig('fonte','sistema')">Sistema</button>
          </div>
        </div>

        <div class="config-grupo config-linha">
          <span class="config-label">Negrito</span>
          <button class="switch ${c.negrito ? 'ativo' : ''}" onclick="definirConfig('negrito', ${!c.negrito})" aria-label="Alternar negrito"></button>
        </div>

        <div class="config-grupo">
          <span class="config-label">Cor das suas mensagens</span>
          <div class="swatches">
            <button class="swatch-cor cor-ambar ${c.cor === 'ambar' ? 'ativo' : ''}" onclick="definirConfig('cor','ambar')" title="Âmbar"></button>
            <button class="swatch-cor cor-azul ${c.cor === 'azul' ? 'ativo' : ''}" onclick="definirConfig('cor','azul')" title="Azul"></button>
            <button class="swatch-cor cor-verde ${c.cor === 'verde' ? 'ativo' : ''}" onclick="definirConfig('cor','verde')" title="Verde"></button>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn-ok btn-compacto" id="modal-fechar-config" type="button">Fechar</button>
        </div>
      </div>
    </div>`;

  document.getElementById('modal-fechar-config').onclick = () => { root.innerHTML = ''; };
  document.getElementById('modal-overlay').onclick = e => { if (e.target.id === 'modal-overlay') root.innerHTML = ''; };
}

// ---------- Menus (⋮) ----------
function alternarDropdown(id) {
  document.querySelectorAll('.dropdown-menu').forEach(el => {
    if (el.id !== id) el.classList.add('oculto');
  });
  const menu = document.getElementById(id);
  if (!menu) return;
  const abrir = menu.classList.contains('oculto');
  menu.classList.toggle('oculto', !abrir);
  const trigger = menu.closest('.dropdown-wrap')?.querySelector('button');
  if (trigger) trigger.setAttribute('aria-expanded', String(abrir));
}
document.addEventListener('click', e => {
  if (!e.target.closest('.dropdown-wrap')) {
    document.querySelectorAll('.dropdown-menu').forEach(el => el.classList.add('oculto'));
  }
});

function filtrarConversas(tipo) {
  filtroConversas = tipo;
  renderizarListaChats();
  document.getElementById('menu-busca').classList.add('oculto');
}

// ---------- Auth ----------
async function fazerCadastro() {
  const username = document.getElementById('reg-username').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-pass').value;
  const erroEl = document.getElementById('reg-erro');
  erroEl.textContent = '';

  const resp = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password })
  });
  const data = await resp.json();
  if (!resp.ok) { erroEl.textContent = data.error; return; }

  usuarioAtual = data.user;
  salvarConta(usuarioAtual);
  entrarNoChat();
}

async function fazerLogin() {
  const emailOrUsername = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  const erroEl = document.getElementById('login-erro');
  erroEl.textContent = '';

  const resp = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrUsername, password })
  });
  const data = await resp.json();
  if (!resp.ok) { erroEl.textContent = data.error; return; }

  usuarioAtual = data.user;
  salvarConta(usuarioAtual);
  entrarNoChat();
}

function sair() {
  if (usuarioAtual) {
    const contas = carregarContas().filter(c => c.id !== usuarioAtual.id);
    localStorage.setItem('contas', JSON.stringify(contas));
  }
  localStorage.removeItem('usuario');
  location.reload();
}

// ---------- Entrar no chat ----------
function entrarNoChat() {
  mostrarTela('chat');
  garantirContaNaLista();
  atualizarAvatarTopo();
  document.getElementById('footer-ano').textContent = new Date().getFullYear();

  aplicarConfig(carregarConfig());

  socket = io();
  // 'connect' dispara na conexão inicial E em toda reconexão (celular que bloqueou a tela,
  // troca de wifi pra 4G, servidor reiniciando). A cada vez o servidor enxerga um socket novo,
  // sem sala nenhuma — então precisa entrar de novo, senão as mensagens param de chegar.
  socket.on('connect', () => {
    socket.emit('join', { userId: usuarioAtual.id });
    if (chatAtualId) socket.emit('join_chat', chatAtualId);
    if (socket.recuperar) { socket.recuperar = false; recarregarEstadoAtual(); }
  });
  socket.on('disconnect', () => { socket.recuperar = true; });
  sincronizarContatos();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recarregarEstadoAtual();
  });
  socket.on('send_message_error', payload => {
    mostrarAviso(payload && payload.message ? payload.message : 'Não foi possível enviar a mídia.');
  });

  socket.on('new_message', msg => {
    if (msg.chatId === chatAtualId) {
      renderizarMensagem(msg);
      marcarComoLida(msg.chatId); // já tá com a conversa aberta, não conta como não lida
      if (msg.systemMeta && msg.systemMeta.kind === 'rename') {
        document.getElementById('chat-header-nome').textContent = msg.systemMeta.novoNome;
      }
    } else {
      carregarListaChats();
    }
  });
  socket.on('message_edited', msg => {
    if (msg.chatId === chatAtualId) atualizarMensagemNaTela(msg);
    mensagensCacheAtual.set(msg.id, msg);
    if (chatFixada && chatFixada.messageId === msg.id) { chatFixada.snippet = String(msg.content || '').slice(0, 80); renderBarraFixada(); }
  });
  socket.on('message_reacted', ({ id, chatId, reactions }) => {
    if (chatId !== chatAtualId) return;
    const cache = mensagensCacheAtual.get(id);
    if (cache) cache.reactions = reactions;
    const box = document.querySelector(`.msg[data-id="${id}"] .reacoes`);
    if (box) box.innerHTML = reacoesHtml(id, reactions);
  });
  socket.on('pin_changed', ({ chatId, pinned }) => {
    if (chatId !== chatAtualId) return;
    chatFixada = pinned;
    renderBarraFixada();
  });
  socket.on('message_deleted', ({ id }) => {
    const cache = mensagensCacheAtual.get(id);
    if (cache) {
      cache.deleted = true;
      cache.content = null;
      cache.mediaUrl = null;
    }

    const antigo = document.querySelector(`[data-id="${id}"]`);
    if (antigo && cache) {
      // reconstrói a mensagem do zero a partir do estado já atualizado (deleted: true).
      // criarElementoMensagem nem gera o botão de Acessar nesse caso, então não tem
      // como ele "sobrar" na tela clicável — em vez de confiar em remover só o pedaço
      // certo do HTML antigo (frágil: qualquer coisa nova que a gente adicionar no
      // balão da mensagem no futuro teria que lembrar de ser removida aqui também).
      antigo.replaceWith(criarElementoMensagem(cache));
    } else if (antigo) {
      // fallback bem raro: mensagem apagada antes de estar no cache local
      antigo.querySelectorAll('.conteudo, .btn-acessar-link, .acoes').forEach(n => n.remove());
      const div = document.createElement('div');
      div.className = 'conteudo apagada';
      div.textContent = 'Mensagem apagada';
      antigo.prepend(div);
    }
  });
  socket.on('removido_do_grupo', ({ chatId }) => {
    mostrarAviso('Você foi removido desse grupo.');
    if (chatAtualId === chatId) {
      chatAtualRemovido = true;
      renderMenuChatAtual();
      aplicarModoSomenteLeitura();
    }
    carregarListaChats();
  });
  socket.on('solicitacao_entrada', ({ chatId, chatName, username }) => {
    // sem popup pro admin: o pedido aparece só na lista de pedidos do grupo (com o contador)
    if (chatId === chatAtualId) atualizarBadgePedidos(chatId);
  });
  socket.on('solicitacao_recusada', ({ chatName }) => {
    mostrarAviso(`Seu pedido pra entrar em "${chatName}" foi recusado.`);
  });
  socket.on('modo_envio_alterado', ({ chatId, modoEnvio }) => {
    if (chatAtualId === chatId) {
      chatAtualModoEnvio = modoEnvio;
      aplicarModoSomenteLeitura();
    }
  });

  carregarListaChats();
  carregarStats();
  carregarNovidades();
  voltarHome();
  processarConviteNaURL();
}

// ---------- Entrar num grupo pelo link (?convite=CODIGO na URL) ----------
async function entrarNoGrupoPorCodigo(code) {
  const infoResp = await fetch(`/api/invite/${code}/info?userId=${usuarioAtual.id}`);
  const info = await infoResp.json();
  if (!infoResp.ok) { mostrarAviso(info.error || 'Não foi possível entrar nesse grupo.'); return; }

  if (info.bloqueado) { mostrarAviso('Não foi possível entrar nesse grupo.'); return; }
  if (info.jaPendente) { mostrarAviso('Você já tem um pedido de entrada esperando aprovação nesse grupo.'); return; }

  if (info.approvalRequired && !info.jaEstava) {
    const aceitou = await abrirConfirmacao({
      titulo: 'Pedir pra entrar no grupo',
      mensagem: `O grupo "${info.chatName}" exige aprovação de um admin. Quer solicitar entrada?`,
      textoBotao: 'Solicitar'
    });
    if (!aceitou) return;
  }

  const resp = await fetch(`/api/invite/${code}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id })
  });
  const data = await resp.json();

  if (!resp.ok) { mostrarAviso(data.error || 'Não foi possível entrar nesse grupo.'); return; }
  if (data.pendente) { mostrarAviso('Pedido enviado! Um admin do grupo precisa aprovar.', 'sucesso'); return; }
  mostrarAviso(data.jaEstava ? 'Você já está nesse grupo.' : `Você entrou no grupo "${data.chat.name}"!`, 'sucesso');
  carregarListaChats();
}

async function processarConviteNaURL() {
  const params = new URLSearchParams(location.search);
  const code = params.get('convite');
  if (!code) return;
  history.replaceState({}, '', location.pathname); // não tenta de novo se der F5
  entrarNoGrupoPorCodigo(code);
}

// ---------- Marcar conversa como lida (zera a bolinha de não lidas) ----------
async function marcarComoLida(chatId) {
  if (!usuarioAtual || !chatId) return;
  await fetch(`/api/chats/${chatId}/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id })
  });
  carregarListaChats();
}

// busca de novo o que pode ter sido perdido enquanto o aparelho estava desconectado/dormindo
async function recarregarEstadoAtual() {
  if (!usuarioAtual) return;
  try {
    await carregarListaChats();
    sincronizarContatos();
    if (chatAtualId) {
      const resp = await fetch(`/api/chats/${chatAtualId}/messages?userId=${usuarioAtual.id}`);
      if (!resp.ok) return;
      const data = await resp.json();
      (data.messages || []).forEach(m => {
        if (!document.querySelector(`[data-id="${m.id}"]`)) renderizarMensagem(m);
      });
    }
  } catch (e) { /* tenta de novo na próxima reconexão */ }
}

// ---------- Lista de conversas ----------
async function carregarListaChats() {
  const resp = await fetch('/api/chats?userId=' + usuarioAtual.id);
  const data = await resp.json();
  todasAsConversas = data.chats;
  renderizarListaChats();
}

function renderizarListaChats() {
  const busca = (document.getElementById('busca-input').value || '').trim().toLowerCase();

  const filtradas = todasAsConversas.filter(chat => {
    if (filtroConversas === 'arquivadas') { if (!chat.arquivada) return false; }
    else if (chat.arquivada) return false;
    if (filtroConversas === 'grupo' && chat.type !== 'group') return false;
    if (busca && !chat.name.toLowerCase().includes(busca)) return false;
    return true;
  });

  const container = document.getElementById('lista-chats');
  const vazio = document.getElementById('sem-conversas');
  container.innerHTML = '';

  if (todasAsConversas.length === 0) {
    vazio.classList.remove('oculto');
    container.classList.add('oculto');
    return;
  }
  vazio.classList.add('oculto');
  container.classList.remove('oculto');

  filtradas.forEach(chat => {
    const div = document.createElement('div');
    div.className = 'item-chat' + (chat.id === chatAtualId ? ' ativo' : '');
    div.onclick = () => abrirChat(chat.id, chat.name, chat.type, chat.otherUserId, chat.otherEmail, chat.removidoDoGrupo, chat.photoUrl);

    const badgeHtml = chat.unreadCount > 0
      ? `<span class="badge-nao-lidas">${chat.unreadCount > 99 ? '99+' : chat.unreadCount}</span>`
      : '';

    const avatarHtml = `<span class="avatar-circle avatar-circle--sm avatar-perfil-abrir" role="button" tabindex="0" title="Ver perfil">${avatarInnerHtml(chat.name, chat.photoUrl)}</span>`;

    div.innerHTML = `
      <div class="item-chat-topo">
        <div class="item-chat-titulo">
          ${avatarHtml}
          <div class="nome">${escapeHtml(chat.name)}${chat.removidoDoGrupo ? ' <span class="tag-removido">(removido)</span>' : ''}</div>
        </div>
        <button class="item-menu-btn" onclick="abrirMenuChatItem(event, '${chat.id}')" aria-label="Opções da conversa">⋮</button>
      </div>
      <div class="item-chat-preview-row">
        <div class="preview">${escapeHtml(chat.lastMessage || 'Sem mensagens ainda')}</div>
        ${badgeHtml}
      </div>`;
    const avatarBtn = div.querySelector('.avatar-perfil-abrir');
    if (avatarBtn && chat.type !== 'group' && chat.otherUserId) {
      avatarBtn.addEventListener('click', e => { e.stopPropagation(); abrirPerfilUsuario(chat.otherUserId); });
      avatarBtn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); abrirPerfilUsuario(chat.otherUserId); } });
    }
    container.appendChild(div);
  });
}

// ---------- Menu flutuante (usado no ⋮ de cada conversa da lista) ----------
function fecharMenuFlutuante() {
  const el = document.getElementById('menu-flutuante');
  if (el) el.remove();
}

function abrirMenuFlutuante(botaoEl, itensHtml) {
  fecharMenuFlutuante();
  const rect = botaoEl.getBoundingClientRect();

  const el = document.createElement('div');
  el.id = 'menu-flutuante';
  el.className = 'dropdown-menu';
  el.innerHTML = itensHtml;
  document.body.appendChild(el);

  el.style.top = (rect.bottom + 6) + 'px';
  el.style.left = Math.max(8, rect.right - el.offsetWidth) + 'px';

  // se estourar embaixo da tela, abre pra cima do botão
  const alturaMenu = el.offsetHeight;
  if (rect.bottom + 6 + alturaMenu > window.innerHeight) {
    el.style.top = (rect.top - alturaMenu - 6) + 'px';
  }
}

document.addEventListener('click', e => {
  if (!e.target.closest('#menu-flutuante') && !e.target.closest('.item-menu-btn')) {
    fecharMenuFlutuante();
  }
});

function abrirMenuChatItem(event, chatId) {
  event.stopPropagation();
  const chat = todasAsConversas.find(c => c.id === chatId);
  if (!chat) return;

  const itens = chat.removidoDoGrupo
    ? `<div class="dropdown-item dropdown-clicavel" onclick="fecharMenuFlutuante(); apagarConversa('${chat.id}', true)"><span>Apagar conversa</span></div>`
    : chat.type === 'group'
    ? `<div class="dropdown-item dropdown-clicavel" onclick="fecharMenuFlutuante(); abrirConfigGrupo('${chat.id}')"><span>Configurações do grupo</span></div>
       <div class="dropdown-item dropdown-clicavel" onclick="fecharMenuFlutuante(); apagarConversa('${chat.id}')"><span>Apagar conversa</span></div>
       <div class="dropdown-item dropdown-clicavel" onclick="fecharMenuFlutuante(); sairDoGrupo('${chat.id}')"><span>Sair do grupo</span></div>`
    : `<div class="dropdown-item dropdown-clicavel" onclick="fecharMenuFlutuante(); apagarConversa('${chat.id}')"><span>Apagar conversa</span></div>
       ${chat.ehAutoConversa ? '' : `<div class="dropdown-item dropdown-clicavel" onclick="fecharMenuFlutuante(); bloquearUsuario('${chat.otherUserId}', '${chat.id}')"><span>Bloquear usuário</span></div>`}`;

  const itemArquivar = `<div class="dropdown-item dropdown-clicavel" onclick="fecharMenuFlutuante(); arquivarConversa('${chat.id}', ${!chat.arquivada})"><span>${chat.arquivada ? 'Desarquivar' : 'Arquivar'}</span></div>`;
  abrirMenuFlutuante(event.currentTarget, itemArquivar + itens);
}

async function arquivarConversa(chatId, arquivar) {
  await fetch(`/api/chats/${chatId}/archive`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id, archived: arquivar })
  });
  carregarListaChats();
}

// ---------- Estatísticas da home ----------
async function carregarNovidades() {
  try {
    const resp = await fetch('/api/novidades');
    const { novidades } = await resp.json();
    const el = document.querySelector('.home-section');
    if (!el) return;
    if (!novidades || !novidades.length) {
      el.innerHTML = '<h2>Novidades</h2><p class="texto-vazio">Nenhuma novidade publicada ainda.</p>';
      return;
    }
    el.innerHTML = '<h2>Novidades</h2>' + novidades.map(n => `
      <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px">
        ${n.imageUrl ? `<img src="${n.imageUrl}" style="width:100%;max-height:180px;object-fit:cover;border-radius:6px;margin-bottom:10px" alt="">` : ''}
        <div style="font-weight:600;font-size:14px;margin-bottom:4px">${escapeHtml(n.titulo)}</div>
        <div style="font-size:13px;color:var(--text-muted);line-height:1.5">${escapeHtml(n.texto)}</div>
      </div>`).join('');
  } catch(e) {}
}

async function carregarStats() {
  const resp = await fetch('/api/stats');
  const data = await resp.json();

  const rankingEl = document.getElementById('ranking-usuarios');
  if (data.usuariosMaisAtivos && data.usuariosMaisAtivos.length) {
    rankingEl.innerHTML = data.usuariosMaisAtivos.map((u, i) => `
      <div class="ranking-row">
        <span class="ranking-pos">${i + 1}</span>
        <span class="ranking-nome">${escapeHtml(u.username)}</span>
        <span class="ranking-valor">${u.total} conversa${u.total === 1 ? '' : 's'} iniciada${u.total === 1 ? '' : 's'}</span>
      </div>`).join('');
  }

  const grupoEl = document.getElementById('grupo-destaque-wrap');
  if (data.grupoMaisAtivo) {
    const g = data.grupoMaisAtivo;
    grupoEl.innerHTML = `
      <div class="grupo-destaque">
        <strong>${escapeHtml(g.nome)}</strong>
        <span>${g.totalMensagens} mensagem${g.totalMensagens === 1 ? '' : 's'} · ${g.totalMembros} participante${g.totalMembros === 1 ? '' : 's'}</span>
      </div>`;
  }
}

// ---------- Contatos salvos (ficam no SERVIDOR, iguais em qualquer aparelho) ----------
// contatosCache é só uma cópia em memória da lista do servidor, pra tela não esperar rede.
let contatosCache = [];

function carregarContatos() {
  return contatosCache;
}
function contatoSalvo(id) {
  return contatosCache.some(c => c.id === id);
}
function salvarContato(contato) {
  contatosCache = contatosCache.filter(c => c.id !== contato.id);
  contatosCache.unshift({ id: contato.id, username: contato.username, email: contato.email || null, photoUrl: contato.photoUrl || null });
}
function apagarContato(id) {
  contatosCache = contatosCache.filter(c => c.id !== id);
}

// baixa a lista do servidor. Na primeira vez em que este navegador roda a versão nova,
// sobe pro servidor os contatos que estavam só no localStorage (pra ninguém perder os antigos).
async function sincronizarContatos() {
  if (!usuarioAtual) return;
  const chaveAntiga = 'contatos_' + usuarioAtual.id;
  try {
    const antigos = JSON.parse(localStorage.getItem(chaveAntiga) || '[]');
    if (antigos.length) {
      await Promise.all(antigos.map(c => fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerId: usuarioAtual.id, contactId: c.id })
      })));
    }
    localStorage.removeItem(chaveAntiga);
  } catch (e) { /* sem problema, segue com a lista do servidor */ }

  try {
    const resp = await fetch('/api/contacts?ownerId=' + encodeURIComponent(usuarioAtual.id));
    if (!resp.ok) return;
    const data = await resp.json();
    contatosCache = data.contacts || [];
    renderContatoBanner();
  } catch (e) { /* offline: mantém o que já tinha */ }
}

function abrirNovaConversa() {
  renderNovaConversaModal();
}

async function renderNovaConversaModal() {
  const contatos = carregarContatos();
  const root = document.getElementById('modal-root');

  // nunca confia na foto que ficou guardada no cache local pra isso — ela pode estar
  // desatualizada (privacidade mudou, contato foi apagado, etc). Busca sempre fresca.
  const fotos = await Promise.all(contatos.map(c =>
    fetch(`/api/users/${c.id}/public?viewerId=${usuarioAtual.id}`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
  ));
  contatos.forEach((c, i) => { c.photoUrl = fotos[i] ? fotos[i].photoUrl : null; });

  const opcaoVoce = `
    <div class="dropdown-item conta-item">
      <span class="conta-info dropdown-clicavel" onclick="iniciarConversaComContato('${usuarioAtual.id}', '${escapeHtml(usuarioAtual.username)}', '${escapeHtml(usuarioAtual.email || '')}', ${usuarioAtual.photoUrl ? `'${escapeAttr(usuarioAtual.photoUrl)}'` : 'null'})">
        <span class="avatar-circle avatar-circle--sm">${avatarInnerHtml(usuarioAtual.username, usuarioAtual.photoUrl)}</span>
        <span>${escapeHtml(usuarioAtual.username)} <span class="tag-voce">(Você)</span></span>
      </span>
    </div>`;

  const listaContatos = `
    <div class="config-grupo">
      <span class="config-label">Seus contatos salvos</span>
      <div class="lista-contatos">
        ${opcaoVoce}
        ${contatos.map(c => `
          <div class="dropdown-item conta-item">
            <span class="conta-info dropdown-clicavel" onclick="iniciarConversaComContato('${c.id}', '${escapeHtml(c.username)}', '${escapeHtml(c.email || '')}', ${c.photoUrl ? `'${escapeAttr(c.photoUrl)}'` : 'null'})">
              <span class="avatar-circle avatar-circle--sm">${avatarInnerHtml(c.username, c.photoUrl)}</span>
              <span>${escapeHtml(c.username)}</span>
            </span>
            <span class="conta-remover" onclick="apagarContatoNoModal('${c.id}', event)" title="Apagar contato">✕</span>
          </div>`).join('')}
      </div>
    </div>`;

  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box">
        <h3 class="modal-title">Iniciar conversa</h3>
        ${listaContatos}
        <label class="modal-label">Ou digite o email ou usuário da pessoa
          <input class="modal-input" id="nova-conversa-query" type="text" placeholder="ex: maria ou maria@email.com">
        </label>
        <div class="modal-actions">
          <button class="btn-outline btn-compacto" id="modal-cancelar" type="button">Cancelar</button>
          <button class="btn-ok btn-compacto" id="modal-confirmar" type="button">Buscar</button>
        </div>
      </div>
    </div>`;

  const overlay = document.getElementById('modal-overlay');
  const fechar = () => { root.innerHTML = ''; };
  document.getElementById('modal-cancelar').onclick = fechar;
  overlay.onclick = e => { if (e.target === overlay) fechar(); };

  document.getElementById('modal-confirmar').onclick = async () => {
    const query = document.getElementById('nova-conversa-query').value.trim();
    fechar();
    if (query) await iniciarConversaPorBusca(query);
  };

  const input = document.getElementById('nova-conversa-query');
  input.focus();
  input.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('modal-confirmar').click(); });
}

function apagarContatoNoModal(id, event) {
  event.stopPropagation();
  apagarContato(id);
  fetch('/api/contacts/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId: usuarioAtual.id, contactId: id })
  });
  renderNovaConversaModal();
}

async function iniciarConversaPorBusca(query) {
  const busca = await fetch('/api/find-user?query=' + encodeURIComponent(query) + '&viewerId=' + encodeURIComponent(usuarioAtual.id));
  const dataBusca = await busca.json();
  if (!busca.ok) { mostrarAviso(dataBusca.error); return; }
  await criarChatPrivado(dataBusca.user.id, dataBusca.user.username, dataBusca.user.email, dataBusca.user.photoUrl);
}

function iniciarConversaComContato(id, username, email, photoUrl) {
  document.getElementById('modal-root').innerHTML = '';
  criarChatPrivado(id, username, email, photoUrl);
}

// ---------- Confirmação simples (sim/não) ----------
function abrirConfirmacao({ titulo, mensagem, textoBotao }) {
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-overlay" id="modal-overlay">
        <div class="modal-box">
          <h3 class="modal-title">${escapeHtml(titulo)}</h3>
          <p class="modal-texto">${escapeHtml(mensagem)}</p>
          <div class="modal-actions">
            <button class="btn-outline btn-compacto" id="modal-cancelar" type="button">Cancelar</button>
            <button class="btn-ok btn-compacto" id="modal-confirmar" type="button">${escapeHtml(textoBotao)}</button>
          </div>
        </div>
      </div>`;
    const overlay = document.getElementById('modal-overlay');
    const fechar = valor => { root.innerHTML = ''; resolve(valor); };
    document.getElementById('modal-cancelar').onclick = () => fechar(false);
    overlay.onclick = e => { if (e.target === overlay) fechar(false); };
    document.getElementById('modal-confirmar').onclick = () => fechar(true);
  });
}

async function criarChatPrivado(targetUserId, username, email, photoUrl) {
  const resp = await fetch('/api/chats/private', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id, targetUserId })
  });
  const data = await resp.json();

  if (!resp.ok) {
    if (resp.status === 404) {
      apagarContato(targetUserId);
      mostrarAviso('Essa pessoa não existe mais. Removi ela dos seus contatos salvos.');
      return;
    }
    if (data.bloqueadoPorMim) {
      const aceitou = await abrirConfirmacao({
        titulo: 'Usuário bloqueado',
        mensagem: `Você bloqueou ${username}. Se continuar a conversa, ele será desbloqueado. Deseja continuar?`,
        textoBotao: 'Desbloquear e continuar'
      });
      if (!aceitou) return;
      await fetch('/api/unblock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: usuarioAtual.id, blockedId: targetUserId })
      });
      return criarChatPrivado(targetUserId, username, email, photoUrl);
    }
    mostrarAviso(data.error || 'Não foi possível iniciar essa conversa.');
    return;
  }

  abrirChat(data.chat.id, username, 'private', targetUserId, email, false, photoUrl);
  carregarListaChats();
  carregarStats();
}

async function abrirNovoGrupo() {
  const valores = await abrirModal({
    titulo: 'Criar grupo',
    campos: [
      { id: 'nome', label: 'Nome do grupo', placeholder: 'ex: Galera do trampo' },
      { id: 'membros', label: 'Participantes (email ou usuário, separados por vírgula)', placeholder: 'maria, joao@email.com' }
    ],
    textoBotao: 'Criar'
  });
  if (!valores || !valores.nome) return;
  const nome = valores.nome;
  const lista = (valores.membros || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!lista.length) {
    mostrarAviso('Adicione pelo menos uma pessoa pra criar o grupo.');
    return;
  }

  const resp = await fetch('/api/chats/group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id, name: nome, memberQueries: lista })
  });
  const data = await resp.json();

  if (!resp.ok) {
    mostrarAviso(data.error || 'Não foi possível criar o grupo.');
    return;
  }

  if (data.naoEncontrados && data.naoEncontrados.length) {
    mostrarAviso('Não encontrado: ' + data.naoEncontrados.join(', '));
  }
  if (data.bloqueados && data.bloqueados.length) {
    data.bloqueados.forEach(nome => mostrarAviso('Não foi possível adicionar ' + nome));
  }
  abrirChat(data.chat.id, nome, 'group', null, null);
  carregarListaChats();
  carregarStats();
}

// Status do cabeçalho: usa apenas presença/último acesso quando a API fornece esses dados.
function atualizarStatusCabecalho(contato, tipo) {
  const el = document.getElementById('chat-header-status');
  if (!el) return;
  el.classList.remove('is-online');
  if (tipo === 'group') { el.textContent = 'Grupo'; return; }
  if (!contato) { el.textContent = 'Status não compartilhado'; return; }
  const online = contato.online === true || contato.isOnline === true || contato.is_online === true;
  const ultimo = contato.lastSeen || contato.last_seen || contato.lastSeenAt || contato.last_seen_at || contato.lastActiveAt;
  if (online) { el.textContent = 'Online'; el.classList.add('is-online'); return; }
  if (ultimo) {
    const d = new Date(ultimo);
    if (!Number.isNaN(d.getTime())) {
      const hora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(d);
      const data = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
      el.textContent = `Visto por último ${hora} • ${data}`;
      return;
    }
  }
  el.textContent = 'Status não compartilhado';
}

// ---------- Abrir um chat ----------
async function abrirChat(chatId, nome, tipo, outroId, outroEmail, removidoDoGrupo, photoUrl) {
  chatAtualId = chatId;
  chatAtualTipo = tipo || 'private';
  const contatoAnterior = (chatAtualOutro && String(chatAtualOutro.id) === String(outroId)) ? chatAtualOutro : null;
  chatAtualOutro = outroId ? { ...(contatoAnterior || {}), id: outroId, username: nome, email: outroEmail || null, photoUrl: photoUrl || null } : null;
  chatAtualRemovido = !!removidoDoGrupo;
  chatAtualModoEnvio = 'todos';
  chatAtualSouAdmin = false;
  chatAtualSouDono = false;
  chatAtualMembros = [];
  esconderMencaoPopup();
  if (typeof sairDoModoEncaminhar === 'function') sairDoModoEncaminhar();

  document.getElementById('chat-header-nome').textContent = nome;
  document.getElementById('chat-header-avatar').innerHTML = avatarInnerHtml(nome, photoUrl || null);
  const headerAvatar = document.getElementById('chat-header-avatar');
  if (headerAvatar) { headerAvatar.style.cursor = tipo === 'group' ? 'default' : 'pointer'; headerAvatar.onclick = () => { if (tipo !== 'group' && chatAtualOutro) abrirPerfilUsuario(chatAtualOutro.id); }; }
  atualizarStatusCabecalho(chatAtualOutro, chatAtualTipo);
  document.getElementById('home-view').classList.add('oculto');
  document.getElementById('chat-view').classList.remove('oculto');
  mostrarPainelMobile();
  renderContatoBanner();
  renderMenuChatAtual();
  aplicarAparenciaChat();
  aplicarModoSomenteLeitura();

  socket.emit('join_chat', chatId); // se for fantasma, o servidor ignora isso e não recebe mensagem nova
  cancelarResposta();

  if (tipo === 'group' && !chatAtualRemovido) await atualizarPermissoesGrupo(chatId);

  const resp = await fetch(`/api/chats/${chatId}/messages?userId=${usuarioAtual.id}`);
  const data = await resp.json();
  const container = document.getElementById('mensagens');
  container.innerHTML = '';
  mensagensCacheAtual = new Map();
  data.messages.forEach(renderizarMensagem);
  chatFixada = data.pinned || null;
  renderBarraFixada();
  if (!chatAtualRemovido) marcarComoLida(chatId);

  if (tipo === 'group' && !chatAtualRemovido) atualizarBadgePedidos(chatId);
  else esconderBadgePedidos();
}

// ---------- Busca quem pode mandar mensagem no grupo atual e o papel do usuário nele ----------
async function atualizarPermissoesGrupo(chatId) {
  const resp = await fetch(`/api/chats/${chatId}/members?userId=${usuarioAtual.id}`);
  if (!resp.ok) return;
  const data = await resp.json();
  if (chatAtualId !== chatId) return; // já trocou de conversa enquanto a requisição rodava
  chatAtualModoEnvio = data.modoEnvio || 'todos';
  chatAtualSouAdmin = !!data.souAdmin;
  chatAtualSouDono = !!data.souDono;
  chatAtualMembros = data.membros || [];
  aplicarModoSomenteLeitura();
}

// ---------- Ícone (👤n) de pedidos de entrada pendentes, do lado do menu de 3 pontinhos ----------
async function atualizarBadgePedidos(chatId) {
  // só admin/dono pode ver os pedidos; pra quem não é, nem pergunta (evita o erro 403 no console)
  if (chatId === chatAtualId && !chatAtualSouAdmin) { esconderBadgePedidos(); return; }
  const resp = await fetch(`/api/chats/${chatId}/invite?userId=${usuarioAtual.id}`);
  const btn = document.getElementById('btn-pedidos-grupo');
  if (!resp.ok) { esconderBadgePedidos(); return; } // não é admin, ou grupo sem link ainda
  const data = await resp.json();
  const badge = document.getElementById('badge-pedidos-grupo');
  const total = (data.joinRequests || []).length;
  if (chatAtualId !== chatId) return; // já saiu desse chat enquanto a requisição rodava
  btn.classList.remove('oculto');
  if (total > 0) {
    badge.textContent = total > 9 ? '9+' : String(total);
    badge.classList.remove('oculto');
  } else {
    badge.classList.add('oculto');
  }
}
function esconderBadgePedidos() {
  document.getElementById('btn-pedidos-grupo').classList.add('oculto');
  document.getElementById('badge-pedidos-grupo').classList.add('oculto');
}

// ---------- Janelinha rápida de pedidos pra entrar (aberta pelo ícone de usuários, sem passar pelo menu de 3 pontinhos) ----------
async function abrirPedidosPendentes(chatId) {
  if (!chatId) return;
  const resp = await fetch(`/api/chats/${chatId}/invite?userId=${usuarioAtual.id}`);
  if (!resp.ok) { mostrarAviso('Não foi possível ver os pedidos de entrada.'); return; }
  const data = await resp.json();
  const root = document.getElementById('modal-root');

  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box">
        <h3 class="modal-title">Pedidos pra entrar</h3>
        <div class="lista-contatos">${montarListaPedidos(chatId, data.joinRequests || [])}</div>
        <div class="modal-actions">
          <button class="btn-ok btn-compacto" id="pedidos-fechar" type="button">Fechar</button>
        </div>
      </div>
    </div>`;

  document.getElementById('pedidos-fechar').onclick = () => { root.innerHTML = ''; };
  document.getElementById('modal-overlay').onclick = e => { if (e.target.id === 'modal-overlay') root.innerHTML = ''; };
}

// ---------- Decide se dá pra mandar mensagem na conversa aberta agora ----------
function podeEnviarNoChatAtual() {
  if (chatAtualRemovido) return false;
  if (chatAtualTipo !== 'group') return true;
  if (chatAtualModoEnvio === 'admins') return chatAtualSouAdmin;
  if (chatAtualModoEnvio === 'dono') return chatAtualSouDono;
  return true;
}

// ---------- Modo fantasma (removido) ou grupo fechado: esconde a caixa de digitar e mostra um aviso ----------
function aplicarModoSomenteLeitura() {
  const inputArea = document.querySelector('#chat-view .input-area');
  let aviso = document.getElementById('aviso-removido');

  if (!podeEnviarNoChatAtual()) {
    if (inputArea) inputArea.style.display = 'none';
    if (!aviso) {
      aviso = document.createElement('div');
      aviso.id = 'aviso-removido';
      aviso.className = 'aviso-removido';
      inputArea.parentNode.insertBefore(aviso, inputArea);
    }
    aviso.textContent = chatAtualRemovido
      ? '       Você foi saiu ou foi removido desse grupo.'
      : chatAtualModoEnvio === 'dono'
        ? 'Esse grupo está restrito: só o dono pode mandar mensagem.'
        : 'Esse grupo está fechado: só admins podem mandar mensagem.';
  } else {
    if (inputArea) inputArea.style.display = '';
    if (aviso) aviso.remove();
  }
}

// ---------- Banner de contato (só aparece quando ainda NÃO tá salvo) ----------
function renderContatoBanner() {
  const banner = document.getElementById('contato-banner');
  const salvo = chatAtualOutro && contatoSalvo(chatAtualOutro.id);

  if (!chatAtualOutro || salvo) {
    banner.classList.add('oculto');
    banner.innerHTML = '';
    return;
  }

  banner.classList.remove('oculto');
  banner.innerHTML = `<span>👤 Usuário desconhecido</span><button class="btn-salvar-contato" onclick="salvarContatoDoBanner()">Salvar contato</button>`;
}
function salvarContatoDoBanner() {
  if (!chatAtualOutro) return;
  salvarContato(chatAtualOutro);
  fetch('/api/contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId: usuarioAtual.id, contactId: chatAtualOutro.id })
  });
  renderContatoBanner();
  mostrarAviso('Contato salvo!', 'sucesso');
}

// ---------- Menu de opções da conversa aberta (apagar / sair / bloquear) ----------
function renderMenuChatAtual() {
  const el = document.getElementById('menu-chat-atual');
  if (!chatAtualId) { el.innerHTML = ''; return; }

  if (chatAtualRemovido) {
    el.innerHTML = `<div class="dropdown-item dropdown-clicavel" onclick="document.getElementById('menu-chat-atual').classList.add('oculto'); document.querySelector('.chat-options-trigger')?.setAttribute('aria-expanded','false'); abrirAparenciaChat()"><i class="mdi mdi-palette-outline"></i><span>Aparência do chat</span></div><div class="dropdown-item dropdown-clicavel" onclick="apagarConversa(chatAtualId, true)"><span>Apagar conversa</span></div>`;
    return;
  }

  const ehAutoConversa = chatAtualOutro && chatAtualOutro.id === usuarioAtual.id;

  el.innerHTML = chatAtualTipo === 'group'
    ? `<div class="dropdown-item dropdown-clicavel" onclick="document.getElementById('menu-chat-atual').classList.add('oculto'); document.querySelector('.chat-options-trigger')?.setAttribute('aria-expanded','false'); abrirAparenciaChat()"><i class="mdi mdi-palette-outline"></i><span>Aparência do chat</span></div>
       <div class="dropdown-item dropdown-clicavel" onclick="abrirConfigGrupo(chatAtualId)"><span>Configurações do grupo</span></div>
       <div class="dropdown-item dropdown-clicavel" onclick="apagarConversa(chatAtualId)"><span>Apagar conversa</span></div>
       <div class="dropdown-item dropdown-clicavel" onclick="sairDoGrupo(chatAtualId)"><span>Sair do grupo</span></div>`
    : `<div class="dropdown-item dropdown-clicavel" onclick="document.getElementById('menu-chat-atual').classList.add('oculto'); document.querySelector('.chat-options-trigger')?.setAttribute('aria-expanded','false'); abrirAparenciaChat()"><i class="mdi mdi-palette-outline"></i><span>Aparência do chat</span></div>
       <div class="dropdown-item dropdown-clicavel" onclick="apagarConversa(chatAtualId)"><span>Apagar conversa</span></div>
       ${ehAutoConversa ? '' : `<div class="dropdown-item dropdown-clicavel" onclick="bloquearUsuario(chatAtualOutro && chatAtualOutro.id, chatAtualId)"><span>Bloquear usuário</span></div>`}`;
}

// ---------- Personalização visual da conversa ----------
const CHAT_APPEAR_KEY = 'chatdevs_aparencia_conversa_v1';
function lerAparenciaChat() {
  try { return Object.assign({ cor: '#ffb454', opacidade: 92, estilo: 'suave', tamanhoTexto: 14, wallpaper: '' }, JSON.parse(localStorage.getItem(CHAT_APPEAR_KEY) || '{}')); }
  catch (_) { return { cor: '#ffb454', opacidade: 92, estilo: 'suave', tamanhoTexto: 14, wallpaper: '' }; }
}
function salvarAparenciaChat(cfg) {
  localStorage.setItem(CHAT_APPEAR_KEY, JSON.stringify(cfg));
  aplicarAparenciaChat();
}
function aplicarAparenciaChat() {
  const cfg = lerAparenciaChat();
  const mensagens = document.getElementById('mensagens');
  if (!mensagens) return;
  mensagens.style.setProperty('--chat-bubble-color', cfg.cor);
  mensagens.style.setProperty('--chat-bubble-opacity', `${Math.max(20, Math.min(100, Number(cfg.opacidade) || 92))}%`);
  mensagens.dataset.bubbleStyle = cfg.estilo || 'suave';
  mensagens.style.setProperty('--chat-bubble-font-size', `${Math.max(12, Math.min(22, Number(cfg.tamanhoTexto) || 14))}px`);
  if (cfg.wallpaper) {
    mensagens.style.setProperty('--chat-wallpaper-image', `url("${cfg.wallpaper}")`);
    mensagens.classList.add('com-wallpaper');
  } else {
    mensagens.style.removeProperty('--chat-wallpaper-image');
    mensagens.classList.remove('com-wallpaper');
  }
}
function abrirAparenciaChat() {
  document.querySelectorAll('.dropdown-menu').forEach(el => el.classList.add('oculto'));
  const cfg = lerAparenciaChat();
  const root = document.getElementById('modal-root');
  if (!root) return;
  const anterior = document.getElementById('modal-aparencia-chat'); if (anterior) anterior.remove();
  const modal = document.createElement('div');
  modal.id = 'modal-aparencia-chat'; modal.className = 'chat-appearance-backdrop';
  modal.innerHTML = `
    <section class="chat-appearance-panel" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
      <header class="appearance-head"><div><span class="appearance-eyebrow">PERSONALIZAÇÃO</span><h2 id="appearance-title">A aparência do seu chat</h2><p>Deixe a conversa com a sua identidade.</p></div><button type="button" class="appearance-close" aria-label="Fechar" data-close>×</button></header>
      <div class="appearance-content">
        <label class="appearance-label" for="bubble-color">Cor das bolhas</label>
        <div class="appearance-color-row"><input id="bubble-color" type="color" value="${cfg.cor}"><div class="appearance-swatches">${['#ffb454','#8b5cf6','#38bdf8','#34d399','#fb7185','#f1f5f9'].map(c=>`<button type="button" class="appearance-swatch" data-color="${c}" style="--swatch:${c}" aria-label="Cor ${c}"></button>`).join('')}</div></div>
        <div class="appearance-range-head"><label class="appearance-label" for="bubble-opacity">Opacidade das bolhas</label><output id="bubble-opacity-value">${cfg.opacidade}%</output></div>
        <input class="appearance-range" id="bubble-opacity" type="range" min="20" max="100" step="5" value="${cfg.opacidade}">
        <div class="appearance-range-head"><label class="appearance-label" for="bubble-text-size">Tamanho do texto nas bolhas</label><output id="bubble-text-size-value">${Math.max(12, Math.min(22, Number(cfg.tamanhoTexto) || 14))} px</output></div>
        <input class="appearance-range" id="bubble-text-size" type="range" min="12" max="22" step="1" value="${Math.max(12, Math.min(22, Number(cfg.tamanhoTexto) || 14))}">
        <label class="appearance-label">Estilo das bolhas</label><div class="appearance-styles"><button type="button" data-style="suave" class="appearance-style ${cfg.estilo==='suave'?'selected':''}"><span class="style-preview style-soft"></span><b>Suave</b><small>Arredondado</small></button><button type="button" data-style="compacto" class="appearance-style ${cfg.estilo==='compacto'?'selected':''}"><span class="style-preview style-compact"></span><b>Compacto</b><small>Mais discreto</small></button><button type="button" data-style="vidro" class="appearance-style ${cfg.estilo==='vidro'?'selected':''}"><span class="style-preview style-glass"></span><b>Vidro</b><small>Translúcido</small></button></div>
        <label class="appearance-label">Papel de parede</label><div class="wallpaper-actions"><button type="button" class="appearance-upload" id="appearance-upload"><i class="mdi mdi-image-plus-outline"></i><span><b>Escolher imagem</b><small>Use uma imagem do seu dispositivo</small></span><i class="mdi mdi-chevron-right"></i></button><input type="file" id="appearance-wallpaper-file" accept="image/*" hidden><button type="button" class="appearance-remove" id="appearance-remove" ${cfg.wallpaper?'':'disabled'}><i class="mdi mdi-image-remove-outline"></i> Remover imagem e voltar ao fundo padrão</button></div>
      </div><footer class="appearance-footer"><button type="button" class="appearance-reset" id="appearance-reset">Restaurar padrão</button><button type="button" class="appearance-done" data-close>Aplicar alterações</button></footer>
    </section>`;
  root.appendChild(modal);
  const color = modal.querySelector('#bubble-color'), opacity = modal.querySelector('#bubble-opacity'), textSize = modal.querySelector('#bubble-text-size');
  const update = () => { const next = {...lerAparenciaChat(), cor: color.value, opacidade: Number(opacity.value), tamanhoTexto: Number(textSize.value)}; modal.querySelector('#bubble-opacity-value').textContent = `${opacity.value}%`; modal.querySelector('#bubble-text-size-value').textContent = `${textSize.value} px`; salvarAparenciaChat(next); };
  color.addEventListener('input', update); opacity.addEventListener('input', update); textSize.addEventListener('input', update);
  modal.querySelectorAll('[data-color]').forEach(b=>b.addEventListener('click',()=>{color.value=b.dataset.color;update();}));
  modal.querySelectorAll('[data-style]').forEach(b=>b.addEventListener('click',()=>{modal.querySelectorAll('[data-style]').forEach(x=>x.classList.toggle('selected',x===b));salvarAparenciaChat({...lerAparenciaChat(),estilo:b.dataset.style});}));
  modal.querySelector('#appearance-upload').addEventListener('click',()=>modal.querySelector('#appearance-wallpaper-file').click());
  modal.querySelector('#appearance-wallpaper-file').addEventListener('change', async e=>{
    const file=e.target.files && e.target.files[0]; if(!file)return;
    if(!file.type.startsWith('image/')){mostrarAviso('Escolha um arquivo de imagem.');return;}
    if(file.size>12*1024*1024){mostrarAviso('A imagem deve ter no máximo 12 MB.');return;}
    try {
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
      const img=await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=reject;im.src=data;});
      const scale=Math.min(1,1600/Math.max(img.width,img.height)); const canvas=document.createElement('canvas');canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
      const wallpaper=canvas.toDataURL('image/jpeg',0.82); const next={...lerAparenciaChat(),wallpaper};
      try{localStorage.setItem(CHAT_APPEAR_KEY,JSON.stringify(next));}catch(_){mostrarAviso('Imagem muito grande para salvar neste dispositivo. Escolha uma imagem menor.');return;}
      aplicarAparenciaChat();modal.querySelector('#appearance-remove').disabled=false;mostrarAviso('Papel de parede aplicado neste dispositivo.','sucesso');
    }catch(_){mostrarAviso('Não foi possível carregar essa imagem.');}
  });
  modal.querySelector('#appearance-remove').addEventListener('click',()=>{salvarAparenciaChat({...lerAparenciaChat(),wallpaper:''});modal.querySelector('#appearance-remove').disabled=true;});
  modal.querySelector('#appearance-reset').addEventListener('click',()=>{salvarAparenciaChat({cor:'#ffb454',opacidade:92,estilo:'suave',tamanhoTexto:14,wallpaper:''});modal.remove();abrirAparenciaChat();});
  modal.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>modal.remove()));
  modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});
}
document.addEventListener('DOMContentLoaded', aplicarAparenciaChat);

// ---------- Configurações do grupo (dono/admin, remover pessoas) ----------
async function abrirConfigGrupo(chatId) {
  document.querySelectorAll('.dropdown-menu').forEach(el => el.classList.add('oculto'));
  await renderConfigGrupoModal(chatId);
}

async function renderConfigGrupoModal(chatId) {
  const resp = await fetch(`/api/chats/${chatId}/members?userId=${usuarioAtual.id}`);
  if (!resp.ok) { mostrarAviso('Não foi possível abrir as configurações do grupo.'); return; }
  const data = await resp.json();
  const root = document.getElementById('modal-root');

  let convite = null;
  if (data.souAdmin) {
    const respConvite = await fetch(`/api/chats/${chatId}/invite?userId=${usuarioAtual.id}`);
    if (respConvite.ok) convite = await respConvite.json();
  }

  const linhas = data.membros.map(m => {
    const papel = m.isOwner ? '<span class="tag-papel tag-dono">Dono</span>'
      : m.isAdmin ? '<span class="tag-papel tag-admin">Admin</span>' : '';

    let botoes = '';
    if (data.souDono && !m.isOwner && !m.isAdmin) {
      botoes += `<button class="btn-outline btn-compacto" onclick="promoverNoModal('${chatId}', '${m.id}')">Tornar admin</button>`;
    }
    if (data.souDono && !m.isOwner && m.isAdmin) {
      botoes += `<button class="btn-outline btn-compacto" onclick="rebaixarNoModal('${chatId}', '${m.id}')">Tirar admin</button>`;
    }
    if ((data.souDono || data.souAdmin) && !m.isOwner && m.id !== usuarioAtual.id) {
      botoes += `<button class="btn-outline btn-compacto" onclick="removerDoModal('${chatId}', '${m.id}', '${escapeHtml(m.username)}')">Remover</button>`;
    }

    const souEu = m.id === usuarioAtual.id;
    const cliqueInfo = souEu
      ? ''
      : ` onclick="iniciarConversaComContato('${m.id}', '${escapeHtml(m.username)}', ${m.email ? `'${escapeHtml(m.email)}'` : 'null'}, ${m.photoUrl ? `'${escapeAttr(m.photoUrl)}'` : 'null'})" style="cursor:pointer"`;

    return `
      <div class="dropdown-item conta-item">
        <span class="conta-info"${cliqueInfo}>
          <span class="avatar-circle avatar-circle--sm">${avatarInnerHtml(m.username, m.photoUrl)}</span>
          <span>${souEu ? 'Você' : escapeHtml(m.username)}</span>
          ${papel}
        </span>
        <span class="config-grupo-botoes">${botoes}</span>
      </div>`;
  }).join('');

  const botaoAdicionar = data.souAdmin
    ? `<div class="config-grupo-acoes-topo">
         <button class="btn-outline btn-compacto" id="modal-adicionar-membros" type="button">+ Adicionar pessoas</button>
         <button class="btn-outline btn-compacto" id="modal-editar-nome" type="button">Editar nome</button>
       </div>`
    : '';

  const painelMembros = `
    <div class="config-grupo-painel" data-painel="membros">
      ${botaoAdicionar}
      <div class="lista-contatos">${linhas}</div>
    </div>`;

  // sempre tem pelo menos "Membros" e "Saíram"; "Permissões" e "Convite" só aparecem pra admin
  const painelSaidos = `
    <div class="config-grupo-painel oculto" data-painel="saidos">
      <div class="lista-contatos">${montarListaSaidos(data.saidos || [])}</div>
    </div>`;

  const totalSaidos = (data.saidos || []).length;
  let tabsHtml = `
    <button class="config-grupo-tab ativa" data-tab="membros" type="button">Membros</button>
    <button class="config-grupo-tab" data-tab="saidos" type="button">Saíram${totalSaidos ? ` (${totalSaidos})` : ''}</button>`;

  let painelPermissoes = '';
  if (data.souAdmin) {
    tabsHtml += `<button class="config-grupo-tab" data-tab="permissoes" type="button">Permissões</button>`;
    painelPermissoes = `<div class="config-grupo-painel oculto" data-painel="permissoes">${montarPainelPermissoes(data)}</div>`;
  }

  let painelConvite = '';
  if (convite) {
    const totalPedidos = convite.joinRequests.length;
    const badge = totalPedidos ? `<span class="config-grupo-badge">${totalPedidos}</span>` : '';
    tabsHtml += `<button class="config-grupo-tab" data-tab="convite" type="button">Convite${badge}</button>`;
    painelConvite = `<div class="config-grupo-painel oculto" data-painel="convite">${montarSecaoConvite(chatId, convite)}</div>`;
  }
  const abasHtml = `<div class="config-grupo-tabs">${tabsHtml}</div>`;

  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box modal-box--grupo">
        <h3 class="modal-title">Configurações do grupo</h3>
        ${abasHtml}
        <div class="config-grupo-corpo">
          ${painelMembros}
          ${painelSaidos}
          ${painelPermissoes}
          ${painelConvite}
        </div>
        <div class="modal-actions">
          <button class="btn-ok btn-compacto" id="modal-fechar-config-grupo" type="button">Fechar</button>
        </div>
      </div>
    </div>`;

  document.getElementById('modal-fechar-config-grupo').onclick = () => { root.innerHTML = ''; };
  document.getElementById('modal-overlay').onclick = e => { if (e.target.id === 'modal-overlay') root.innerHTML = ''; };

  root.querySelectorAll('.config-grupo-tab').forEach(tab => {
    tab.onclick = () => {
      root.querySelectorAll('.config-grupo-tab').forEach(t => t.classList.remove('ativa'));
      tab.classList.add('ativa');
      root.querySelectorAll('.config-grupo-painel').forEach(p => {
        p.classList.toggle('oculto', p.dataset.painel !== tab.dataset.tab);
      });
    };
  });

  if (data.souAdmin) {
    document.getElementById('modal-adicionar-membros').onclick = () => adicionarMembrosNoModal(chatId);
    document.getElementById('modal-editar-nome').onclick = () => editarNomeGrupo(chatId, data.name);
    ligarEventosConvite(chatId);
    ligarEventosPermissoes(chatId);
  }
}

// ---------- Painel "Permissões": quem pode mandar mensagem no grupo ----------
function montarPainelPermissoes(data) {
  const modo = data.modoEnvio || 'todos';
  const opcoes = [
    { valor: 'todos', label: 'Todos podem mandar mensagem', desc: 'Qualquer membro consegue conversar no grupo.' },
    { valor: 'admins', label: 'Só admins podem mandar mensagem', desc: 'Grupo fechado: membros comuns só conseguem ler.' }
  ];
  if (data.souDono) {
    opcoes.push({
      valor: 'dono',
      label: 'Só eu posso mandar mensagem',
      desc: 'Trava total: nem os admins conseguem mandar mensagem, só você.'
    });
  }

  const linhas = opcoes.map(o => `
    <label class="permissao-opcao${o.valor === modo ? ' permissao-opcao--ativa' : ''}">
      <input type="radio" name="modo-envio" value="${o.valor}" ${o.valor === modo ? 'checked' : ''}>
      <span class="permissao-opcao-texto">
        <strong>${o.label}</strong>
        <small>${o.desc}</small>
      </span>
    </label>`).join('');

  return `
    <p class="modal-texto">Quem pode mandar mensagem nesse grupo?</p>
    <div class="permissoes-lista">${linhas}</div>`;
}

function ligarEventosPermissoes(chatId) {
  document.querySelectorAll('input[name="modo-envio"]').forEach(input => {
    input.onchange = async () => {
      const modo = input.value;
      const resp = await fetch(`/api/chats/${chatId}/modo-envio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: usuarioAtual.id, modo })
      });
      const data = await resp.json();
      if (!resp.ok) { mostrarAviso(data.error || 'Não foi possível mudar isso.'); renderConfigGrupoModal(chatId); return; }
      if (chatAtualId === chatId) { chatAtualModoEnvio = modo; aplicarModoSomenteLeitura(); }
      renderConfigGrupoModal(chatId);
    };
  });
}

// ---------- Lista de quem saiu (ou foi removido) do grupo, com data/hora e foto ----------
function montarListaSaidos(saidos) {
  if (!saidos.length) return '<p class="modal-texto">Ninguém saiu desse grupo ainda.</p>';
  return saidos.map(s => {
    const quandoData = new Date(s.saiuEm);
    const quando = `${quandoData.toLocaleDateString('pt-BR')} às ${quandoData.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    return `
      <div class="dropdown-item conta-item">
        <span class="conta-info">
          <span class="avatar-circle avatar-circle--sm">${avatarInnerHtml(s.username, s.photoUrl)}</span>
          <span>${escapeHtml(s.username)}</span>
        </span>
        <span class="saiu-quando">${quando}</span>
      </div>`;
  }).join('');
}

// ---------- Editar nome do grupo (dono/admin) ----------
async function editarNomeGrupo(chatId, nomeAtual) {
  const valores = await abrirModal({
    titulo: 'Editar nome do grupo',
    campos: [{ id: 'nome', label: 'Nome do grupo', placeholder: 'Nome do grupo', valor: nomeAtual }],
    textoBotao: 'Salvar'
  });
  if (!valores || !valores.nome) return;

  const resp = await fetch(`/api/chats/${chatId}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id, name: valores.nome })
  });
  const data = await resp.json();
  if (!resp.ok) { mostrarAviso(data.error || 'Não foi possível mudar o nome do grupo.'); return; }

  if (chatAtualId === chatId) document.getElementById('chat-header-nome').textContent = data.name;
  carregarListaChats();
  renderConfigGrupoModal(chatId);
}

// ---------- Deixa links dentro de um texto clicáveis, sem virar botão (usado na descrição do grupo) ----------
function linkificarTexto(texto) {
  const escapado = escapeHtml(texto);
  return escapado.replace(/https?:\/\/[^\s<]+/gi, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}

// ---------- Janela de info do grupo (foto/nome/descrição), aberta ao clicar no ícone ou no nome do grupo no topo ----------
async function abrirInfoGrupo() {
  if (chatAtualTipo !== 'group' || !chatAtualId) return; // em PV isso ainda não existe
  const chatId = chatAtualId;
  const resp = await fetch(`/api/chats/${chatId}/members?userId=${usuarioAtual.id}`);
  if (!resp.ok) { mostrarAviso('Não foi possível abrir as informações do grupo.'); return; }
  const data = await resp.json();
  renderInfoGrupoModal(chatId, data);
}

function renderInfoGrupoModal(chatId, data) {
  const root = document.getElementById('modal-root');

  const descricaoHtml = data.description
    ? `<p class="info-grupo-descricao">${linkificarTexto(data.description)}</p>`
    : `<p class="info-grupo-descricao info-grupo-descricao--vazia">Esse grupo ainda não tem descrição.</p>`;

  const totalMembrosHtml = `<p class="info-grupo-criacao">${data.membros.length} membro${data.membros.length === 1 ? '' : 's'}</p>`;

  const dataCriacao = data.criadoEm ? new Date(data.criadoEm).toLocaleDateString('pt-BR') : null;
  const infoCriacaoHtml = dataCriacao
    ? `<p class="info-grupo-criacao">Criado por ${escapeHtml(data.criadoPor)} em ${dataCriacao}</p>`
    : '';

  const botaoEditar = data.souAdmin
    ? `<button class="btn-outline btn-compacto" id="info-grupo-editar" type="button">Editar descrição</button>`
    : '';

  const acoesFotoHtml = data.souAdmin
    ? `<div class="info-grupo-acoes-foto">
         <button class="link-sutil" id="info-grupo-trocar-foto" type="button">Trocar foto</button>
         ${data.photoUrl ? `<button class="link-sutil" id="info-grupo-remover-foto" type="button">Remover foto</button>` : ''}
       </div>`
    : '';

  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box">
        <div class="info-grupo-topo">
          <div class="avatar-circle avatar-circle--lg">${avatarInnerHtml(data.name, data.photoUrl)}</div>
          <h3 class="modal-title info-grupo-nome">${escapeHtml(data.name)}</h3>
          ${acoesFotoHtml}
          <input type="file" id="info-grupo-foto-input" accept="image/*" style="display:none">
        </div>
        ${descricaoHtml}
        ${totalMembrosHtml}
        ${infoCriacaoHtml}
        <div class="modal-actions">
          ${botaoEditar}
          <button class="btn-ok btn-compacto" id="info-grupo-fechar" type="button">Fechar</button>
        </div>
      </div>
    </div>`;

  document.getElementById('info-grupo-fechar').onclick = () => { root.innerHTML = ''; };
  document.getElementById('modal-overlay').onclick = e => { if (e.target.id === 'modal-overlay') root.innerHTML = ''; };
  if (data.souAdmin) {
    document.getElementById('info-grupo-editar').onclick = () => editarDescricaoGrupo(chatId, data.description);
    document.getElementById('info-grupo-trocar-foto').onclick = () => document.getElementById('info-grupo-foto-input').click();
    document.getElementById('info-grupo-foto-input').onchange = e => {
      if (e.target.files[0]) trocarFotoGrupo(chatId, e.target.files[0]);
    };
    const btnRemover = document.getElementById('info-grupo-remover-foto');
    if (btnRemover) btnRemover.onclick = () => trocarFotoGrupo(chatId, null);
  }
}

// ---------- Trocar (ou remover, se arquivo for null) a foto do grupo ----------
async function trocarFotoGrupo(chatId, arquivo) {
  let photoUrl = null;
  if (arquivo) {
    const formData = new FormData();
    formData.append('file', arquivo);
    const uploadResp = await fetch('/api/upload', { method: 'POST', body: formData });
    const uploadData = await uploadResp.json();
    if (!uploadResp.ok) { mostrarAviso('Não foi possível enviar a imagem.'); return; }
    photoUrl = uploadData.url;
  }

  const resp = await fetch(`/api/chats/${chatId}/photo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id, photoUrl })
  });
  const data = await resp.json();
  if (!resp.ok) { mostrarAviso(data.error || 'Não foi possível mudar a foto do grupo.'); return; }

  carregarListaChats();
  if (chatAtualId === chatId) {
    document.getElementById('chat-header-avatar').innerHTML = avatarInnerHtml(
      document.getElementById('chat-header-nome').textContent, data.photoUrl
    );
  }
  abrirInfoGrupo(); // reabre já com a foto atualizada
}

// ---------- Editar a descrição do grupo (dono/admin) ----------
async function editarDescricaoGrupo(chatId, descricaoAtual) {
  const valores = await abrirModal({
    titulo: 'Descrição do grupo',
    campos: [{
      id: 'descricao',
      label: 'Descrição',
      placeholder: 'Do que esse grupo trata?',
      valor: descricaoAtual,
      tipo: 'textarea'
    }],
    textoBotao: 'Salvar'
  });
  if (valores === null) return; // cancelou

  const resp = await fetch(`/api/chats/${chatId}/description`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id, description: valores.descricao })
  });
  const data = await resp.json();
  if (!resp.ok) { mostrarAviso(data.error || 'Não foi possível mudar a descrição do grupo.'); return; }

  abrirInfoGrupo(); // reabre a janela já com a descrição atualizada
}

// ---------- Lista de pedidos pra entrar, com botões de aprovar/recusar (usada na janelinha rápida e na aba Convite) ----------
function montarListaPedidos(chatId, joinRequests) {
  return joinRequests.length
    ? joinRequests.map(p => `
        <div class="dropdown-item conta-item">
          <span class="conta-info">
            <span class="avatar-circle avatar-circle--sm">${avatarInnerHtml(p.username, p.photoUrl)}</span>
            <span>${escapeHtml(p.username)}</span>
          </span>
          <span class="config-grupo-botoes">
            <button class="btn-ok btn-compacto" onclick="responderPedidoEntrada('${chatId}', '${p.userId}', true)">Aprovar</button>
            <button class="btn-outline btn-compacto" onclick="responderPedidoEntrada('${chatId}', '${p.userId}', false)">Recusar</button>
          </span>
        </div>`).join('')
    : '<p class="modal-texto">Nenhum pedido pendente.</p>';
}

// ---------- Seção "Link de convite" dentro de Configurações do grupo (só admin vê) ----------
function montarSecaoConvite(chatId, convite) {
  const link = `${location.origin}${location.pathname}?convite=${convite.code}`;
  const pedidosHtml = montarListaPedidos(chatId, convite.joinRequests);

  return `
    <h4 class="modal-subtitulo">Link de convite</h4>
    <div class="convite-link-row">
      <input class="modal-input" id="convite-link-input" type="text" value="${escapeHtml(link)}" readonly>
      <button class="btn-outline btn-compacto" id="convite-copiar">Copiar</button>
    </div>
    <label class="modal-label modal-label-checkbox">
      <input type="checkbox" id="convite-aprovacao" ${convite.approvalRequired ? 'checked' : ''}>
      Exigir aprovação de admin pra entrar pelo link
    </label>
    <button class="btn-outline btn-compacto" id="convite-redefinir" type="button">Gerar novo link</button>

    <h4 class="modal-subtitulo config-grupo-subtitulo-pedidos">Pedidos pra entrar</h4>
    ${pedidosHtml}`;
}

function ligarEventosConvite(chatId) {
  const btnCopiar = document.getElementById('convite-copiar');
  if (btnCopiar) btnCopiar.onclick = () => {
    const input = document.getElementById('convite-link-input');
    input.select();
    navigator.clipboard.writeText(input.value).then(
      () => mostrarAviso('Link copiado!', 'sucesso'),
      () => document.execCommand('copy') // navegador antigo sem clipboard API
    );
  };

  const checkAprovacao = document.getElementById('convite-aprovacao');
  if (checkAprovacao) checkAprovacao.onchange = async () => {
    const ativo = checkAprovacao.checked;
    const resp = await fetch(`/api/chats/${chatId}/invite/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: usuarioAtual.id, ativo })
    });
    if (!resp.ok) { checkAprovacao.checked = !ativo; mostrarAviso('Não foi possível mudar isso.'); }
  };

  const btnRedefinir = document.getElementById('convite-redefinir');
  if (btnRedefinir) btnRedefinir.onclick = async () => {
    const aceitou = await abrirConfirmacao({
      titulo: 'Gerar novo link',
      mensagem: 'O link antigo para de funcionar. Continuar?',
      textoBotao: 'Gerar novo link'
    });
    if (!aceitou) return;
    const resp = await fetch(`/api/chats/${chatId}/invite/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: usuarioAtual.id })
    });
    if (resp.ok) renderConfigGrupoModal(chatId);
    else mostrarAviso('Não foi possível gerar um novo link.');
  };
}

async function responderPedidoEntrada(chatId, targetUserId, aprovar) {
  const resp = await fetch(`/api/chats/${chatId}/invite/responder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id, targetUserId, aprovar })
  });
  if (!resp.ok) { mostrarAviso('Não foi possível responder esse pedido.'); return; }
  if (document.getElementById('pedidos-fechar')) abrirPedidosPendentes(chatId);
  else renderConfigGrupoModal(chatId);
  carregarListaChats();
  if (chatAtualId === chatId) atualizarBadgePedidos(chatId);
}

// ---------- Adicionar pessoas a um grupo já existente (dono/admin) ----------
async function adicionarMembrosNoModal(chatId) {
  const valores = await abrirModal({
    titulo: 'Adicionar pessoas ao grupo',
    campos: [
      { id: 'membros', label: 'Email ou usuário (separados por vírgula)', placeholder: 'maria, joao@email.com' }
    ],
    textoBotao: 'Adicionar'
  });
  if (!valores || !valores.membros) return;
  const lista = valores.membros.split(',').map(s => s.trim()).filter(Boolean);
  if (!lista.length) return;

  const resp = await fetch(`/api/chats/${chatId}/add-members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id, memberQueries: lista })
  });
  const data = await resp.json();

  if (!resp.ok) {
    mostrarAviso(data.error || 'Não foi possível adicionar essas pessoas.');
    return;
  }
  if (data.naoEncontrados && data.naoEncontrados.length) {
    mostrarAviso('Não encontrado: ' + data.naoEncontrados.join(', '));
  }
  if (data.bloqueados && data.bloqueados.length) {
    data.bloqueados.forEach(nome => mostrarAviso('Não foi possível adicionar ' + nome));
  }
  if (data.jaNoGrupo && data.jaNoGrupo.length) {
    data.jaNoGrupo.forEach(nome => mostrarAviso(nome + ' já está no grupo'));
  }
  renderConfigGrupoModal(chatId);
  carregarListaChats();
}

async function promoverNoModal(chatId, targetUserId) {
  const resp = await fetch(`/api/chats/${chatId}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id, targetUserId })
  });
  const data = await resp.json();
  if (!resp.ok) { mostrarAviso(data.error || 'Não foi possível dar admin.'); return; }
  renderConfigGrupoModal(chatId);
}

async function rebaixarNoModal(chatId, targetUserId) {
  const resp = await fetch(`/api/chats/${chatId}/demote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id, targetUserId })
  });
  const data = await resp.json();
  if (!resp.ok) { mostrarAviso(data.error || 'Não foi possível tirar o admin.'); return; }
  renderConfigGrupoModal(chatId);
}

async function removerDoModal(chatId, targetUserId, username) {
  const aceitou = await abrirConfirmacao({
    titulo: 'Remover do grupo',
    mensagem: `Remover ${username} do grupo?`,
    textoBotao: 'Remover'
  });
  if (!aceitou) return;
  const resp = await fetch(`/api/chats/${chatId}/remove-member`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id, targetUserId })
  });
  const data = await resp.json();
  if (!resp.ok) { mostrarAviso(data.error || 'Não foi possível remover essa pessoa.'); return; }
  renderConfigGrupoModal(chatId);
  carregarListaChats();
}

async function apagarConversa(chatId, removido) {
  document.querySelectorAll('.dropdown-menu').forEach(el => el.classList.add('oculto'));
  const mensagem = removido
    ? 'Apagar essa conversa da sua lista? Ela só some pra você.'
    : ((todasAsConversas.find(c => c.id === chatId) || {}).type === 'group')
      ? 'Apagar essa conversa? Isso apaga pra todo mundo que participa dela, não só pra você.'
      : 'Apagar essa conversa? Ela só some pra você, a outra pessoa continua com ela.';
  const aceitou = await abrirConfirmacao({ titulo: 'Apagar conversa', mensagem, textoBotao: 'Apagar' });
  if (!aceitou) return;

  await fetch(`/api/chats/${chatId}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id })
  });

  if (chatAtualId === chatId) voltarHome();
  carregarListaChats();
  carregarStats();
}

async function sairDoGrupo(chatId) {
  document.querySelectorAll('.dropdown-menu').forEach(el => el.classList.add('oculto'));
  const aceitou = await abrirConfirmacao({
    titulo: 'Sair do grupo',
    mensagem: 'Sair desse grupo? Você para de receber as mensagens dele.',
    textoBotao: 'Sair'
  });
  if (!aceitou) return;

  await fetch(`/api/chats/${chatId}/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id })
  });

  if (chatAtualId === chatId) voltarHome();
  carregarListaChats();
}

async function bloquearUsuario(blockedId, chatId) {
  document.querySelectorAll('.dropdown-menu').forEach(el => el.classList.add('oculto'));
  if (!blockedId) return;
  const aceitou = await abrirConfirmacao({
    titulo: 'Bloquear usuário',
    mensagem: 'Bloquear esse usuário? Vocês não vão mais poder trocar mensagens, e a conversa atual será apagada.',
    textoBotao: 'Bloquear'
  });
  if (!aceitou) return;

  await fetch('/api/block', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id, blockedId })
  });

  if (chatId) {
    await fetch(`/api/chats/${chatId}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: usuarioAtual.id })
    });
  }

  if (chatAtualId === chatId) voltarHome();
  carregarListaChats();
  carregarStats();
}

// ---------- Voltar pra home ----------
function voltarHome() {
  chatAtualId = null;
  chatAtualTipo = null;
  chatAtualOutro = null;
  chatAtualRemovido = false;
  chatFixada = null;
  esconderBadgePedidos();
  document.getElementById('chat-view').classList.add('oculto');
  document.getElementById('home-view').classList.remove('oculto');
  mostrarListaMobile();
  renderizarListaChats();
}

// ---------- Renderizar mensagens ----------
function renderizarMensagem(msg) {
  const container = document.getElementById('mensagens');
  if (container.querySelector(`[data-id="${msg.id}"]`)) return;
  const el = criarElementoMensagem(msg);
  const ult = container.lastElementChild;
  if (!ult || ult.dataset.dia !== el.dataset.dia) {
    const sep = document.createElement('div');
    sep.className = 'msg-sistema sep-dia';
    sep.dataset.dia = el.dataset.dia;
    sep.textContent = rotuloDia(msg.createdAt);
    container.appendChild(sep);
  }
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  if (msg.type !== 'system') mensagensCacheAtual.set(msg.id, msg);
}

// ---------- Monta o elemento DOM de uma mensagem (sem colocar na tela) ----------
// Existe separado do renderizarMensagem pra poder ser reaproveitado quando uma
// mensagem precisa ser TOTALMENTE reconstruída do zero (ex: quando ela é apagada em
// tempo real) — assim garante que nada "sobra" na tela por engano, tipo o botão
// de Acessar, em vez de depender de remover pedaço por pedaço do HTML antigo.
function criarElementoMensagem(msg) {
  if (msg.type === 'system') {
    const aviso = document.createElement('div');
    aviso.className = 'msg-sistema';
    aviso.dataset.id = msg.id;
    aviso.dataset.dia = new Date(msg.createdAt).toDateString();
    aviso.textContent = msg.content;
    return aviso;
  }

  const div = document.createElement('div');
  const minha = msg.senderId === usuarioAtual.id;
  div.className = 'msg' + (minha ? ' minha' : '');
  div.dataset.id = msg.id;
  div.dataset.dia = new Date(msg.createdAt).toDateString();

  let remetenteHtml = '';
  if (chatAtualTipo === 'group' && !minha && msg.senderUsername) {
    const saiuBadge = msg.senderSaiuDoGrupo
      ? `<span class="msg-remetente-saiu" title="Não está mais no grupo">✕</span>`
      : '';
    remetenteHtml = `<div class="msg-remetente">
      <span class="avatar-circle avatar-circle--sm">${avatarInnerHtml(msg.senderUsername, msg.senderPhotoUrl)}</span>
      <span class="msg-remetente-nome">${escapeHtml(msg.senderUsername)}</span>
      ${saiuBadge}
    </div>`;
  }

  let replyHtml = '';
  if (msg.replyTo) {
    if (typeof msg.replyTo === 'object') {
      const rt = msg.replyTo;
      replyHtml = `<div class="quote-box" onclick="irParaMensagem('${rt.id}')">
        <div class="quote-nome">${escapeHtml(nomeDoCitado(rt))}</div>
        <div class="quote-snippet">${escapeHtml(rt.snippet)}</div>
      </div>`;
    } else {
      // mensagens antigas, gravadas antes dessa melhoria, só guardavam o id
      replyHtml = `<div class="reply-ref" onclick="irParaMensagem('${msg.replyTo}')">↑ Respondendo a uma mensagem</div>`;
    }
  }

  let conteudoHtml;
  if (msg.deleted) {
    conteudoHtml = `<div class="conteudo apagada">Mensagem apagada</div>`;
  } else if (msg.type === 'audio') {
    conteudoHtml = msg.mediaUrl
      ? `<div class="conteudo conteudo-midia">${montarPlayerAudio(msg)}</div>`
      : `<div class="conteudo apagada">Áudio expirado (12h)</div>`;
  } else if (msg.type === 'video') {
    conteudoHtml = msg.mediaUrl
      ? `<div class="conteudo"><video controls width="220" src="${msg.mediaUrl}"></video></div>`
      : `<div class="conteudo apagada">Vídeo expirado (12h)</div>`;
  } else if (msg.type === 'image') {
    conteudoHtml = msg.mediaUrl
      ? `<div class="conteudo"><img class="msg-imagem" src="${msg.mediaUrl}" alt="" onclick="window.open('${msg.mediaUrl}','_blank')"></div>`
      : `<div class="conteudo apagada">Imagem expirada (12h)</div>`;
  } else if (msg.type === 'file') {
    conteudoHtml = msg.mediaUrl
      ? `<div class="conteudo conteudo-midia">${montarCartaoArquivo(msg)}</div>`
      : `<div class="conteudo apagada">Arquivo expirado (12h)</div>`;
  } else {
    conteudoHtml = `<div class="conteudo">${destacarMencoes(msg.content)}</div>`;
  }

  const linkDaMensagem = (!msg.deleted && msg.type === 'text') ? extrairPrimeiroLink(msg.content) : null;
  const linkBtnHtml = linkDaMensagem
    ? `<button class="btn-acessar-link" data-url="${escapeAttr(linkDaMensagem)}">🔗 Acessar</button>`
    : '';

  // Em áudio, vídeo, imagem e arquivo, o player/anexo ocupa o toque inteiro
  // (dá play, abre em tela cheia, baixa o arquivo...) então o hover e o
  // swipe-pra-responder não são um jeito confiável de chegar no "Responder".
  // Por isso essas mensagens ganham um botãozinho de responder sempre visível.
  const precisaResponderRapido = !msg.deleted && ['audio', 'video', 'image', 'file'].includes(msg.type);
  const btnResponderRapidoHtml = precisaResponderRapido
    ? `<button class="btn-responder-rapido" onclick="responderMensagem('${msg.id}')" title="Responder" aria-label="Responder mensagem">↩</button>`
    : '';

  const hora = new Date(msg.createdAt).toLocaleTimeString().slice(0, 5);
  const editadoTxt = msg.editedAt ? ' (editada)' : '';

  let acoesHtml = '<div class="acoes">';
  acoesHtml += `<span onclick="responderMensagem('${msg.id}')">Responder</span>`;
  if (!msg.deleted) acoesHtml += `<span onclick="abrirReacoes(event, '${msg.id}')">Reagir</span>`;
  if (!msg.deleted) acoesHtml += `<span onclick="iniciarEncaminhar('${msg.id}')">Encaminhar</span>`;
  if (!msg.deleted && podeEnviarNoChatAtual()) acoesHtml += `<span onclick="fixarMensagem('${msg.id}')">Fixar</span>`;
  if (minha && !msg.deleted) {
    if (Date.now() - msg.createdAt < 60000 && msg.type === 'text') {
      acoesHtml += `<span onclick="editarMensagem('${msg.id}')">Editar</span>`;
    }
    acoesHtml += `<span onclick="apagarMensagem('${msg.id}')">Apagar</span>`;
  }
  acoesHtml += '</div>';

    const etiquetaEncaminhada = (msg.encaminhada && !msg.deleted) ? '<div class="msg-encaminhada">↪ Encaminhada</div>' : '';
  div.innerHTML = `<span class="swipe-icone-responder">↩</span><span class="msg-check">✓</span>${btnResponderRapidoHtml}${remetenteHtml}${etiquetaEncaminhada}${replyHtml}${conteudoHtml}${linkBtnHtml}<div class="reacoes">${msg.deleted ? '' : reacoesHtml(msg.id, msg.reactions)}</div><div class="hora">${hora}${editadoTxt}</div>${acoesHtml}`;
  ligarPlayerAudio(div);
  if (msgsSelecionadas && msgsSelecionadas.has(msg.id)) div.classList.add('msg-selecionada');
  const btnLink = div.querySelector('.btn-acessar-link');
  if (btnLink) {
    const codigoConvite = extrairCodigoConvite(btnLink.dataset.url);
    if (codigoConvite) {
      btnLink.onclick = () => cliqueBotaoConvite(codigoConvite, btnLink);
    } else {
      btnLink.addEventListener('click', () => acessarLink(btnLink.dataset.url));
    }
  }
  return div;
}

function rotuloDia(ts) {
  const d = new Date(ts), h = new Date();
  const ini = x => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const dif = Math.round((ini(h) - ini(d)) / 864e5);
  if (dif === 0) return 'Hoje';
  if (dif === 1) return 'Ontem';
  if (dif < 7) return d.toLocaleDateString('pt-BR', { weekday: 'long' });
  return d.toLocaleDateString('pt-BR');
}

// ---------- Reações ----------
function reacoesHtml(id, reactions) {
  const cont = {};
  Object.values(reactions || {}).forEach(e => { cont[e] = (cont[e] || 0) + 1; });
  const minha = (reactions || {})[usuarioAtual.id];
  return Object.keys(cont).map(e =>
    `<span class="reacao${e === minha ? ' minha' : ''}" onclick="reagir('${id}', '${e}')">${e} ${cont[e]}</span>`
  ).join('');
}

function abrirReacoes(event, id) {
  event.stopPropagation();
  abrirMenuFlutuante(event.currentTarget,
    `<div class="reacao-picker">${EMOJIS_REACAO.map(e => `<span onclick="reagir('${id}', '${e}')">${e}</span>`).join('')}</div>`);
}

function reagir(id, emoji) {
  fecharMenuFlutuante();
  socket.emit('react_message', { messageId: id, userId: usuarioAtual.id, emoji });
}

// ---------- Mensagem fixada ----------
function renderBarraFixada() {
  const barra = document.getElementById('barra-fixada');
  if (!chatFixada) { barra.classList.add('oculto'); return; }
  document.getElementById('barra-fixada-texto').textContent = chatFixada.snippet;
  barra.classList.remove('oculto');
}

async function fixarMensagem(messageId) {
  fecharMenuFlutuante();
  await fetch(`/api/chats/${chatAtualId}/pin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id, messageId })
  });
}

function atualizarMensagemNaTela(msg) {
  const el = document.querySelector(`[data-id="${msg.id}"] .conteudo`);
  if (el) el.textContent = msg.content;
}

function irParaMensagem(id) {
  const alvo = document.querySelector(`[data-id="${id}"]`);
  if (!alvo) return;
  alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
  alvo.classList.add('msg-destaque');
  setTimeout(() => alvo.classList.remove('msg-destaque'), 1200);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- Avatar reaproveitável: mostra a foto se tiver, senão a letra inicial ----------
function avatarInnerHtml(nome, photoUrl) {
  if (photoUrl) return `<img src="${escapeAttr(photoUrl)}" alt="">`;
  return `<span>${escapeHtml((nome || '?').charAt(0).toUpperCase())}</span>`;
}
function atualizarAvatarTopo() {
  document.getElementById('avatar-topo').innerHTML = avatarInnerHtml(usuarioAtual.username, usuarioAtual.photoUrl);
}

// ---------- Janela de editar perfil completo ----------
async function abrirEditarPerfil() {
  const root = document.getElementById('modal-root');
  const respPriv = await fetch(`/api/users/${usuarioAtual.id}/photo-privacy`);
  const priv = await respPriv.json().catch(() => ({ privacy: 'todos', allowList: [] }));
  const sociais = Array.isArray(usuarioAtual.socials) ? usuarioAtual.socials : [];
  const socialAtual = network => (sociais.find(s => s.network === network) || {}).handle || '';
  const ring = /^#[0-9a-fA-F]{6}$/.test(usuarioAtual.ringColor || '') ? usuarioAtual.ringColor : '#ffb454';
  const opcoesPrivacidade = [
    { valor: 'todos', label: 'Todos podem ver' },
    { valor: 'contatos', label: 'Só meus contatos' },
    { valor: 'lista', label: 'Só uma lista seleta' },
    { valor: 'ninguem', label: 'Ninguém pode ver' }
  ];
  const privacidadeAtual = priv.privacy || 'todos';
  const socials = [
    { id: 'instagram', label: 'Instagram', placeholder: 'seu.usuario' },
    { id: 'tiktok', label: 'TikTok', placeholder: 'seu.usuario' },
    { id: 'youtube', label: 'YouTube', placeholder: '@seucanal ou ID' },
    { id: 'facebook', label: 'Facebook', placeholder: 'seu.usuario ou página' },
    { id: 'x', label: 'X (Twitter)', placeholder: 'seu.usuario' }
  ];
  const privacidadeHtml = `
    <div class="config-grupo">
      <span class="config-label">Quem pode ver sua foto de perfil</span>
      <div class="privacidade-opcoes">
        ${opcoesPrivacidade.map(o => `
          <label class="privacidade-opcao"><input type="radio" name="foto-privacidade" value="${o.valor}" ${privacidadeAtual === o.valor ? 'checked' : ''}> ${o.label}</label>`).join('')}
      </div>
      <div id="privacidade-lista-wrap" class="${privacidadeAtual === 'lista' ? '' : 'oculto'}">
        <div class="convite-link-row"><input class="modal-input" id="privacidade-lista-busca" type="text" placeholder="Adicionar por email ou usuário"><button class="btn-outline btn-compacto" id="privacidade-lista-add">Adicionar</button></div>
        <div id="privacidade-lista-itens" class="lista-contatos">${renderListaPrivacidadeItens(priv.allowList)}</div>
      </div>
    </div>`;
  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box modal-box--perfil-editor">
        <div class="perfil-editor-cabecalho">
          <button class="perfil-fechar-x" id="perfil-fechar-x" type="button" aria-label="Fechar perfil">×</button>
          <div class="avatar-circle avatar-circle--lg perfil-editor-avatar" style="border-color:${escapeAttr(ring)}">${avatarInnerHtml(usuarioAtual.username, usuarioAtual.photoUrl)}</div>
          <h3 class="modal-title info-grupo-nome">${escapeHtml(usuarioAtual.username)}</h3>
          <p class="perfil-editor-subtitulo">Seu perfil, do seu jeito</p>
          <div class="info-grupo-acoes-foto">
            <button class="link-sutil" id="perfil-trocar-foto" type="button">Trocar foto / GIF</button>
            ${usuarioAtual.photoUrl ? '<button class="link-sutil" id="perfil-remover-foto" type="button">Remover foto</button>' : ''}
          </div>
          <input type="file" id="perfil-foto-input" accept="image/*,.gif" style="display:none">
        </div>
        <div class="perfil-editor-campos">
          <label class="perfil-campo"><span>Bio <small>até 240 caracteres</small></span><textarea id="perfil-bio-input" maxlength="240" rows="3" placeholder="Uma frase sobre você...">${escapeHtml(usuarioAtual.bio || '')}</textarea></label>
          <label class="perfil-campo"><span>Número de contato</span><input id="perfil-phone-input" type="tel" maxlength="30" value="${escapeAttr(usuarioAtual.phone || '')}" placeholder="+55 11 99999-9999" autocomplete="tel"></label>
          <label class="perfil-campo perfil-campo-cor"><span>Cor da borda da foto</span><input id="perfil-ring-color" type="color" value="${escapeAttr(ring)}"></label>
          <div class="perfil-socials"><span class="config-label">Suas redes sociais</span><p class="perfil-ajuda">Adicione o usuário; o link será criado automaticamente no seu perfil.</p>
            ${socials.map(net => `<label class="perfil-campo perfil-social-campo"><span>${net.label}</span><input data-social="${net.id}" maxlength="100" value="${escapeAttr(socialAtual(net.id))}" placeholder="${net.placeholder}"></label>`).join('')}
          </div>
        </div>
        ${privacidadeHtml}
        <div class="modal-actions perfil-editor-acoes"><button class="btn-outline btn-compacto" id="perfil-cancelar" type="button">Fechar</button><button class="btn-ok btn-compacto" id="perfil-salvar" type="button">Salvar perfil</button></div>
      </div>
    </div>`;
  const fechar = () => { root.innerHTML = ''; };
  document.getElementById('perfil-fechar-x').onclick = fechar;
  document.getElementById('perfil-cancelar').onclick = fechar;
  document.getElementById('modal-overlay').onclick = e => { if (e.target.id === 'modal-overlay') fechar(); };
  document.getElementById('perfil-trocar-foto').onclick = () => document.getElementById('perfil-foto-input').click();
  document.getElementById('perfil-foto-input').onchange = e => { if (e.target.files[0]) trocarFotoPerfil(e.target.files[0]); };
  const btnRemover = document.getElementById('perfil-remover-foto');
  if (btnRemover) btnRemover.onclick = () => trocarFotoPerfil(null);
  document.getElementById('perfil-ring-color').oninput = e => {
    const avatar = document.querySelector('.perfil-editor-avatar'); if (avatar) avatar.style.borderColor = e.target.value;
  };
  document.querySelectorAll('input[name="foto-privacidade"]').forEach(radio => { radio.onchange = () => mudarPrivacidadeFoto(radio.value); });
  const inputBusca = document.getElementById('privacidade-lista-busca');
  document.getElementById('privacidade-lista-add').onclick = () => adicionarNaListaPrivacidade(inputBusca.value.trim());
  inputBusca.addEventListener('keydown', e => { if (e.key === 'Enter') adicionarNaListaPrivacidade(inputBusca.value.trim()); });
  document.getElementById('perfil-salvar').onclick = async () => {
    const socials = Array.from(document.querySelectorAll('[data-social]')).map(el => ({ network: el.dataset.social, handle: el.value.trim() })).filter(x => x.handle);
    const resp = await fetch(`/api/users/${usuarioAtual.id}/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: usuarioAtual.id, bio: document.getElementById('perfil-bio-input').value, phone: document.getElementById('perfil-phone-input').value, ringColor: document.getElementById('perfil-ring-color').value, socials }) });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { mostrarAviso(data.error || 'Não foi possível salvar o perfil.'); return; }
    usuarioAtual = { ...usuarioAtual, ...data.user };
    localStorage.setItem('usuario', JSON.stringify(usuarioAtual));
    const contas = carregarContas().map(c => c.id === usuarioAtual.id ? { ...c, ...data.user } : c);
    localStorage.setItem('contas', JSON.stringify(contas));
    atualizarAvatarTopo();
    abrirEditarPerfil();
    mostrarAviso('Perfil atualizado!', 'sucesso');
  };
}

// ---------- Linhas da lista seleta (dentro da privacidade da foto) ----------
function renderListaPrivacidadeItens(lista) {
  if (!lista || !lista.length) return '<p class="modal-texto">Ninguém na lista ainda.</p>';
  return lista.map(p => `
    <div class="dropdown-item conta-item">
      <span class="conta-info"><span>${escapeHtml(p.username)}</span></span>
      <span class="conta-remover" onclick="removerDaListaPrivacidade('${p.id}')" title="Remover">✕</span>
    </div>`).join('');
}

// ---------- Trocar a preferência de privacidade da foto ----------
async function mudarPrivacidadeFoto(valor) {
  const resp = await fetch(`/api/users/${usuarioAtual.id}/photo-privacy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ privacy: valor })
  });
  const data = await resp.json();
  if (!resp.ok) { mostrarAviso(data.error || 'Não foi possível mudar a privacidade da foto.'); return; }
  const wrap = document.getElementById('privacidade-lista-wrap');
  if (wrap) wrap.classList.toggle('oculto', valor !== 'lista');
}

// ---------- Adicionar/remover alguém da lista seleta ----------
async function adicionarNaListaPrivacidade(query) {
  if (!query) return;
  const resp = await fetch(`/api/users/${usuarioAtual.id}/photo-privacy/lista`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const data = await resp.json();
  if (!resp.ok) { mostrarAviso(data.error || 'Não foi possível adicionar essa pessoa.'); return; }
  abrirEditarPerfil(); // reabre já com a lista atualizada
}

async function removerDaListaPrivacidade(id) {
  const resp = await fetch(`/api/users/${usuarioAtual.id}/photo-privacy/lista`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remover: id })
  });
  if (!resp.ok) { mostrarAviso('Não foi possível remover essa pessoa.'); return; }
  abrirEditarPerfil();
}

// ---------- Trocar (ou remover, se arquivo for null) a própria foto de perfil ----------
async function trocarFotoPerfil(arquivo) {
  let photoUrl = null;
  if (arquivo) {
    const formData = new FormData();
    formData.append('file', arquivo);
    const uploadResp = await fetch('/api/upload', { method: 'POST', body: formData });
    const uploadData = await uploadResp.json();
    if (!uploadResp.ok) { mostrarAviso('Não foi possível enviar a imagem.'); return; }
    photoUrl = uploadData.url;
  }

  const resp = await fetch(`/api/users/${usuarioAtual.id}/photo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photoUrl })
  });
  const data = await resp.json();
  if (!resp.ok) { mostrarAviso(data.error || 'Não foi possível mudar a foto de perfil.'); return; }

  usuarioAtual = data.user;
  localStorage.setItem('usuario', JSON.stringify(usuarioAtual));
  const contas = carregarContas().map(c => c.id === usuarioAtual.id ? { ...c, photoUrl: usuarioAtual.photoUrl } : c);
  localStorage.setItem('contas', JSON.stringify(contas));

  atualizarAvatarTopo();
  carregarListaChats(); // pra atualizar a foto em conversas privadas com outras pessoas te vendo
  abrirEditarPerfil(); // reabre já atualizado
}

// ---------- Detecção de link em mensagens de texto ----------
function extrairPrimeiroLink(texto) {
  const m = (texto || '').match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
}

// ---------- Clique no botão "Acessar" de uma mensagem com link ----------
function extrairCodigoConvite(url) {
  try {
    const u = new URL(url, location.origin);
    return u.origin === location.origin ? u.searchParams.get('convite') : null;
  } catch (e) {
    return null;
  }
}

function acessarLink(url) {
  window.open(url, '_blank', 'noopener');
}

// ---------- Fluxo Acessar -> Solicitar -> Cancelar, só pra links de convite de grupo do site ----------
async function cliqueBotaoConvite(code, btn) {
  btn.disabled = true;
  const infoResp = await fetch(`/api/invite/${code}/info?userId=${usuarioAtual.id}`);
  const info = await infoResp.json();
  btn.disabled = false;
  if (!infoResp.ok) { mostrarAviso(info.error || 'Não foi possível entrar nesse grupo.'); return; }

  if (info.approvalRequired && !info.jaEstava && !info.jaPendente) {
    const aceitou = await abrirConfirmacao({
      titulo: 'Pedir pra entrar no grupo',
      mensagem: `O grupo "${info.chatName}" exige aprovação de um admin. Quer solicitar entrada?`,
      textoBotao: 'Solicitar'
    });
    if (!aceitou) return;
  }

  btn.disabled = true;
  const resp = await fetch(`/api/invite/${code}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id })
  });
  const data = await resp.json();
  btn.disabled = false;

  if (!resp.ok) { mostrarAviso(data.error || 'Não foi possível entrar nesse grupo.'); return; }

  if (data.pendente) {
    // pedido enviado (ou já estava pendente) — vira "Cancelar solicitação"
    btn.textContent = '✕ Cancelar solicitação';
    btn.classList.add('btn-acessar-link--pendente');
    btn.onclick = () => cancelarSolicitacaoConvite(code, btn);
    mostrarAviso('Pedido enviado! Um admin do grupo precisa aprovar.', 'sucesso');
    return;
  }

  mostrarAviso(data.jaEstava ? 'Você já está nesse grupo.' : `Você entrou no grupo "${data.chat.name}"!`, 'sucesso');
  btn.textContent = '✓ Você está no grupo';
  btn.disabled = true;
  carregarListaChats();
  abrirChat(data.chat.id, data.chat.name, data.chat.type, null, null, false);
}

async function cancelarSolicitacaoConvite(code, btn) {
  btn.disabled = true;
  const resp = await fetch(`/api/invite/${code}/cancelar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: usuarioAtual.id })
  });
  btn.disabled = false;
  if (!resp.ok) { mostrarAviso('Não foi possível cancelar o pedido.'); return; }

  btn.textContent = '🔗 Acessar';
  btn.classList.remove('btn-acessar-link--pendente');
  btn.onclick = () => cliqueBotaoConvite(code, btn);
  mostrarAviso('Pedido cancelado.', 'sucesso');
}

// ---------- Prévia de mensagem (usada na citação de resposta) ----------
// nome mostrado na caixinha de citação, sempre do ponto de vista de quem está VENDO:
// "Você" se a mensagem citada é minha, senão o nick de quem escreveu.
function nomeDoCitado(rt) {
  if (rt.userId === usuarioAtual.id) return 'Você';
  if (rt.realName) return rt.realName;
  const original = mensagensCacheAtual.get(rt.id);
  if (original && original.senderUsername) return original.senderUsername;
  // respostas antigas (sem realName): se o nome gravado não é "Você", serve; senão, no PV é o outro
  if (rt.userName && rt.userName !== 'Você') return rt.userName;
  if (chatAtualOutro && chatAtualOutro.username) return chatAtualOutro.username;
  return 'Usuário';
}
function nomeDoRemetente(msg) {
  if (msg.senderId === usuarioAtual.id) return 'Você';
  return msg.senderUsername || 'Usuário removido';
}
function previaDaMensagem(msg) {
  if (msg.deleted) return 'Mensagem apagada';
  switch (msg.type) {
    case 'audio': return '🎤 Mensagem de voz';
    case 'video': return '🎥 Vídeo';
    case 'image': return '📷 Foto';
    case 'file': return '📎 ' + (msg.content || 'Arquivo');
    default: {
      const texto = msg.content || '';
      return texto.length > 60 ? texto.slice(0, 60) + '…' : texto;
    }
  }
}

// ---------- @Menções (tipo Zap) ----------
// Destaca "@fulano" (ou "@todos") dentro do texto de uma mensagem já escapado,
// usando os membros do grupo atual. Se não for grupo, não tem o que destacar.
function destacarMencoes(texto) {
  const seguro = escapeHtml(texto);
  if (chatAtualTipo !== 'group' || !chatAtualMembros.length) return seguro;

  const nomes = chatAtualMembros.map(m => m.username).filter(Boolean).map(escapeHtml);
  if (!nomes.length) return seguro;

  const escapaRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const padrao = new RegExp('@(' + nomes.map(escapaRegex).join('|') + '|todos)\\b', 'gi');

  return seguro.replace(padrao, (trecho, nome) => {
    const ehTodos = nome.toLowerCase() === 'todos';
    const meMencionou = ehTodos || (usuarioAtual && nome.toLowerCase() === usuarioAtual.username.toLowerCase());
    return `<span class="mencao${meMencionou ? ' mencao-eu' : ''}">${trecho}</span>`;
  });
}

// Liga a digitação no campo de mensagem à sugestão de @menção (só existe em grupo)
function configurarMencoes() {
  const input = document.getElementById('input-texto');
  if (!input) return;
  input.addEventListener('input', tratarDigitacaoMencao);
  input.addEventListener('keydown', e => { if (e.key === 'Escape') esconderMencaoPopup(); });
  document.addEventListener('click', e => {
    if (e.target.id !== 'input-texto' && !e.target.closest('#mencao-popup')) esconderMencaoPopup();
  });
}

// Olha o que tá sendo digitado antes do cursor: se terminar em "@algo",
// mostra os membros do grupo que combinam com "algo"
function tratarDigitacaoMencao() {
  if (chatAtualTipo !== 'group' || !chatAtualMembros.length) { esconderMencaoPopup(); return; }

  const input = document.getElementById('input-texto');
  const cursor = input.selectionStart;
  const antesDoCursor = input.value.slice(0, cursor);
  const match = antesDoCursor.match(/(?:^|\s)@([a-zA-Z0-9_.]*)$/);
  if (!match) { esconderMencaoPopup(); return; }

  const consulta = match[1].toLowerCase();
  mencaoAtiva = { inicio: cursor - match[1].length - 1, fim: cursor };

  const candidatos = [{ id: 'todos', username: 'Todos', especial: true }]
    .concat(chatAtualMembros.filter(m => m.id !== usuarioAtual.id))
    .filter(m => m.username.toLowerCase().includes(consulta))
    .slice(0, 6);

  if (!candidatos.length) { esconderMencaoPopup(); return; }
  mostrarMencaoPopup(candidatos);
}

function mostrarMencaoPopup(candidatos) {
  const popup = document.getElementById('mencao-popup');
  if (!popup) return;
  popup.innerHTML = candidatos.map(m => `
    <div class="mencao-item" onmousedown="event.preventDefault(); escolherMencao('${escapeAttr(m.username)}')">
      ${m.especial
        ? '<span class="mencao-item-todos">@</span>'
        : `<span class="avatar-circle avatar-circle--sm">${avatarInnerHtml(m.username, m.photoUrl)}</span>`}
      <span>${escapeHtml(m.username)}</span>
    </div>`).join('');
  popup.classList.remove('oculto');
}

function esconderMencaoPopup() {
  mencaoAtiva = null;
  const popup = document.getElementById('mencao-popup');
  if (popup) popup.classList.add('oculto');
}

// Troca o "@algo" que tava sendo digitado pelo nome escolhido na lista
function escolherMencao(username) {
  const input = document.getElementById('input-texto');
  if (!input || !mencaoAtiva) return;
  const antes = input.value.slice(0, mencaoAtiva.inicio);
  const depois = input.value.slice(mencaoAtiva.fim);
  const inserido = '@' + username + ' ';
  input.value = antes + inserido + depois;
  atualizarBotoesInput();
  const posicao = (antes + inserido).length;
  input.focus();
  input.setSelectionRange(posicao, posicao);
  esconderMencaoPopup();
}
configurarMencoes();


function enviarTexto() {
  if (chatAtualRemovido) return;
  const input = document.getElementById('input-texto');
  const texto = input.value.trim();
  if (!texto || !chatAtualId) return;

  socket.emit('send_message', {
    chatId: chatAtualId,
    userId: usuarioAtual.id,
    type: 'text',
    content: texto,
    replyTo: respondendoA
  });

  input.value = '';
  atualizarBotoesInput();
  cancelarResposta();
}

// celular: com texto digitado mostra "enviar", sem texto mostra o microfone (o CSS faz a troca)
function atualizarBotoesInput() {
  const input = document.getElementById('input-texto');
  const area = input && input.closest('.input-area');
  if (area) area.classList.toggle('digitando', input.value.trim().length > 0);
}

// ---------- Responder ----------
function responderMensagem(id) {
  const msg = mensagensCacheAtual.get(id);
  if (!msg) return;
  respondendoA = {
    id: msg.id,
    userId: msg.senderId,
    userName: nomeDoRemetente(msg),
    // nome "de verdade" de quem escreveu — o userName acima vira "Você" pra quem respondeu,
    // e esse texto fica gravado na mensagem, então o outro lado via "Você" errado.
    realName: msg.senderId === usuarioAtual.id ? usuarioAtual.username : (msg.senderUsername || 'Usuário removido'),
    snippet: previaDaMensagem(msg)
  };
  document.getElementById('reply-preview-nome').textContent = respondendoA.userName;
  document.getElementById('reply-preview-text').textContent = respondendoA.snippet;
  document.getElementById('reply-preview').style.display = 'flex';
  document.getElementById('input-texto').focus();
}
function cancelarResposta() {
  respondendoA = null;
  document.getElementById('reply-preview').style.display = 'none';
}

// ---------- Editar ----------
async function editarMensagem(id) {
  const atual = document.querySelector(`[data-id="${id}"] .conteudo`);
  const valores = await abrirModal({
    titulo: 'Editar mensagem',
    campos: [{ id: 'texto', label: 'Novo texto', tipo: 'textarea', valor: atual ? atual.textContent : '' }],
    textoBotao: 'Salvar'
  });
  if (!valores || valores.texto === '') return;
  socket.emit('edit_message', { messageId: id, userId: usuarioAtual.id, newContent: valores.texto });
}

// ---------- Apagar ----------
async function apagarMensagem(id) {
  const aceitou = await abrirConfirmacao({ titulo: 'Apagar mensagem', mensagem: 'Apagar essa mensagem?', textoBotao: 'Apagar' });
  if (!aceitou) return;
  socket.emit('delete_message', { messageId: id, userId: usuarioAtual.id });
}

// ---------- Áudio / Vídeo ----------
let iniciandoGravacao = false; // trava pra evitar 2 toques rápidos abrirem 2 gravações ao mesmo tempo
let gravacaoCancelada = false; // true quando a pessoa apertou "cancelar" em vez de "enviar"
let gravacaoInicioEm = 0;
let gravacaoTimerId = null;

async function alternarGravacao(tipo) {
  if (gravador && gravador.state === 'recording') return; // já gravando: usa os botões da barrinha
  if (iniciandoGravacao) return; // já tem um getUserMedia em andamento, ignora o toque duplicado

  iniciandoGravacao = true;

  try {
    tipoGravando = tipo;
    gravacaoCancelada = false;
    const constraints = tipo === 'video' ? { audio: true, video: true } : { audio: true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);

    chunksGravacao = [];
    gravador = new MediaRecorder(stream);
    gravador.ondataavailable = e => { if (e.data && e.data.size > 0) chunksGravacao.push(e.data); };
    gravador.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      esconderBarraGravacao();
      if (gravacaoCancelada || chunksGravacao.length === 0) {
        chunksGravacao = [];
        return; // gravação cancelada ou nada foi gravado
      }
      const mimeType = (gravador && gravador.mimeType) || (chunksGravacao.find(c => c.type) || {}).type || (tipo === 'video' ? 'video/webm' : 'audio/webm');
      const blob = new Blob(chunksGravacao, { type: mimeType });
      chunksGravacao = [];
      if (!blob.size) {
        mostrarAviso('A gravação ficou vazia. Tente gravar novamente.');
        return;
      }
      await enviarMidia(blob, tipo);
    };

    // passar um intervalo (1s) faz o navegador ir salvando pedaços aos poucos
    // em vez de só no final — em celular isso evita perder um trecho do áudio
    // se o app for pra segundo plano ou o navegador cortar a gravação sozinho.
    gravador.start(1000);
    mostrarBarraGravacao(tipo);
  } catch (err) {
    mostrarAviso('Não consegui acessar o microfone. Verifique a permissão do navegador.');
  } finally {
    iniciandoGravacao = false;
  }
}

// ---------- Barrinha "gravando..." (tipo Zap), com cancelar/enviar ----------
function pegarInputAreaAtiva() {
  // no celular a área de chat pode estar dentro de #chat-view (index.html) ou
  // ser a única .input-area da tela (app.html) — cobre os dois casos
  const dentroDoChat = document.querySelector('#chat-view .input-area');
  return dentroDoChat || document.querySelector('.input-area');
}

function mostrarBarraGravacao(tipo) {
  const inputArea = pegarInputAreaAtiva();
  const barra = document.getElementById('barra-gravacao');
  if (!inputArea || !barra) return;

  inputArea.style.display = 'none';
  barra.style.display = 'flex';

  const icone = document.getElementById('barra-gravacao-icone');
  if (icone) icone.textContent = tipo === 'video' ? '🎥' : '🎤';

  gravacaoInicioEm = Date.now();
  atualizarTimerGravacao();
  gravacaoTimerId = setInterval(atualizarTimerGravacao, 500);
}

function atualizarTimerGravacao() {
  const el = document.getElementById('barra-gravacao-timer');
  if (!el) return;
  const totalSeg = Math.floor((Date.now() - gravacaoInicioEm) / 1000);
  const min = Math.floor(totalSeg / 60);
  const seg = totalSeg % 60;
  el.textContent = `${min}:${String(seg).padStart(2, '0')}`;
}

function esconderBarraGravacao() {
  if (gravacaoTimerId) { clearInterval(gravacaoTimerId); gravacaoTimerId = null; }
  const inputArea = pegarInputAreaAtiva();
  const barra = document.getElementById('barra-gravacao');
  if (barra) barra.style.display = 'none';
  if (inputArea) inputArea.style.display = 'flex';
}

// Botão ✕ da barrinha: descarta a gravação, não manda nada
function cancelarGravacao() {
  if (!gravador || gravador.state !== 'recording') return;
  gravacaoCancelada = true;
  gravador.stop();
}

// Botão ✓/enviar da barrinha: para de gravar e manda normalmente
function enviarGravacao() {
  if (!gravador || gravador.state !== 'recording') return;
  gravador.stop();
}

async function enviarMidia(blob, tipo) {
  if (!blob || !blob.size) {
    mostrarAviso('O áudio ficou vazio. Grave novamente antes de enviar.');
    return;
  }
  if (!chatAtualId || !usuarioAtual || !usuarioAtual.id || !socket) {
    mostrarAviso('Abra uma conversa antes de enviar o áudio.');
    return;
  }

  const mimeType = blob.type || (tipo === 'video' ? 'video/webm' : 'audio/webm');
  const extensao = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mpeg') ? 'mp3' : 'webm';
  const formData = new FormData();
  formData.append('file', blob, `${tipo}.${extensao}`);

  try {
    const resp = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || typeof data.url !== 'string' || !data.url.trim()) {
      throw new Error(data.error || 'O servidor não confirmou o upload do áudio.');
    }

    socket.emit('send_message', {
      chatId: chatAtualId,
      userId: usuarioAtual.id,
      type: tipo,
      mediaUrl: data.url,
      replyTo: respondendoA
    });
    cancelarResposta();
  } catch (err) {
    console.error('Falha ao enviar mídia:', err);
    mostrarAviso(err && err.message ? err.message : 'Não foi possível enviar o áudio. Verifique sua conexão e tente novamente.');
  }
}

// ---------- Anexar arquivo (foto, pdf, docx, mp3 etc.) ----------
async function enviarAnexo(file) {
  if (!file || !chatAtualId || !usuarioAtual || !socket) return;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const resp = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || typeof data.url !== 'string' || !data.url.trim()) {
      throw new Error(data.error || 'O servidor não confirmou o upload do arquivo.');
    }

    const tipo = file.type.startsWith('image/') ? 'image'
      : file.type.startsWith('audio/') ? 'audio'
      : file.type.startsWith('video/') ? 'video'
      : 'file';

    socket.emit('send_message', {
      chatId: chatAtualId,
      userId: usuarioAtual.id,
      type: tipo,
      content: tipo === 'file' ? file.name : null,
      mediaUrl: data.url,
      replyTo: respondendoA
    });

    cancelarResposta();
    const input = document.getElementById('input-anexo');
    if (input) input.value = '';
  } catch (err) {
    console.error('Falha ao enviar anexo:', err);
    mostrarAviso(err && err.message ? err.message : 'Não deu pra enviar esse arquivo.');
  }
}

// ---------- Deslizar mensagem pra responder (tipo o Zap) ----------
// Em vez de precisar tocar na mensagem pra abrir o menu de ações, dá pra
// arrastar ela um pouco pra direita e soltar que já chama responderMensagem().
(function configurarSwipeParaResponder() {
  const LIMIAR_PX = 46;   // quanto precisa arrastar pra disparar o "Responder"
  const MAX_PX = 70;      // até onde a mensagem se move na tela
  let msgEl = null;
  let inicioX = 0, inicioY = 0;
  let deltaAtual = 0;
  let decidiuHorizontal = false;
  let deslizando = false;

  function pegarContainer() {
    return document.getElementById('mensagens');
  }

  function onTouchStart(e) {
    const container = pegarContainer();
    if (!container || !container.contains(e.target)) return;
    const alvo = e.target.closest('.msg');
    if (!alvo) return;
    msgEl = alvo;
    const t = e.touches[0];
    inicioX = t.clientX;
    inicioY = t.clientY;
    deltaAtual = 0;
    decidiuHorizontal = false;
    deslizando = false;
  }

  function onTouchMove(e) {
    if (!msgEl) return;
    const t = e.touches[0];
    const dx = t.clientX - inicioX;
    const dy = t.clientY - inicioY;

    if (!decidiuHorizontal) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        decidiuHorizontal = Math.abs(dx) > Math.abs(dy);
        if (!decidiuHorizontal) { msgEl = null; return; } // deixa rolar a lista normalmente
        deslizando = true;
        msgEl.classList.add('arrastando');
      } else {
        return;
      }
    }

    if (!deslizando) return;
    // só deixa arrastar pra direita (como no Zap)
    const dxClamp = Math.max(0, Math.min(MAX_PX, dx));
    deltaAtual = dxClamp;
    msgEl.style.transform = `translateX(${dxClamp}px)`;
    const icone = msgEl.querySelector('.swipe-icone-responder');
    if (icone) icone.style.opacity = Math.min(1, dxClamp / LIMIAR_PX);
    if (dxClamp > 4) e.preventDefault(); // evita a página rolar junto enquanto arrasta
  }

  function resetarMsg(el) {
    if (!el) return;
    el.classList.remove('arrastando');
    el.style.transform = '';
    const icone = el.querySelector('.swipe-icone-responder');
    if (icone) icone.style.opacity = 0;
  }

  function onTouchEnd() {
    if (!msgEl) return;
    const el = msgEl;
    const disparou = deslizando && deltaAtual >= LIMIAR_PX;
    resetarMsg(el);
    if (disparou) {
      const id = el.dataset.id;
      if (id) {
        if (navigator.vibrate) navigator.vibrate(12);
        responderMensagem(id);
      }
    }
    msgEl = null;
    deslizando = false;
    decidiuHorizontal = false;
  }

  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', onTouchEnd, { passive: true });
})();
// =========================================================
//  PLAYER DE ÁUDIO
// =========================================================
// <<ICONES_ARQUIVO>>
// ---------- Cartão de arquivo: ícone por tipo + nome ----------
// Cada grupo: [cor, rótulo mostrado no ícone (vazio = usa a própria extensão), extensões]
const ICONES_ARQUIVO = {};
(function () {
  const grupos = [
    ['#e5484d', 'PDF',  ['pdf']],
    ['#3b82f6', 'DOC',  ['doc', 'docx', 'odt', 'rtf']],
    ['#22a06b', 'XLS',  ['xls', 'xlsx', 'ods']],
    ['#22a06b', 'CSV',  ['csv']],
    ['#f97316', 'PPT',  ['ppt', 'pptx', 'odp']],
    ['#8b8f9c', 'TXT',  ['txt', 'log', 'md']],
    ['#d9a400', 'ZIP',  ['zip', 'rar', '7z', 'tar', 'gz']],
    ['#8b5cf6', '',     ['js', 'ts', 'py', 'html', 'css', 'json', 'java', 'c', 'cpp', 'cs', 'php', 'sql', 'xml', 'sh']],
    ['#ec4899', '',     ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']],
    ['#14b8a6', '',     ['mp4', 'webm', 'mov', 'mkv', 'avi']],
    ['#06b6d4', '',     ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']],
    ['#64748b', 'APK',  ['apk']],
    ['#64748b', 'EXE',  ['exe', 'msi']]
  ];
  grupos.forEach(([cor, rotulo, exts]) => exts.forEach(e => {
    ICONES_ARQUIVO[e] = { cor, rotulo: rotulo || e.toUpperCase() };
  }));
})();
// Tipos que o navegador sabe mostrar sozinho: abrem em nova aba. O resto baixa.
const ARQUIVOS_ABREM_NO_NAVEGADOR = ['pdf', 'txt', 'log', 'md', 'json', 'csv'];
// <</ICONES_ARQUIVO>>

function extensaoDoArquivo(nome) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(nome || '').trim());
  return m ? m[1].toLowerCase() : '';
}

function tipoDoArquivo(nome) {
  const ext = extensaoDoArquivo(nome);
  const base = ICONES_ARQUIVO[ext] || { cor: '#64748b', rotulo: ext ? ext.toUpperCase().slice(0, 4) : 'ARQ' };
  return { ext, cor: base.cor, rotulo: base.rotulo, abre: ARQUIVOS_ABREM_NO_NAVEGADOR.includes(ext) };
}

// Deixa o nome quebrar depois de _ e - e antes do ponto, assim a extensão (.pdf) nunca é cortada ao meio
function nomeQuebravel(nome) {
  return escapeHtml(nome).replace(/([_-])/g, '$1<wbr>').replace(/\./g, '<wbr>.');
}

function montarCartaoArquivo(msg) {
  const nome = msg.content || 'arquivo';
  const t = tipoDoArquivo(nome);
  const tamanhoFonte = t.rotulo.length > 3 ? 9 : 11;
  const icone = '<svg class="arq-icone" viewBox="0 0 40 48" aria-hidden="true">'
    + '<path d="M6 2h20l12 12v30a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="' + t.cor + '"/>'
    + '<path d="M26 2l12 12H28a2 2 0 0 1-2-2z" fill="rgba(255,255,255,.38)"/>'
    + '<text x="20" y="37" text-anchor="middle" font-size="' + tamanhoFonte + '" font-weight="800" '
    + 'font-family="Arial, Helvetica, sans-serif" fill="#fff">' + escapeHtml(t.rotulo) + '</text></svg>';
  const atributos = t.abre
    ? 'target="_blank" rel="noopener"'
    : 'download="' + escapeAttr(nome) + '" target="_blank" rel="noopener"';
  return '<a class="arq-cartao" href="' + escapeAttr(msg.mediaUrl) + '" ' + atributos + ' title="' + escapeAttr(nome) + '">'
    + icone
    + '<span class="arq-info"><span class="arq-nome">' + nomeQuebravel(nome) + '</span>'
    + '<span class="arq-sub">' + escapeHtml(t.rotulo) + ' · ' + (t.abre ? 'Abrir' : 'Baixar') + '</span></span></a>';
}

const AUDIO_BARRAS = 34;

function ondasDoAudio(seed) {
  let n = 7;
  for (let i = 0; i < (seed || '').length; i++) n = (n * 31 + seed.charCodeAt(i)) % 2147483647;
  let html = '';
  for (let i = 0; i < AUDIO_BARRAS; i++) {
    n = (n * 1103515245 + 12345) % 2147483647;
    const altura = 20 + (n % 80);
    html += `<span class="audio-barra" style="height:${altura}%"></span>`;
  }
  return html;
}

function montarPlayerAudio(msg) {
  // .replace(...) tira as quebras de linha e espaços do template, que viravam linhas em branco
  return `
    <div class="audio-player">
      <button class="audio-btn" type="button" aria-label="Tocar áudio">
        <svg class="audio-icone audio-icone-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        <svg class="audio-icone audio-icone-pause oculto" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>
      </button>
      <div class="audio-meio">
        <div class="audio-onda">${ondasDoAudio(msg.id)}</div>
        <div class="audio-rodape">
          <span class="audio-tempo">0:00</span>
          <button class="audio-velocidade" type="button" title="Velocidade">1×</button>
        </div>
      </div>
      <audio preload="metadata" src="${escapeAttr(msg.mediaUrl)}"></audio>
    </div>`.replace(/>\s+</g, '><').trim();
}

function formatarTempoAudio(seg) {
  if (!isFinite(seg) || seg < 0) return '0:00';
  const m = Math.floor(seg / 60);
  const s = Math.floor(seg % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function pausarOutrosAudios(atual) {
  document.querySelectorAll('.audio-player audio').forEach(a => {
    if (a !== atual && !a.paused) a.pause();
  });
}

function ligarPlayerAudio(divMsg) {
  const player = divMsg.querySelector('.audio-player');
  if (!player) return;
  const audio = player.querySelector('audio');
  const btn = player.querySelector('.audio-btn');
  const onda = player.querySelector('.audio-onda');
  const barras = Array.from(player.querySelectorAll('.audio-barra'));
  const tempoEl = player.querySelector('.audio-tempo');
  const btnVel = player.querySelector('.audio-velocidade');
  const iconePlay = player.querySelector('.audio-icone-play');
  const iconePause = player.querySelector('.audio-icone-pause');
  const velocidades = [1, 1.5, 2];
  let velocidadeAtual = 0;
  let consertandoDuracao = false;

  function pintar(fracao) {
    const ate = Math.round(fracao * barras.length);
    barras.forEach((b, i) => b.classList.toggle('tocada', i < ate));
  }

  audio.addEventListener('loadedmetadata', () => {
    if (audio.duration === Infinity && !consertandoDuracao) {
      consertandoDuracao = true; audio.currentTime = 1e5; return;
    }
    tempoEl.textContent = formatarTempoAudio(audio.duration);
  });
  audio.addEventListener('durationchange', () => {
    if (consertandoDuracao && isFinite(audio.duration)) {
      consertandoDuracao = false; audio.currentTime = 0;
      tempoEl.textContent = formatarTempoAudio(audio.duration);
    }
  });
  btn.onclick = () => { if (audio.paused) { pausarOutrosAudios(audio); audio.play(); } else audio.pause(); };
  audio.addEventListener('play', () => { player.classList.add('tocando'); iconePlay.classList.add('oculto'); iconePause.classList.remove('oculto'); });
  ['pause','ended'].forEach(ev => audio.addEventListener(ev, () => {
    player.classList.remove('tocando'); iconePlay.classList.remove('oculto'); iconePause.classList.add('oculto');
    if (ev === 'ended') { pintar(0); tempoEl.textContent = formatarTempoAudio(audio.duration); }
  }));
  audio.addEventListener('timeupdate', () => {
    if (consertandoDuracao) return;
    if (isFinite(audio.duration) && audio.duration > 0) pintar(audio.currentTime / audio.duration);
    tempoEl.textContent = formatarTempoAudio(audio.currentTime);
  });
  onda.onclick = e => {
    if (!isFinite(audio.duration) || !audio.duration) return;
    const rect = onda.getBoundingClientRect();
    audio.currentTime = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * audio.duration;
  };
  btnVel.onclick = () => {
    velocidadeAtual = (velocidadeAtual + 1) % velocidades.length;
    audio.playbackRate = velocidades[velocidadeAtual];
    btnVel.textContent = velocidades[velocidadeAtual] + '×';
  };
}

// =========================================================
//  ENCAMINHAR (máx 5)
// =========================================================
const MAX_ENCAMINHAR = 5;
let modoEncaminhar = false;
let msgsSelecionadas = new Set();

function iniciarEncaminhar(id) {
  modoEncaminhar = true;
  msgsSelecionadas = new Set([id]);
  const container = document.getElementById('mensagens');
  if (container) container.classList.add('selecionando');
  document.querySelectorAll('#mensagens .msg').forEach(el => {
    el.classList.toggle('msg-selecionada', msgsSelecionadas.has(el.dataset.id));
  });
  mostrarBarraEncaminhar();
}

function alternarSelecaoMsg(id, el) {
  if (msgsSelecionadas.has(id)) { msgsSelecionadas.delete(id); el.classList.remove('msg-selecionada'); }
  else {
    if (msgsSelecionadas.size >= MAX_ENCAMINHAR) { mostrarAviso(`Máximo de ${MAX_ENCAMINHAR} mensagens por vez.`); return; }
    msgsSelecionadas.add(id); el.classList.add('msg-selecionada');
  }
  if (!msgsSelecionadas.size) { sairDoModoEncaminhar(); return; }
  mostrarBarraEncaminhar();
}

document.addEventListener('click', e => {
  if (!modoEncaminhar) return;
  const el = e.target.closest('#mensagens .msg');
  if (!el || !el.dataset.id) return;
  e.preventDefault(); e.stopPropagation();
  alternarSelecaoMsg(el.dataset.id, el);
}, true);

function mostrarBarraEncaminhar() {
  let barra = document.getElementById('barra-encaminhar');
  if (!barra) {
    barra = document.createElement('div');
    barra.id = 'barra-encaminhar';
    barra.className = 'barra-encaminhar';
    const chatView = document.getElementById('chat-view');
    if (chatView) chatView.appendChild(barra);
  }
  barra.innerHTML = `
    <span class="barra-encaminhar-info">${msgsSelecionadas.size} de ${MAX_ENCAMINHAR} selecionada${msgsSelecionadas.size === 1 ? '' : 's'}</span>
    <button class="btn-link" type="button" onclick="sairDoModoEncaminhar()">Cancelar</button>
    <button class="btn-ok btn-compacto" type="button" onclick="abrirDestinoEncaminhar()">Encaminhar →</button>`;
}

function sairDoModoEncaminhar() {
  modoEncaminhar = false; msgsSelecionadas = new Set();
  const container = document.getElementById('mensagens');
  if (container) container.classList.remove('selecionando');
  document.querySelectorAll('.msg-selecionada').forEach(el => el.classList.remove('msg-selecionada'));
  const barra = document.getElementById('barra-encaminhar');
  if (barra) barra.remove();
}

function abrirDestinoEncaminhar() {
  const destinos = todasAsConversas.filter(c => !c.removidoDoGrupo);
  const root = document.getElementById('modal-root');
  const linhas = destinos.length
    ? destinos.map(c => `
        <div class="dropdown-item conta-item dropdown-clicavel" onclick="encaminharPara('${c.id}')">
          <span class="conta-info">
            <span class="avatar-circle avatar-circle--sm">${avatarInnerHtml(c.name, c.photoUrl)}</span>
            <span>${escapeHtml(c.name)}</span>
          </span>
          ${c.type === 'group' ? '<span class="tag-papel tag-admin">Grupo</span>' : ''}
        </div>`).join('')
    : '<p class="modal-texto">Você não tem conversas para encaminhar.</p>';
  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box">
        <h3 class="modal-title">Encaminhar para</h3>
        <p class="modal-texto">${msgsSelecionadas.size} mensagem${msgsSelecionadas.size === 1 ? '' : 's'} selecionada${msgsSelecionadas.size === 1 ? '' : 's'}.</p>
        <div class="lista-contatos">${linhas}</div>
        <div class="modal-actions">
          <button class="btn-outline btn-compacto" id="encaminhar-cancelar" type="button">Cancelar</button>
        </div>
      </div>
    </div>`;
  document.getElementById('encaminhar-cancelar').onclick = () => { root.innerHTML = ''; };
  document.getElementById('modal-overlay').onclick = e => { if (e.target.id === 'modal-overlay') root.innerHTML = ''; };
}

function encaminharPara(chatId) {
  const msgs = Array.from(msgsSelecionadas).map(id => mensagensCacheAtual.get(id)).filter(m => m && !m.deleted);
  document.getElementById('modal-root').innerHTML = '';
  if (!msgs.length) { sairDoModoEncaminhar(); return; }
  msgs.forEach(m => socket.emit('send_message', { chatId, userId: usuarioAtual.id, type: m.type, content: m.content, mediaUrl: m.mediaUrl, encaminhada: true }));
  const total = msgs.length;
  sairDoModoEncaminhar();
  mostrarAviso(`${total} mensagem${total === 1 ? '' : 's'} encaminhada${total === 1 ? '' : 's'}.`, 'sucesso');
  carregarListaChats();
}

// =========================================================
//  PERFIL DA PESSOA (PV)
// =========================================================
function abrirInfoConversa() {
  if (chatAtualTipo === 'group') { abrirInfoGrupo(); return; }
  if (chatAtualOutro) abrirPerfilUsuario(chatAtualOutro.id);
}

async function abrirPerfilUsuario(userId) {
  const resp = await fetch(`/api/users/${userId}/public?viewerId=${usuarioAtual.id}`);
  if (!resp.ok) { mostrarAviso('Não foi possível abrir esse perfil.'); return; }
  const u = await resp.json();
  const root = document.getElementById('modal-root');
  const ring = /^#[0-9a-fA-F]{6}$/.test(u.ringColor || '') ? u.ringColor : '#ffb454';
  const fotoHtml = u.photoUrl
    ? `<img class="perfil-foto-grande" style="border-color:${escapeAttr(ring)}" src="${escapeAttr(u.photoUrl)}" alt="Foto de ${escapeAttr(u.username)}" onclick="window.open('${escapeAttr(u.photoUrl)}','_blank')" title="Ver foto em tamanho grande">`
    : `<div class="avatar-circle avatar-circle--lg perfil-editor-avatar" style="border-color:${escapeAttr(ring)}">${avatarInnerHtml(u.username, null)}</div>`;
  const bioHtml = u.bio ? `<div class="perfil-bio-card"><span class="perfil-bio-aspas perfil-bio-aspas--abre" aria-hidden="true">“</span><p class="perfil-bio">${escapeHtml(u.bio)}</p><span class="perfil-bio-aspas perfil-bio-aspas--fecha" aria-hidden="true">”</span></div>` : `<div class="perfil-bio-card perfil-bio-card--vazia"><span class="perfil-bio-aspas perfil-bio-aspas--abre" aria-hidden="true">“</span><p class="perfil-bio perfil-bio--vazia">Sem bio.</p><span class="perfil-bio-aspas perfil-bio-aspas--fecha" aria-hidden="true">”</span></div>`;
  const redes = Array.isArray(u.socials) ? u.socials : [];
  const bases = { instagram: 'https://www.instagram.com/', tiktok: 'https://www.tiktok.com/@', youtube: 'https://www.youtube.com/@', facebook: 'https://www.facebook.com/', x: 'https://x.com/' };
  const nomes = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook', x: 'X' };
  const linksHtml = redes.map(r => {
    if (!bases[r.network] || !r.handle) return '';
    const handle = r.handle.replace(/^@+/, '');
    const url = bases[r.network] + encodeURIComponent(handle);
    return `<a class="perfil-rede-link" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer"><span class="perfil-rede-icone mdi mdi-${r.network === 'x' ? 'alpha-x-circle' : r.network === 'youtube' ? 'youtube' : r.network}"></span><span class="perfil-rede-nome">${nomes[r.network]}</span><span class="perfil-rede-handle">@${escapeHtml(handle)}</span><span class="mdi mdi-open-in-new perfil-rede-externo"></span></a>`;
  }).join('');
  const phoneHtml = u.phone ? `<a class="perfil-contato-link" href="https://wa.me/${u.phone.replace(/\D/g, '')}" target="_blank" rel="noopener noreferrer"><span class="mdi mdi-whatsapp"></span><span>${escapeHtml(u.phone)}</span><span class="mdi mdi-open-in-new"></span></a>` : '';
  root.innerHTML = `
    <div class="modal-overlay perfil-overlay" id="modal-overlay">
      <div class="modal-box modal-box--perfil perfil-publico-card">
        <button class="perfil-fechar-x" id="perfil-usuario-fechar-x" type="button" aria-label="Fechar perfil">×</button>
        <div class="perfil-publico-hero">${fotoHtml}<h3 class="modal-title info-grupo-nome">${escapeHtml(u.username)}</h3><span class="perfil-publico-tag">Perfil do ChatDevs</span>${bioHtml}</div>
        <div class="perfil-publico-detalhes">${phoneHtml}${linksHtml ? `<div class="perfil-redes-lista">${linksHtml}</div>` : '<p class="perfil-bio perfil-bio--vazia">Nenhuma rede social adicionada.</p>'}</div>
        <div class="modal-actions"><button class="btn-ok btn-compacto" id="perfil-usuario-fechar" type="button">Fechar perfil</button></div>
      </div>
    </div>`;
  const fechar = () => { root.innerHTML = ''; };
  document.getElementById('perfil-usuario-fechar').onclick = fechar;
  document.getElementById('perfil-usuario-fechar-x').onclick = fechar;
  document.getElementById('modal-overlay').onclick = e => { if (e.target.id === 'modal-overlay') fechar(); };
}
