const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
require('dotenv').config();
const { loadDB, saveDB, init } = require('./db');

// ── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
console.log('[auth] Supabase configurado:', process.env.SUPABASE_URL);

// ── Cloudinary ──────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_CONTAS_POR_IP = 3;
const LIMITE_EDICAO_MS = 60 * 1000; // 1 minuto
const VIDA_MIDIA_MS = 12 * 60 * 60 * 1000; // 12 horas

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// uploads servidos direto do Cloudinary

// ---------- Upload de mídia → Cloudinary ----------
const cloudStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: 'chatdevs',
    resource_type: 'auto',
    public_id: uuidv4(),
  }),
});
const upload = multer({ storage: cloudStorage, limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  res.json({ url: req.file.path, filename: req.file.filename });
});

// ---------- Helpers ----------
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress;
}

function publicUser(u) {
  return { id: u.id, username: u.username, email: u.email, photoUrl: u.photoUrl || null, bio: u.bio || '' };
}

function findUserByEmailOrUsername(db, query) {
  const q = query.trim().toLowerCase();
  return db.users.find(
    u => u.email.toLowerCase() === q || u.username.toLowerCase() === q
  );
}

// cria (sem salvar) uma mensagem de aviso do sistema, tipo "Fulano entrou no grupo"
// `content` é o texto padrão (usado como fallback, ex: no /api/stats ou se faltar metadado).
// `meta` é opcional: { kind: 'add_member' | 'promote' | 'remove_member', actorId, targetId }
// Guardando o meta em vez de só o texto, dá pra remontar a frase certa pra cada pessoa
// que olha a mensagem (ex: "você" no lugar do próprio nome), sem precisar de outra tabela.
function criarMensagemSistema(chatId, content, meta) {
  return {
    id: uuidv4(),
    chatId,
    senderId: null,
    type: 'system',
    content,
    systemMeta: meta || null,
    mediaUrl: null,
    mediaCreatedAt: null,
    replyTo: null,
    createdAt: Date.now(),
    editedAt: null,
    deleted: false
  };
}

// pega uma mensagem de sistema e devolve uma cópia com o `content` reescrito
// do ponto de vista de quem tá olhando (viewerId). Se não tiver systemMeta
// (mensagens antigas, criadas antes dessa mudança), devolve como já estava.
function personalizarMensagem(msg, viewerId, db) {
  if (msg.type !== 'system' || !msg.systemMeta) return msg;
  const { kind, actorId, targetId } = msg.systemMeta;
  const ator = db.users.find(u => u.id === actorId);
  const alvo = db.users.find(u => u.id === targetId);
  const atorNome = ator ? ator.username : 'Alguém';
  const alvoNome = alvo ? alvo.username : 'Alguém';

  let content = msg.content;
  if (kind === 'add_member') {
    if (viewerId === actorId) content = `Você adicionou ${alvoNome} ao grupo`;
    else if (viewerId === targetId) content = `${atorNome} adicionou você ao grupo`;
    else content = `${alvoNome} foi adicionado ao grupo`;
  } else if (kind === 'promote') {
    content = viewerId === targetId
      ? 'Você agora é um admin do grupo'
      : `${alvoNome} agora é admin do grupo`;
  } else if (kind === 'remove_member') {
    content = viewerId === targetId
      ? 'Você foi removido do grupo'
      : `${alvoNome} foi removido do grupo`;
  } else if (kind === 'join_link') {
    content = viewerId === targetId
      ? 'Você entrou no grupo pelo link de convite'
      : `${alvoNome} entrou no grupo pelo link de convite`;
  } else if (kind === 'rename') {
    content = viewerId === actorId
      ? `Você mudou o nome do grupo para "${msg.systemMeta.novoNome}"`
      : `${atorNome} mudou o nome do grupo para "${msg.systemMeta.novoNome}"`;
  } else if (kind === 'description') {
    content = viewerId === actorId
      ? 'Você mudou a descrição do grupo'
      : `${atorNome} mudou a descrição do grupo`;
  } else if (kind === 'photo') {
    const acao = msg.systemMeta.removida ? 'removeu' : 'mudou';
    content = viewerId === actorId ? `Você ${acao} a foto do grupo` : `${atorNome} ${acao} a foto do grupo`;
  } else if (kind === 'modo_envio') {
    const modo = msg.systemMeta.modo;
    const textos = {
      todos: viewerId === actorId
        ? 'Você abriu o grupo: agora todo mundo pode mandar mensagem'
        : `${atorNome} abriu o grupo: agora todo mundo pode mandar mensagem`,
      admins: viewerId === actorId
        ? 'Você fechou o grupo: agora só admins podem mandar mensagem'
        : `${atorNome} fechou o grupo: agora só admins podem mandar mensagem`,
      dono: viewerId === actorId
        ? 'Você restringiu o grupo: agora só você pode mandar mensagem'
        : `${atorNome} restringiu o grupo: agora só o dono pode mandar mensagem`
    };
    content = textos[modo] || msg.content;
  }
  return Object.assign({}, msg, { content });
}

// manda uma mensagem já personalizada pra cada membro do grupo, individualmente,
// em vez de uma frase igual pra sala toda (usa a room 'user:<id>', que já existe
// desde o evento 'join' do socket — não depende de quem já abriu o chat ou não).
function emitirMensagemSistemaPersonalizada(db, membros, msg) {
  membros.forEach(memberId => {
    const personalizada = personalizarMensagem(msg, memberId, db);
    io.to('user:' + memberId).emit('new_message', personalizada);
  });
}

function souDono(chat, userId) {
  return chat.createdBy === userId;
}
function souAdminDoGrupo(chat, userId) {
  return souDono(chat, userId) || (chat.admins || []).includes(userId);
}

// modo de envio do grupo: 'todos' (padrão) | 'admins' (só dono/admins) | 'dono' (só o dono, nem admins)
function podeEnviarMensagem(chat, userId) {
  if (chat.type !== 'group') return true;
  const modo = chat.modoEnvio || 'todos';
  if (modo === 'dono') return souDono(chat, userId);
  if (modo === 'admins') return souAdminDoGrupo(chat, userId);
  return true;
}

// registra o momento em que alguém entrou num grupo (usado pra esconder mensagens antigas de quem entrou depois)
// e garante que, se a pessoa tinha saído/sido removida antes, ela some da lista de "Saíram"
function marcarEntradaNoGrupo(chat, userId, timestamp) {
  if (!chat.memberJoinedAt) chat.memberJoinedAt = {};
  chat.memberJoinedAt[userId] = timestamp || Date.now();
  if (chat.removedMembers) chat.removedMembers = chat.removedMembers.filter(r => r.userId !== userId);
}

// ---------- Privacidade da foto de perfil ----------
// contato "de verdade" é uma escolha explícita: alguém apertou "Salvar contato" pra essa pessoa.
// É direcional — eu ter te salvo não faz com que eu tenha te dado permissão de ver a MINHA foto,
// o que importa pra privacidade é se o DONO da foto salvou quem está olhando.
function ehContatoSalvo(db, ownerId, contactId) {
  if (ownerId === contactId) return true;
  return db.contacts.some(c => c.ownerId === ownerId && c.contactId === contactId);
}

// decide se `viewerId` pode enxergar a foto de `ownerUser`, de acordo com a
// preferência de privacidade que o dono da foto escolheu
function fotoVisivelPara(db, ownerUser, viewerId) {
  if (!ownerUser) return false;
  if (!viewerId || viewerId === ownerUser.id) return true; // você sempre vê a sua própria foto
  const privacidade = ownerUser.photoPrivacy || 'todos';
  if (privacidade === 'todos') return true;
  if (privacidade === 'ninguem') return false;
  if (privacidade === 'contatos') return ehContatoSalvo(db, ownerUser.id, viewerId);
  if (privacidade === 'lista') return (ownerUser.photoAllowList || []).includes(viewerId);
  return true;
}

// devolve a URL da foto de `ownerUser`, já filtrada pro ponto de vista de `viewerId`
// (null se a privacidade escolhida não deixar esse viewer enxergar)
function fotoParaViewer(db, ownerUser, viewerId) {
  if (!ownerUser) return null;
  return fotoVisivelPara(db, ownerUser, viewerId) ? (ownerUser.photoUrl || null) : null;
}

// ---------- Cadastro ----------
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Preencha usuário, email e senha' });
  }

  const db = loadDB();
  const ip = getClientIp(req);

  // limpa cadastros "órfãos": existem no Mongo mas não existem mais no Supabase Auth
  for (const u of db.users.slice()) {
    if (u.username.toLowerCase() === username.toLowerCase() || u.email.toLowerCase() === email.toLowerCase()) {
      const { data: existe } = await supabase.auth.admin.getUserById(u.id);
      if (!existe || !existe.user) {
        db.users = db.users.filter(x => x.id !== u.id);
      }
    }
  }

  // checa username duplicado no MongoDB
  const usernameExiste = db.users.some(u => u.username.toLowerCase() === username.toLowerCase());
  if (usernameExiste) return res.status(409).json({ error: 'Nome de usuário já cadastrado' });

  // limite por IP
  const contasNesseIp = db.ipCounts[ip] || 0;
  if (contasNesseIp >= MAX_CONTAS_POR_IP) {
    return res.status(403).json({ error: 'Limite de 3 contas por IP atingido' });
  }

  // cria no Supabase Auth via signUp — ele envia o e-mail de confirmação sozinho
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { username },
      emailRedirectTo: process.env.SITE_URL || 'https://chatdevs-production.up.railway.app'
    }
  });

  if (error) {
    if (error.message.toLowerCase().includes('already')) return res.status(409).json({ error: 'Email já cadastrado' });
    return res.status(400).json({ error: error.message });
  }
  // e-mail já confirmado por outra conta: o Supabase devolve usuário "falso" sem identities
  if (!data.user || (data.user.identities && data.user.identities.length === 0)) {
    return res.status(409).json({ error: 'Email já cadastrado' });
  }

  // salva perfil no MongoDB com o id do Supabase
  const user = {
    id: data.user.id, // usa o uuid do Supabase
    username,
    email,
    createdIp: ip,
    createdAt: Date.now()
  };
  db.users.push(user);
  db.ipCounts[ip] = contasNesseIp + 1;
  saveDB(db);

  res.json({ user: publicUser(user), verificacaoPendente: true });
});

// ---------- Login ----------
app.post('/api/login', async (req, res) => {
  const { emailOrUsername, password } = req.body;
  const db = loadDB();

  // resolve username → email se necessário
  let email = emailOrUsername;
  if (!emailOrUsername.includes('@')) {
    const u = db.users.find(u => u.username.toLowerCase() === emailOrUsername.toLowerCase());
    if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
    email = u.email;
  }

  // autentica pelo Supabase
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.message.includes('Email not confirmed')) {
      const u = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
      return res.status(403).json({ error: 'Confirme seu e-mail antes de entrar.', verificacaoPendente: true, userId: u?.id, email: u?.email });
    }
    return res.status(401).json({ error: 'Email ou senha incorretos' });
  }

  // pega o perfil do MongoDB
  const user = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Perfil não encontrado' });

  res.json({ user: publicUser(user), token: data.session.access_token });
});

// ---------- Verificar email (reenviar link) ----------
app.post('/api/resend-verification', async (req, res) => {
  const { userId } = req.body;
  const db = loadDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.json({ ok: true });

  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: user.email,
    options: { emailRedirectTo: process.env.SITE_URL || 'https://chatdevs-production.up.railway.app' }
  });
  if (error) return res.status(429).json({ error: 'Não foi possível reenviar agora. Aguarde 1 minuto e tente de novo.' });
  res.json({ ok: true });
});

// ---------- Esqueci a senha ----------
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ ok: true });

  const db = loadDB();
  const user = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return res.json({ ok: true }); // não revela se existe

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: (process.env.SITE_URL || 'https://chatdevs-production.up.railway.app') + '/reset-password'
  });

  if (error) return res.status(429).json({ ok: false, error: 'Não foi possível enviar agora. Aguarde 1 minuto e tente de novo.' });
  res.json({ ok: true });
});

// ---------- Página de nova senha (o link do e-mail abre aqui) ----------
app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

// ---------- Salvar a nova senha (usa o token que veio no link do e-mail) ----------
app.post('/api/reset-password', async (req, res) => {
  const { accessToken, novaSenha } = req.body;
  if (!accessToken || !novaSenha) return res.status(400).json({ error: 'Dados incompletos.' });
  if (novaSenha.length < 6) return res.status(400).json({ error: 'Senha muito curta (mínimo 6 caracteres).' });

  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data || !data.user) {
    return res.status(401).json({ error: 'Link inválido ou expirado. Peça um novo em "Esqueceu a senha?".' });
  }

  const { error: erroSenha } = await supabase.auth.admin.updateUserById(data.user.id, { password: novaSenha });
  if (erroSenha) {
    const msg = /different|same/i.test(erroSenha.message)
      ? 'A nova senha precisa ser diferente da atual.'
      : 'Não foi possível salvar a senha. Tente de novo.';
    return res.status(400).json({ error: msg });
  }
  res.json({ ok: true });
});

// ---------- Salvar bio ----------
app.post('/api/users/:userId/bio', (req, res) => {
  const { userId } = req.params;
  const { bio } = req.body;
  const db = loadDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  user.bio = (bio || '').trim().slice(0, 20);
  saveDB(db);
  res.json({ ok: true, bio: user.bio });
});

// ---------- Trocar ou remover a própria foto de perfil ----------
app.post('/api/users/:userId/photo', (req, res) => {
  const { userId } = req.params;
  const { photoUrl } = req.body;
  const db = loadDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  user.photoUrl = photoUrl || null;
  saveDB(db);
  res.json({ ok: true, user: publicUser(user) });
});

// ---------- Buscar usuário (pra iniciar conversa) ----------
app.get('/api/find-user', (req, res) => {
  const { query, viewerId } = req.query;
  if (!query) return res.status(400).json({ error: 'Informe email ou usuário' });
  const db = loadDB();
  const user = findUserByEmailOrUsername(db, query);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  const pub = publicUser(user);
  pub.photoUrl = fotoParaViewer(db, user, viewerId);
  res.json({ user: pub });
});

// ---------- Salvar um contato de verdade (clique em "Salvar contato") ----------
app.post('/api/contacts', (req, res) => {
  const { ownerId, contactId } = req.body;
  if (!ownerId || !contactId) return res.status(400).json({ error: 'Dados incompletos' });
  const db = loadDB();
  const jaSalvo = db.contacts.some(c => c.ownerId === ownerId && c.contactId === contactId);
  if (!jaSalvo) {
    db.contacts.push({ ownerId, contactId, createdAt: Date.now() });
    saveDB(db);
  }
  res.json({ ok: true });
});

// ---------- Apagar contato de vez (não é só cosmético — some da regra de privacidade também) ----------
app.post('/api/contacts/remove', (req, res) => {
  const { ownerId, contactId } = req.body;
  if (!ownerId || !contactId) return res.status(400).json({ error: 'Dados incompletos' });
  const db = loadDB();
  db.contacts = db.contacts.filter(c => !(c.ownerId === ownerId && c.contactId === contactId));
  saveDB(db);
  res.json({ ok: true });
});

// ---------- Perfil público resumido, com a foto já filtrada pra quem está pedindo ----------
// Usado pra atualizar a lista de "Nova conversa" com a foto sempre em dia (nunca confiar
// em foto guardada em cache local pra isso, ou a privacidade fica furada).
app.get('/api/users/:userId/public', (req, res) => {
  const { userId } = req.params;
  const { viewerId } = req.query;
  const db = loadDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json({
    id: user.id,
    username: user.username,
    bio: user.bio || '',
    photoUrl: fotoParaViewer(db, user, viewerId)
  });
});

// ---------- Ver a preferência de privacidade da foto (e a lista seleta, com nomes) ----------
app.get('/api/users/:userId/photo-privacy', (req, res) => {
  const { userId } = req.params;
  const db = loadDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  const allowList = (user.photoAllowList || []).map(id => {
    const u = db.users.find(x => x.id === id);
    return { id, username: u ? u.username : 'Usuário removido' };
  });
  res.json({ privacy: user.photoPrivacy || 'todos', allowList });
});

// ---------- Trocar a preferência de privacidade da foto ----------
app.post('/api/users/:userId/photo-privacy', (req, res) => {
  const { userId } = req.params;
  const { privacy } = req.body;
  const validas = ['todos', 'contatos', 'lista', 'ninguem'];
  if (!validas.includes(privacy)) return res.status(400).json({ error: 'Opção de privacidade inválida' });

  const db = loadDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  user.photoPrivacy = privacy;
  saveDB(db);
  res.json({ ok: true, privacy: user.photoPrivacy });
});

// ---------- Adicionar/remover alguém da lista seleta (só usado quando privacy === 'lista') ----------
app.post('/api/users/:userId/photo-privacy/lista', (req, res) => {
  const { userId } = req.params;
  const { query, remover } = req.body; // "query" = email/usuário pra adicionar; "remover" = id pra tirar
  const db = loadDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (!user.photoAllowList) user.photoAllowList = [];

  if (remover) {
    user.photoAllowList = user.photoAllowList.filter(id => id !== remover);
    saveDB(db);
    return res.json({ ok: true, allowList: user.photoAllowList });
  }

  if (!query) return res.status(400).json({ error: 'Informe o email ou usuário' });
  const alvo = findUserByEmailOrUsername(db, query);
  if (!alvo) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (alvo.id === userId) return res.status(400).json({ error: 'Você já vê sua própria foto sempre' });
  if (!user.photoAllowList.includes(alvo.id)) user.photoAllowList.push(alvo.id);
  saveDB(db);
  res.json({ ok: true, added: { id: alvo.id, username: alvo.username } });
});

// ---------- Estatísticas (usado na home) ----------
app.get('/api/stats', (req, res) => {
  const db = loadDB();

  // Quem criou mais conversas (privadas + grupos)
  const contagemPorCriador = {};
  db.chats.forEach(c => {
    if (c.type === 'private' && c.members.length === 2 && c.members[0] === c.members[1]) return; // conversa com você mesmo não conta
    const criador = c.createdBy || c.members[0];
    if (!criador) return;
    contagemPorCriador[criador] = (contagemPorCriador[criador] || 0) + 1;
  });
  const usuariosMaisAtivos = Object.entries(contagemPorCriador)
    .map(([userId, total]) => {
      const u = db.users.find(x => x.id === userId);
      return { username: u ? u.username : 'Usuário removido', total };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  // Grupo com mais mensagens
  const grupos = db.chats
    .filter(c => c.type === 'group')
    .map(c => ({
      nome: c.name,
      totalMensagens: db.messages.filter(m => m.chatId === c.id).length,
      totalMembros: c.members.length
    }))
    .sort((a, b) => b.totalMensagens - a.totalMensagens);

  res.json({
    usuariosMaisAtivos,
    grupoMaisAtivo: grupos[0] || null
  });
});

// ---------- Chats ----------
app.post('/api/chats/private', (req, res) => {
  const { userId, targetUserId } = req.body;
  const db = loadDB();

  const targetExiste = db.users.some(u => u.id === targetUserId);
  if (!targetExiste) return res.status(404).json({ error: 'Esse usuário não existe (ou a conta foi removida)' });

  const euBloqueiEle = db.blocks.some(b => b.userId === userId && b.blockedId === targetUserId);
  const eleMeBloqueou = db.blocks.some(b => b.userId === targetUserId && b.blockedId === userId);

  if (euBloqueiEle) {
    return res.status(403).json({ error: 'Você bloqueou esse usuário.', bloqueadoPorMim: true });
  }
  if (eleMeBloqueou) {
    return res.status(403).json({ error: 'Não é possível conversar com esse usuário' });
  }

  // busca a conversa privada certa. Quando é "conversa comigo mesmo" (userId === targetUserId),
  // não dá pra usar só "includes(userId) && includes(targetUserId)" — as duas condições ficam
  // idênticas e isso combinaria com QUALQUER conversa privada que você já tenha, com QUALQUER
  // pessoa (já que ela também "includes(userId)"). Por isso trata esse caso à parte, exigindo
  // que os dois membros sejam você mesmo.
  let chat = db.chats.find(c => {
    if (c.type !== 'private') return false;
    if (userId === targetUserId) {
      return c.members.length === 2 && c.members[0] === userId && c.members[1] === userId;
    }
    return c.members.includes(userId) && c.members.includes(targetUserId);
  });

  if (!chat) {
    chat = {
      id: uuidv4(),
      type: 'private',
      name: null,
      members: [userId, targetUserId],
      createdBy: userId,
      createdAt: Date.now()
    };
    db.chats.push(chat);
    saveDB(db);
  }

  res.json({ chat });
});

// alguém está bloqueado em relação ao criador/quem está adicionando (nos dois sentidos)?
function estaBloqueado(db, idA, idB) {
  return db.blocks.some(b =>
    (b.userId === idA && b.blockedId === idB) ||
    (b.userId === idB && b.blockedId === idA)
  );
}

app.post('/api/chats/group', (req, res) => {
  const { userId, name, memberQueries } = req.body;
  const db = loadDB();
  const criador = db.users.find(u => u.id === userId);
  const agora = Date.now();

  const chat = {
    id: uuidv4(),
    type: 'group',
    name: name || 'Grupo sem nome',
    description: '',
    photoUrl: null,
    members: [userId],
    memberJoinedAt: { [userId]: agora },
    admins: [],
    modoEnvio: 'todos',
    removedMembers: [],
    inviteCode: uuidv4(),
    approvalRequired: false,
    joinRequests: [],
    createdBy: userId,
    createdAt: agora
  };

  const naoEncontrados = [];
  const bloqueados = [];
  const avisos = [];
  const jaAdicionados = new Set([userId]);

  (memberQueries || []).forEach(q => {
    const u = findUserByEmailOrUsername(db, q);
    if (!u) { naoEncontrados.push(q); return; }
    if (jaAdicionados.has(u.id)) return;

    if (estaBloqueado(db, userId, u.id)) {
      bloqueados.push(u.username);
      return;
    }

    chat.members.push(u.id);
    marcarEntradaNoGrupo(chat, u.id, agora);
    jaAdicionados.add(u.id);
    avisos.push(criarMensagemSistema(
      chat.id,
      `${criador ? criador.username : 'Alguém'} adicionou ${u.username} ao grupo`,
      { kind: 'add_member', actorId: userId, targetId: u.id }
    ));
  });

  if (chat.members.length < 2) {
    return res.status(400).json({
      error: 'Adicione pelo menos uma pessoa pra criar o grupo.',
      naoEncontrados,
      bloqueados
    });
  }

  db.chats.push(chat);
  avisos.forEach(m => db.messages.push(m));
  saveDB(db);

  avisos.forEach(m => emitirMensagemSistemaPersonalizada(db, chat.members, m));
  res.json({ chat, naoEncontrados, bloqueados });
});

// apaga arquivos de mídia de um conjunto de mensagens (usado ao apagar/sair de uma conversa)
function apagarArquivosDoChat(db, chatId) {
  db.messages
    .filter(m => m.chatId === chatId && m.mediaUrl)
    .forEach(m => {
      const filePath = path.join(__dirname, m.mediaUrl);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
}

// ---------- Apagar conversa (PV ou grupo) ----------
app.post('/api/chats/:chatId/delete', (req, res) => {
  const { chatId } = req.params;
  const { userId } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat) return res.status(404).json({ error: 'Conversa não encontrada' });

  if (chat.members.includes(userId)) {
    // membro de verdade: apaga a conversa inteira, pra todo mundo (comportamento de sempre)
    apagarArquivosDoChat(db, chatId);
    db.messages = db.messages.filter(m => m.chatId !== chatId);
    db.chats = db.chats.filter(c => c.id !== chatId);
    saveDB(db);
    return res.json({ ok: true });
  }

  // não é mais membro: só pode ser alguém que foi removido do grupo.
  // "apagar" aqui é pessoal — só some da lista dela, o grupo e as mensagens
  // continuam existindo normalmente pra quem ainda tá dentro.
  const eraMembro = (chat.removedMembers || []).some(r => r.userId === userId);
  if (!eraMembro) return res.status(404).json({ error: 'Conversa não encontrada' });

  chat.removedMembers = chat.removedMembers.filter(r => r.userId !== userId);
  saveDB(db);
  res.json({ ok: true });
});

// ---------- Sair de um grupo ----------
app.post('/api/chats/:chatId/leave', (req, res) => {
  const { chatId } = req.params;
  const { userId } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || chat.type !== 'group') {
    return res.status(404).json({ error: 'Grupo não encontrado' });
  }
  if (!chat.members.includes(userId)) {
    return res.status(400).json({ error: 'Você não está nesse grupo' });
  }

  const quemSaiu = db.users.find(u => u.id === userId);
  const msg = criarMensagemSistema(
    chatId,
    `${quemSaiu ? quemSaiu.username : 'Alguém'} saiu do grupo`,
    { kind: 'leave_group', actorId: userId, targetId: userId }
  );

  // quem ainda vai ficar no grupo + quem tá saindo (pra ele ver a própria msg de saída antes de virar fantasma)
  const destinatarios = chat.members.slice();

  chat.members = chat.members.filter(m => m !== userId);
  if (chat.admins) chat.admins = chat.admins.filter(a => a !== userId);

  // mesma regra de quando é removido: continua vendo o histórico até agora
  // (modo fantasma), só não recebe mensagem nova nem consegue mandar
  if (!chat.removedMembers) chat.removedMembers = [];
  chat.removedMembers = chat.removedMembers.filter(r => r.userId !== userId);
  chat.removedMembers.push({ userId, removedAt: Date.now() });

  db.messages.push(msg);

  if (chat.members.length === 0) {
    apagarArquivosDoChat(db, chatId);
    db.messages = db.messages.filter(m => m.chatId !== chatId);
    db.chats = db.chats.filter(c => c.id !== chatId);
  }

  saveDB(db);
  emitirMensagemSistemaPersonalizada(db, destinatarios, msg);
  res.json({ ok: true });
});

// ---------- Membros do grupo (dono, admins, membros comuns) ----------
app.get('/api/chats/:chatId/members', (req, res) => {
  const { chatId } = req.params;
  const { userId } = req.query;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || chat.type !== 'group' || !chat.members.includes(userId)) {
    return res.status(404).json({ error: 'Grupo não encontrado' });
  }
  const admins = chat.admins || [];
  const membros = chat.members.map(id => {
    const u = db.users.find(x => x.id === id);
    return {
      id,
      username: u ? u.username : 'Usuário removido',
      email: u ? u.email : null,
      photoUrl: u ? fotoParaViewer(db, u, userId) : null,
      isOwner: id === chat.createdBy,
      isAdmin: admins.includes(id)
    };
  });
  const criador = db.users.find(u => u.id === chat.createdBy);
  // filtro extra de segurança: nunca mostra na lista de "Saíram" alguém que
  // já voltou e está em chat.members de novo (mesmo que sobre algum registro antigo)
  const saidos = (chat.removedMembers || [])
    .filter(r => !chat.members.includes(r.userId))
    .slice()
    .sort((a, b) => b.removedAt - a.removedAt)
    .map(r => {
      const u = db.users.find(x => x.id === r.userId);
      return {
        id: r.userId,
        username: u ? u.username : 'Usuário removido',
        photoUrl: u ? fotoParaViewer(db, u, userId) : null,
        saiuEm: r.removedAt
      };
    });
  res.json({
    membros,
    saidos,
    name: chat.name,
    photoUrl: chat.photoUrl || null,
    description: chat.description || '',
    criadoPor: criador ? criador.username : 'Usuário removido',
    criadoEm: chat.createdAt,
    modoEnvio: chat.modoEnvio || 'todos',
    souDono: souDono(chat, userId),
    souAdmin: souAdminDoGrupo(chat, userId)
  });
});

// ---------- Adicionar pessoas a um grupo já existente (dono ou admins podem) ----------
app.post('/api/chats/:chatId/add-members', (req, res) => {
  const { chatId } = req.params;
  const { userId, memberQueries } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!souAdminDoGrupo(chat, userId)) return res.status(403).json({ error: 'Só o dono ou admins podem adicionar pessoas' });

  const ator = db.users.find(u => u.id === userId);
  const naoEncontrados = [];
  const bloqueados = [];
  const jaNoGrupo = [];
  const avisos = [];

  (memberQueries || []).forEach(q => {
    const u = findUserByEmailOrUsername(db, q);
    if (!u) { naoEncontrados.push(q); return; }
    if (chat.members.includes(u.id)) { jaNoGrupo.push(u.username); return; }
    if (estaBloqueado(db, userId, u.id)) { bloqueados.push(u.username); return; }

    chat.members.push(u.id);
    marcarEntradaNoGrupo(chat, u.id);
    avisos.push(criarMensagemSistema(
      chatId,
      `${ator ? ator.username : 'Alguém'} adicionou ${u.username} ao grupo`,
      { kind: 'add_member', actorId: userId, targetId: u.id }
    ));
  });

  if (!avisos.length) {
    return res.status(400).json({
      error: 'Ninguém foi adicionado.',
      naoEncontrados,
      bloqueados,
      jaNoGrupo
    });
  }

  avisos.forEach(m => db.messages.push(m));
  saveDB(db);
  avisos.forEach(m => emitirMensagemSistemaPersonalizada(db, chat.members, m));

  res.json({ ok: true, naoEncontrados, bloqueados, jaNoGrupo });
});

// ---------- Convite por link (igual WhatsApp: link + opção de exigir aprovação) ----------

// ver o link (código) atual e os pedidos pendentes — só admin/dono
app.get('/api/chats/:chatId/invite', (req, res) => {
  const { chatId } = req.params;
  const { userId } = req.query;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!souAdminDoGrupo(chat, userId)) return res.status(403).json({ error: 'Só o dono ou admins podem ver o link de convite' });

  const pedidos = (chat.joinRequests || []).map(r => {
    const u = db.users.find(x => x.id === r.userId);
    return {
      userId: r.userId,
      username: u ? u.username : 'Usuário removido',
      photoUrl: u ? fotoParaViewer(db, u, userId) : null,
      requestedAt: r.requestedAt
    };
  });

  res.json({
    code: chat.inviteCode,
    approvalRequired: !!chat.approvalRequired,
    joinRequests: pedidos
  });
});

// gerar um link novo, invalidando o antigo — só admin/dono
app.post('/api/chats/:chatId/invite/reset', (req, res) => {
  const { chatId } = req.params;
  const { userId } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!souAdminDoGrupo(chat, userId)) return res.status(403).json({ error: 'Só o dono ou admins podem redefinir o link' });

  chat.inviteCode = uuidv4();
  saveDB(db);
  res.json({ code: chat.inviteCode });
});

// ligar/desligar a exigência de aprovação pra entrar pelo link — só admin/dono
app.post('/api/chats/:chatId/invite/approval', (req, res) => {
  const { chatId } = req.params;
  const { userId, ativo } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!souAdminDoGrupo(chat, userId)) return res.status(403).json({ error: 'Só o dono ou admins podem mudar isso' });

  chat.approvalRequired = !!ativo;
  saveDB(db);
  res.json({ ok: true, approvalRequired: chat.approvalRequired });
});

// entrar num grupo usando o código do link — qualquer usuário logado
// ---------- Só consulta o link de convite, sem entrar nem mandar pedido (usado pra mostrar a confirmação antes) ----------
app.get('/api/invite/:code/info', (req, res) => {
  const { code } = req.params;
  const { userId } = req.query;
  const db = loadDB();
  const chat = db.chats.find(c => c.type === 'group' && c.inviteCode === code);
  if (!chat) return res.status(404).json({ error: 'Link inválido ou expirado' });

  res.json({
    ok: true,
    chatId: chat.id,
    chatName: chat.name,
    approvalRequired: !!chat.approvalRequired,
    jaEstava: chat.members.includes(userId),
    jaPendente: (chat.joinRequests || []).some(r => r.userId === userId),
    bloqueado: estaBloqueado(db, userId, chat.createdBy)
  });
});

app.post('/api/invite/:code/join', (req, res) => {
  const { code } = req.params;
  const { userId } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.type === 'group' && c.inviteCode === code);
  if (!chat) return res.status(404).json({ error: 'Link inválido ou expirado' });

  if (chat.members.includes(userId)) {
    return res.json({ ok: true, jaEstava: true, chat: { id: chat.id, name: chat.name, type: chat.type } });
  }
  if (estaBloqueado(db, userId, chat.createdBy)) {
    return res.status(403).json({ error: 'Não foi possível entrar nesse grupo' });
  }
  if ((chat.joinRequests || []).some(r => r.userId === userId)) {
    return res.json({ ok: true, pendente: true });
  }

  if (chat.approvalRequired) {
    if (!chat.joinRequests) chat.joinRequests = [];
    chat.joinRequests.push({ userId, requestedAt: Date.now() });
    saveDB(db);

    const solicitante = db.users.find(u => u.id === userId);
    const admins = chat.admins.includes(chat.createdBy) ? chat.admins : [chat.createdBy, ...chat.admins];
    admins.forEach(adminId => {
      io.to('user:' + adminId).emit('solicitacao_entrada', {
        chatId: chat.id,
        chatName: chat.name,
        username: solicitante ? solicitante.username : 'Alguém'
      });
    });
    return res.json({ ok: true, pendente: true });
  }

  chat.members.push(userId);
  marcarEntradaNoGrupo(chat, userId);
  const msg = criarMensagemSistema(
    chat.id,
    `${db.users.find(u => u.id === userId)?.username || 'Alguém'} entrou no grupo pelo link de convite`,
    { kind: 'join_link', actorId: userId, targetId: userId }
  );
  db.messages.push(msg);
  saveDB(db);
  emitirMensagemSistemaPersonalizada(db, chat.members, msg);

  res.json({ ok: true, chat: { id: chat.id, name: chat.name, type: chat.type } });
});

// o próprio solicitante desiste do pedido de entrada (não precisa ser admin, só é dono do próprio pedido)
app.post('/api/invite/:code/cancelar', (req, res) => {
  const { code } = req.params;
  const { userId } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.type === 'group' && c.inviteCode === code);
  if (!chat) return res.status(404).json({ error: 'Link inválido ou expirado' });

  chat.joinRequests = (chat.joinRequests || []).filter(r => r.userId !== userId);
  saveDB(db);
  res.json({ ok: true });
});

// aprovar ou recusar um pedido de entrada — só admin/dono
app.post('/api/chats/:chatId/invite/responder', (req, res) => {
  const { chatId } = req.params;
  const { userId, targetUserId, aprovar } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!souAdminDoGrupo(chat, userId)) return res.status(403).json({ error: 'Só o dono ou admins podem responder pedidos' });

  const havia = (chat.joinRequests || []).some(r => r.userId === targetUserId);
  chat.joinRequests = (chat.joinRequests || []).filter(r => r.userId !== targetUserId);
  if (!havia) { saveDB(db); return res.json({ ok: true }); }

  if (!aprovar) {
    saveDB(db);
    io.to('user:' + targetUserId).emit('solicitacao_recusada', { chatName: chat.name });
    return res.json({ ok: true });
  }

  chat.members.push(targetUserId);
  marcarEntradaNoGrupo(chat, targetUserId);
  const msg = criarMensagemSistema(
    chatId,
    `${db.users.find(u => u.id === targetUserId)?.username || 'Alguém'} entrou no grupo pelo link de convite`,
    { kind: 'join_link', actorId: targetUserId, targetId: targetUserId }
  );
  db.messages.push(msg);
  saveDB(db);
  emitirMensagemSistemaPersonalizada(db, chat.members, msg);
  res.json({ ok: true });
});

// ---------- Editar o nome do grupo (dono ou admins podem) ----------
app.post('/api/chats/:chatId/rename', (req, res) => {
  const { chatId } = req.params;
  const { userId, name } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!souAdminDoGrupo(chat, userId)) return res.status(403).json({ error: 'Só o dono ou admins podem mudar o nome do grupo' });

  const novoNome = (name || '').trim();
  if (!novoNome) return res.status(400).json({ error: 'O nome não pode ficar vazio' });
  if (novoNome === chat.name) return res.json({ ok: true, name: chat.name });

  chat.name = novoNome;
  const msg = criarMensagemSistema(
    chatId,
    `${db.users.find(u => u.id === userId)?.username || 'Alguém'} mudou o nome do grupo para "${novoNome}"`,
    { kind: 'rename', actorId: userId, novoNome }
  );
  db.messages.push(msg);
  saveDB(db);
  emitirMensagemSistemaPersonalizada(db, chat.members, msg);
  res.json({ ok: true, name: chat.name });
});

// ---------- Editar a descrição do grupo (dono ou admins podem) ----------
app.post('/api/chats/:chatId/description', (req, res) => {
  const { chatId } = req.params;
  const { userId, description } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!souAdminDoGrupo(chat, userId)) return res.status(403).json({ error: 'Só o dono ou admins podem mudar a descrição do grupo' });

  const novaDescricao = (description || '').trim().slice(0, 300);
  if (novaDescricao === (chat.description || '')) return res.json({ ok: true, description: chat.description || '' });

  chat.description = novaDescricao;
  const msg = criarMensagemSistema(
    chatId,
    `${db.users.find(u => u.id === userId)?.username || 'Alguém'} mudou a descrição do grupo`,
    { kind: 'description', actorId: userId }
  );
  db.messages.push(msg);
  saveDB(db);
  emitirMensagemSistemaPersonalizada(db, chat.members, msg);
  res.json({ ok: true, description: chat.description });
});

// ---------- Trocar ou remover a foto do grupo (dono ou admins podem) ----------
app.post('/api/chats/:chatId/photo', (req, res) => {
  const { chatId } = req.params;
  const { userId, photoUrl } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!souAdminDoGrupo(chat, userId)) return res.status(403).json({ error: 'Só o dono ou admins podem mudar a foto do grupo' });

  chat.photoUrl = photoUrl || null;
  const nomeAtor = db.users.find(u => u.id === userId)?.username || 'Alguém';
  const removida = !chat.photoUrl;
  const msg = criarMensagemSistema(
    chatId,
    removida ? `${nomeAtor} removeu a foto do grupo` : `${nomeAtor} mudou a foto do grupo`,
    { kind: 'photo', actorId: userId, removida }
  );
  db.messages.push(msg);
  saveDB(db);
  emitirMensagemSistemaPersonalizada(db, chat.members, msg);
  res.json({ ok: true, photoUrl: chat.photoUrl });
});

// ---------- Quem pode mandar mensagem no grupo: todos / só admins / só o dono ----------
// "dono" é a trava mais forte: nem os admins conseguem mandar mensagem, só quem criou o grupo.
// Por isso só o próprio dono pode ativar (ou desativar) essa opção.
app.post('/api/chats/:chatId/modo-envio', (req, res) => {
  const { chatId } = req.params;
  const { userId, modo } = req.body;
  const validos = ['todos', 'admins', 'dono'];
  if (!validos.includes(modo)) return res.status(400).json({ error: 'Opção inválida' });

  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Grupo não encontrado' });

  const modoAtual = chat.modoEnvio || 'todos';
  // enquanto o modo "só o dono" tiver ativo, só o dono pode mexer nisso de novo —
  // senão um admin poderia simplesmente reabrir e a trava não serviria pra nada
  if (modoAtual === 'dono' && !souDono(chat, userId)) {
    return res.status(403).json({ error: 'Só o dono pode mudar essa configuração agora' });
  }
  if (modo === 'dono') {
    if (!souDono(chat, userId)) return res.status(403).json({ error: 'Só o dono do grupo pode ativar essa opção' });
  } else if (!souAdminDoGrupo(chat, userId)) {
    return res.status(403).json({ error: 'Só o dono ou admins podem mudar isso' });
  }

  if (modo === modoAtual) return res.json({ ok: true, modoEnvio: modo });

  chat.modoEnvio = modo;
  const msg = criarMensagemSistema(
    chatId,
    'Configuração de envio do grupo foi alterada',
    { kind: 'modo_envio', actorId: userId, modo }
  );
  db.messages.push(msg);
  saveDB(db);
  emitirMensagemSistemaPersonalizada(db, chat.members, msg);
  io.to('chat:' + chatId).emit('modo_envio_alterado', { chatId, modoEnvio: modo });

  res.json({ ok: true, modoEnvio: modo });
});

// ---------- Dar admin (só o dono do grupo pode) ----------
app.post('/api/chats/:chatId/promote', (req, res) => {
  const { chatId } = req.params;
  const { userId, targetUserId } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!souDono(chat, userId)) return res.status(403).json({ error: 'Só o dono do grupo pode dar admin' });
  if (!chat.members.includes(targetUserId)) return res.status(400).json({ error: 'Essa pessoa não está no grupo' });

  if (!chat.admins) chat.admins = [];
  if (!chat.admins.includes(targetUserId)) {
    chat.admins.push(targetUserId);
    const alvo = db.users.find(u => u.id === targetUserId);
    const msg = criarMensagemSistema(
      chat.id,
      `${alvo ? alvo.username : 'Alguém'} agora é admin do grupo`,
      { kind: 'promote', actorId: userId, targetId: targetUserId }
    );
    db.messages.push(msg);
    saveDB(db);
    emitirMensagemSistemaPersonalizada(db, chat.members, msg);
  } else {
    saveDB(db);
  }
  res.json({ ok: true });
});

// ---------- Remover pessoa do grupo (dono ou admins podem) ----------
app.post('/api/chats/:chatId/remove-member', (req, res) => {
  const { chatId } = req.params;
  const { userId, targetUserId } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!souAdminDoGrupo(chat, userId)) return res.status(403).json({ error: 'Só o dono ou admins podem remover pessoas' });
  if (targetUserId === chat.createdBy) return res.status(403).json({ error: 'Não é possível remover o dono do grupo' });
  if (!chat.members.includes(targetUserId)) return res.status(400).json({ error: 'Essa pessoa não está no grupo' });

  const alvo = db.users.find(u => u.id === targetUserId);
  const msg = criarMensagemSistema(
    chatId,
    `${alvo ? alvo.username : 'Alguém'} foi removido do grupo`,
    { kind: 'remove_member', actorId: userId, targetId: targetUserId }
  );

  // quem ainda vai ficar no grupo depois da remoção (pra emitir pra eles) +
  // o próprio removido (pra ele ver "Você foi removido do grupo" antes de sair da tela)
  const destinatarios = chat.members.slice();

  chat.members = chat.members.filter(m => m !== targetUserId);
  if (chat.admins) chat.admins = chat.admins.filter(a => a !== targetUserId);

  // guarda o registro de remoção: a pessoa não é mais membro, mas continua
  // enxergando o histórico até esse momento (só não recebe mensagem nova
  // nem consegue mandar). Isso fica pra sempre, até ela mesma apagar a conversa.
  if (!chat.removedMembers) chat.removedMembers = [];
  chat.removedMembers = chat.removedMembers.filter(r => r.userId !== targetUserId);
  chat.removedMembers.push({ userId: targetUserId, removedAt: Date.now() });

  db.messages.push(msg);

  if (chat.members.length === 0) {
    apagarArquivosDoChat(db, chatId);
    db.messages = db.messages.filter(m => m.chatId !== chatId);
    db.chats = db.chats.filter(c => c.id !== chatId);
  }

  saveDB(db);
  emitirMensagemSistemaPersonalizada(db, destinatarios, msg);
  io.to('user:' + targetUserId).emit('removido_do_grupo', { chatId });
  res.json({ ok: true });
});

// ---------- Bloquear usuário ----------
app.post('/api/block', (req, res) => {
  const { userId, blockedId } = req.body;
  if (!userId || !blockedId) return res.status(400).json({ error: 'Dados incompletos' });
  const db = loadDB();
  const jaBloqueado = db.blocks.some(b => b.userId === userId && b.blockedId === blockedId);
  if (!jaBloqueado) {
    db.blocks.push({ userId, blockedId, createdAt: Date.now() });
    saveDB(db);
  }
  res.json({ ok: true });
});

// ---------- Desbloquear usuário ----------
app.post('/api/unblock', (req, res) => {
  const { userId, blockedId } = req.body;
  if (!userId || !blockedId) return res.status(400).json({ error: 'Dados incompletos' });
  const db = loadDB();
  db.blocks = db.blocks.filter(b => !(b.userId === userId && b.blockedId === blockedId));
  saveDB(db);
  res.json({ ok: true });
});

// ---------- Listar quem eu bloqueei ----------
app.get('/api/blocks', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Informe o userId' });
  const db = loadDB();
  const bloqueados = db.blocks
    .filter(b => b.userId === userId)
    .map(b => {
      const u = db.users.find(x => x.id === b.blockedId);
      return { id: b.blockedId, username: u ? u.username : 'Usuário removido' };
    });
  res.json({ bloqueados });
});

app.get('/api/chats', (req, res) => {
  const { userId } = req.query;
  const db = loadDB();

  const chats = db.chats.filter(c => {
    if (c.members.includes(userId)) return true;
    // grupo do qual a pessoa foi removida: continua na lista, em modo fantasma
    return (c.removedMembers || []).some(r => r.userId === userId);
  });

  const resultado = chats.map(c => {
    let displayName = c.name;
    let displayPhoto = c.type === 'group' ? (c.photoUrl || null) : null;
    let otherUserId = null;
    let otherEmail = null;
    let ehAutoConversa = false;

    const souMembro = c.members.includes(userId);
    const registroRemocao = !souMembro
      ? (c.removedMembers || []).find(r => r.userId === userId)
      : null;
    const removidoDoGrupo = !!registroRemocao;

    if (c.type === 'private') {
      ehAutoConversa = c.members.every(m => m === userId);
      if (ehAutoConversa) {
        displayName = '(você)';
        otherUserId = userId;
        const eu = db.users.find(u => u.id === userId);
        otherEmail = eu ? eu.email : null;
        displayPhoto = eu ? (eu.photoUrl || null) : null;
      } else {
        otherUserId = c.members.find(m => m !== userId);
        const other = db.users.find(u => u.id === otherUserId);
        displayName = other ? other.username : 'Usuário removido';
        otherEmail = other ? other.email : null;
        displayPhoto = other ? fotoParaViewer(db, other, userId) : null;
      }
    }

    // em modo fantasma, só enxerga (e só conta) mensagens de até o momento da remoção
    const jaEntrouEm = c.type === 'group' ? ((c.memberJoinedAt && c.memberJoinedAt[userId]) || 0) : 0;
    const msgsDoChat = db.messages.filter(m =>
      m.chatId === c.id
      && (!removidoDoGrupo || m.createdAt <= registroRemocao.removedAt)
      && m.createdAt >= jaEntrouEm
    );
    const ultima = msgsDoChat[msgsDoChat.length - 1];

    const ultimaLeitura = db.reads[userId + '|' + c.id] || 0;
    const unreadCount = removidoDoGrupo ? 0 : msgsDoChat.filter(
      m => m.createdAt > ultimaLeitura && m.senderId !== userId
    ).length;

    return {
      id: c.id,
      type: c.type,
      name: displayName,
      photoUrl: displayPhoto,
      otherUserId,
      otherEmail,
      ehAutoConversa,
      removidoDoGrupo,
      lastMessage: ultima ? (ultima.deleted ? 'Mensagem apagada' : ultima.content) : null,
      unreadCount
    };
  });

  res.json({ chats: resultado });
});

// ---------- Marcar conversa como lida ----------
app.post('/api/chats/:chatId/read', (req, res) => {
  const { chatId } = req.params;
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Dados incompletos' });
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || !chat.members.includes(userId)) {
    return res.status(404).json({ error: 'Conversa não encontrada' });
  }
  db.reads[userId + '|' + chatId] = Date.now();
  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/chats/:chatId/messages', (req, res) => {
  const { chatId } = req.params;
  const { userId } = req.query;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat) return res.status(403).json({ error: 'Sem acesso a esse chat' });

  const souMembro = chat.members.includes(userId);
  const registroRemocao = !souMembro
    ? (chat.removedMembers || []).find(r => r.userId === userId)
    : null;
  if (!souMembro && !registroRemocao) {
    return res.status(403).json({ error: 'Sem acesso a esse chat' });
  }

  const mensagens = db.messages
    .filter(m => {
      if (m.chatId !== chatId) return false;
      if (!souMembro && m.createdAt > registroRemocao.removedAt) return false;
      // quem entrou no grupo depois não vê mensagens de antes de ter entrado
      const jaEntrouEm = chat.type === 'group' ? ((chat.memberJoinedAt && chat.memberJoinedAt[userId]) || 0) : 0;
      return m.createdAt >= jaEntrouEm;
    })
    .map(m => personalizarMensagem(m, userId, db))
    .map(m => {
      if (!m.senderId) return m;
      const remetente = db.users.find(u => u.id === m.senderId);
      return Object.assign({}, m, {
        senderUsername: remetente ? remetente.username : 'Usuário removido',
        senderPhotoUrl: remetente ? fotoParaViewer(db, remetente, userId) : null,
        senderSaiuDoGrupo: chat.type === 'group' && !chat.members.includes(m.senderId)
      });
    });
  res.json({ messages: mensagens });
});

// ---------- Socket.io (tempo real) ----------
io.on('connection', socket => {
  socket.on('join', ({ userId }) => {
    socket.userId = userId;
    socket.join('user:' + userId);
  });

  socket.on('join_chat', chatId => {
    // quem foi removido do grupo pode continuar lendo o histórico (via REST),
    // mas não deve receber mensagem nova em tempo real — então nem entra nessa room.
    const db = loadDB();
    const chat = db.chats.find(c => c.id === chatId);
    if (!chat || !socket.userId || !chat.members.includes(socket.userId)) return;
    socket.join('chat:' + chatId);
  });

  socket.on('send_message', ({ chatId, userId, type, content, replyTo, mediaUrl }) => {
    const db = loadDB();
    const chat = db.chats.find(c => c.id === chatId);
    if (!chat || !chat.members.includes(userId)) return;
    if (!podeEnviarMensagem(chat, userId)) return;

    if (chat.type === 'private') {
      const outro = chat.members.find(m => m !== userId);
      const bloqueado = db.blocks.some(b =>
        (b.userId === userId && b.blockedId === outro) ||
        (b.userId === outro && b.blockedId === userId)
      );
      if (bloqueado) return;
    }

    const message = {
      id: uuidv4(),
      chatId,
      senderId: userId,
      type: type || 'text', // 'text' | 'audio' | 'video'
      content: content || null,
      mediaUrl: mediaUrl || null,
      mediaCreatedAt: mediaUrl ? Date.now() : null,
      replyTo: replyTo || null,
      createdAt: Date.now(),
      editedAt: null,
      deleted: false
    };
    db.messages.push(message);
    saveDB(db);

    const remetente = db.users.find(u => u.id === userId);
    chat.members.forEach(memberId => {
      io.to('user:' + memberId).emit('new_message', Object.assign({}, message, {
        senderUsername: remetente ? remetente.username : 'Usuário removido',
        senderPhotoUrl: remetente ? fotoParaViewer(db, remetente, memberId) : null
      }));
    });
  });

  socket.on('edit_message', ({ messageId, userId, newContent }) => {
    const db = loadDB();
    const msg = db.messages.find(m => m.id === messageId);
    if (!msg || msg.senderId !== userId || msg.deleted) return;
    if (Date.now() - msg.createdAt > LIMITE_EDICAO_MS) return; // passou de 1 min

    msg.content = newContent;
    msg.editedAt = Date.now();
    saveDB(db);

    io.to('chat:' + msg.chatId).emit('message_edited', msg);
  });

  socket.on('delete_message', ({ messageId, userId }) => {
    const db = loadDB();
    const msg = db.messages.find(m => m.id === messageId);
    if (!msg || msg.senderId !== userId) return;

    if (msg.mediaUrl) {
      const filePath = path.join(__dirname, msg.mediaUrl);
      fs.unlink(filePath, () => {});
    }

    msg.deleted = true;
    msg.content = null;
    msg.mediaUrl = null;
    saveDB(db);

    io.to('chat:' + msg.chatId).emit('message_deleted', { id: msg.id });
  });
});

// ---------- Limpeza automática de mídia com mais de 12h ----------
async function limparMidiaAntiga() {
  const db = loadDB();
  if (!db) return;
  let mudou = false;
  for (const m of db.messages) {
    if (m.mediaUrl && m.mediaCreatedAt && Date.now() - m.mediaCreatedAt > VIDA_MIDIA_MS) {
      try {
        const partes = m.mediaUrl.split('/');
        const publicId = 'chatdevs/' + partes[partes.length - 1].split('.')[0];
        await cloudinary.uploader.destroy(publicId, { resource_type: 'auto' });
      } catch(e) {}
      m.mediaUrl = null;
      m.mediaExpired = true;
      mudou = true;
    }
  }
  if (mudou) saveDB(db);
}
setInterval(limparMidiaAntiga, 30 * 60 * 1000);

// ---------- Inicia o servidor só depois de conectar no Mongo ----------
init().then(() => {
  server.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
}).catch(e => {
  console.error('[db] falha ao conectar:', e);
  process.exit(1);
});
