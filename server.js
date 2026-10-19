const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { init, loadDB, saveDB } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_CONTAS_POR_IP = 3;
const LIMITE_EDICAO_MS = 60 * 1000; // 1 minuto
const VIDA_MIDIA_MS = 12 * 60 * 60 * 1000; // 12 horas

app.use(express.json());

// ---------- Painel admin (arquivo estático protegido) ----------
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.use(express.static(path.join(__dirname, 'public')));
// ---------- Upload de mídia (áudio/vídeo/imagem) ----------
// Os arquivos ficam no MongoDB (GridFS), NÃO no disco. No Railway o disco é apagado a cada
// deploy/reinício — por isso as fotos davam 404. No banco elas sobrevivem a tudo.
const mongoose = require('mongoose');
let bucket = null;
function getBucket() {
  if (!bucket) bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'midia' });
  return bucket;
}
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file || !req.file.buffer || !req.file.size) {
    return res.status(400).json({ error: 'O arquivo não foi recebido corretamente.' });
  }
  const filename = uuidv4() + (path.extname(req.file.originalname || '') || '');
  const mimeType = req.file.mimetype || 'application/octet-stream';
  const stream = getBucket().openUploadStream(filename, { metadata: { mimeType } });
  stream.on('error', e => {
    console.error('[upload] erro ao salvar:', e.message);
    res.status(500).json({ error: 'Não foi possível salvar o arquivo.' });
  });
  stream.on('finish', () => {
    res.status(201).json({
      url: '/uploads/' + filename,
      filename,
      size: req.file.size,
      mimeType
    });
  });
  stream.end(req.file.buffer);
});

// serve o arquivo (com suporte a Range, que o Safari/iPhone exige pra tocar áudio e vídeo)
app.get('/uploads/:filename', async (req, res) => {
  try {
    const arquivos = await getBucket().find({ filename: req.params.filename }).limit(1).toArray();
    if (!arquivos.length) return res.status(404).end();
    const f = arquivos[0];
    const total = f.length;
    const tipo = (f.metadata && f.metadata.mimeType) || 'application/octet-stream';
    res.set({ 'Content-Type': tipo, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' });

    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range && total > 0) {
      let ini = range[1] === '' ? total - parseInt(range[2], 10) : parseInt(range[1], 10);
      let fim = range[1] === '' || range[2] === '' ? total - 1 : parseInt(range[2], 10);
      if (isNaN(ini) || isNaN(fim) || ini < 0) ini = 0;
      if (fim >= total) fim = total - 1;
      if (ini > fim) return res.status(416).set('Content-Range', `bytes */${total}`).end();
      res.status(206).set({ 'Content-Range': `bytes ${ini}-${fim}/${total}`, 'Content-Length': fim - ini + 1 });
      return getBucket().openDownloadStream(f._id, { start: ini, end: fim + 1 }).pipe(res);
    }
    res.set('Content-Length', total);
    getBucket().openDownloadStream(f._id).on('error', () => res.end()).pipe(res);
  } catch (e) {
    console.error('[uploads] erro:', e.message);
    res.status(500).end();
  }
});

// apaga um arquivo de mídia a partir da URL ('/uploads/xxx.jpg')
function apagarArquivo(mediaUrl) {
  if (!mediaUrl || typeof mediaUrl !== 'string' || !mediaUrl.startsWith('/uploads/')) return;
  const nome = mediaUrl.slice('/uploads/'.length);
  getBucket().find({ filename: nome }).toArray()
    .then(fs_ => Promise.all(fs_.map(f => getBucket().delete(f._id))))
    .catch(() => {});
}

// ---------- Helpers ----------
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress;
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, email: u.email, contactNumber: u.contactNumber || null, photoUrl: u.photoUrl || null,
    bio: u.bio || '', phone: u.phone || '', ringColor: u.ringColor || '#ffb454',
    socials: Array.isArray(u.socials) ? u.socials : []
  };
}

const SOCIALS_PERMITIDAS = new Set(['instagram', 'tiktok', 'youtube', 'facebook', 'x']);
function normalizarSocials(socials) {
  if (!Array.isArray(socials)) return [];
  return socials.slice(0, 5).map(item => {
    const network = String(item && item.network || '').toLowerCase();
    const handle = String(item && item.handle || '').trim().replace(/^@+/, '').slice(0, 100);
    if (!SOCIALS_PERMITIDAS.has(network) || !handle) return null;
    return { network, handle };
  }).filter(Boolean);
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

// dono ATUAL do grupo. createdBy continua sendo só "quem criou" (aparece na descrição).
// Quando o dono sai, ownerId vira null; se ele voltar depois, volta como membro comum.
function donoDe(chat) {
  return chat.ownerId !== undefined ? chat.ownerId : chat.createdBy;
}
function souDono(chat, userId) {
  return !!userId && donoDe(chat) === userId;
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

// ---------- Autenticação: email verificado + Google ----------
function novoNumeroContato(db) {
  let n;
  do { n = String(Math.floor(1000000 + Math.random() * 9000000)); }
  while (db.users.some(u => u.contactNumber === n) || Object.values(db.pendingVerifications || {}).some(u => u.contactNumber === n));
  return n;
}
function codigoHash(email, code) { return crypto.createHash('sha256').update(`${email.toLowerCase()}:${code}:${process.env.AUTH_CODE_SECRET || 'configure-um-segredo-no-railway'}`).digest('hex'); }
async function enviarEmailVerificacao(email, code, token, req) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) throw new Error('Email não configurado. Configure RESEND_API_KEY e EMAIL_FROM no Railway.');
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const link = `${base}/api/verify-email?token=${encodeURIComponent(token)}`;
  const html = `<!doctype html><html><head><style>@keyframes cdPulse{0%,100%{transform:scale(1);box-shadow:0 0 0 rgba(199,243,107,0)}50%{transform:scale(1.025);box-shadow:0 0 24px rgba(199,243,107,.16)}}.cd-pulse{animation:cdPulse 2.8s ease-in-out infinite}</style></head><body style="margin:0;background:#0b0d12;color:#f5f6f8;font-family:Arial,sans-serif;padding:28px 12px"><div style="max-width:560px;margin:auto;background:linear-gradient(145deg,#171b24,#101218);border:1px solid #2b303b;border-radius:24px;overflow:hidden"><div style="height:5px;background:linear-gradient(90deg,#c7f36b,#72e4bd,#a6a1ff)"></div><div style="padding:34px 30px"><div style="font-size:13px;letter-spacing:3px;color:#c7f36b;font-weight:bold">✳ CHATDEVS</div><h1 style="font-size:30px;line-height:1.15;margin:24px 0 12px">Só falta confirmar<br>seu email<span style="color:#c7f36b">.</span></h1><p style="color:#b7bdc9;line-height:1.7">Use o código abaixo para ativar sua conta. Ele expira em 15 minutos.</p><div class="cd-pulse" style="letter-spacing:12px;font-size:34px;font-weight:800;background:#0b0d12;border:1px solid #343b47;border-radius:16px;padding:22px 10px;text-align:center;margin:24px 0;color:#c7f36b">${code}</div><p style="text-align:center;color:#aeb5c3;font-size:13px">Ou confirme com um toque:</p><div style="text-align:center;margin:20px 0 28px"><a href="${link}" style="display:inline-block;background:#c7f36b;color:#11150b;text-decoration:none;font-weight:800;padding:16px 24px;border-radius:12px">Verificar meu email →</a></div><div style="border-top:1px solid #2b303b;padding-top:18px;color:#818a9b;font-size:12px;line-height:1.6">Se você não criou uma conta no ChatDevs, ignore esta mensagem. Não compartilhe este código com ninguém.</div></div></div></body></html>`;
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [email], subject: 'Seu código de verificação — ChatDevs', html, text: `Seu código ChatDevs é ${code}. Expira em 15 minutos. Verifique também por este link: ${link}` }) });
  if (!response.ok) { const detail = await response.text(); console.error('[email] Resend:', detail); throw new Error('Não foi possível enviar o email. Confira o domínio e as credenciais de email.'); }
}
function finalizarCadastroPendente(db, pending) {
  const user = { id: uuidv4(), username: pending.username, email: pending.email, passwordHash: pending.passwordHash || null, contactNumber: pending.contactNumber || novoNumeroContato(db), createdIp: pending.createdIp || '', createdAt: Date.now(), emailVerified: true, authProvider: pending.authProvider || 'email' };
  db.users.push(user); delete db.pendingVerifications[pending.email.toLowerCase()]; saveDB(db); return user;
}
app.get('/api/auth-config', (req, res) => res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' }));
app.post('/api/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (username.length < 3 || username.length > 24 || !/^[\p{L}\p{N}_.-]+$/u.test(username)) return res.status(400).json({ error: 'Use um nome de usuário de 3 a 24 caracteres (letras, números, ponto, hífen ou _).' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Informe um email válido.' });
    if (password.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
    const db = loadDB();
    if (db.users.some(u => u.email.toLowerCase() === email || u.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'Email ou usuário já cadastrado.' });
    const ip = getClientIp(req); const contasNesseIp = db.ipCounts[ip] || 0;
    if (contasNesseIp >= MAX_CONTAS_POR_IP) return res.status(403).json({ error: 'Limite de 3 contas por IP atingido.' });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); const token = crypto.randomBytes(32).toString('hex');
    const pending = { username, email, passwordHash: await bcrypt.hash(password, 12), createdIp: ip, contactNumber: novoNumeroContato(db), codeHash: codigoHash(email, code), tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 15 * 60 * 1000, authProvider: 'email' };
    db.pendingVerifications[email] = pending; saveDB(db);
    try { await enviarEmailVerificacao(email, code, token, req); } catch (e) { delete db.pendingVerifications[email]; saveDB(db); return res.status(503).json({ error: e.message }); }
    res.json({ verificationRequired: true, email });
  } catch (e) { console.error('[register]', e); res.status(500).json({ error: 'Não foi possível iniciar o cadastro agora.' }); }
});
app.post('/api/verify-email-code', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(); const code = String(req.body.code || '').trim(); const db = loadDB(); const pending = db.pendingVerifications[email];
  if (!pending || pending.expiresAt < Date.now()) { if (pending) { delete db.pendingVerifications[email]; saveDB(db); } return res.status(400).json({ error: 'Código expirado. Faça o cadastro novamente.' }); }
  if (!/^\d{6}$/.test(code) || codigoHash(email, code) !== pending.codeHash) return res.status(400).json({ error: 'Código incorreto. Confira os seis dígitos e tente novamente.' });
  const ip = pending.createdIp; db.ipCounts[ip] = (db.ipCounts[ip] || 0) + 1; const user = finalizarCadastroPendente(db, pending); res.json({ user: publicUser(user) });
});
app.get('/api/verify-email', (req, res) => {
  const token = String(req.query.token || ''); const tokenHash = crypto.createHash('sha256').update(token).digest('hex'); const db = loadDB();
  const entry = Object.entries(db.pendingVerifications || {}).find(([, p]) => p.tokenHash === tokenHash);
  if (!entry || entry[1].expiresAt < Date.now()) return res.status(400).send('<meta name="viewport" content="width=device-width"><body style="font-family:Arial;background:#101218;color:white;padding:40px;text-align:center"><h1>Link expirado</h1><p>Volte ao ChatDevs e faça o cadastro novamente.</p></body>');
  const [email, pending] = entry; db.ipCounts[pending.createdIp] = (db.ipCounts[pending.createdIp] || 0) + 1; finalizarCadastroPendente(db, pending);
  res.send(`<!doctype html><meta name="viewport" content="width=device-width"><title>Email verificado</title><body style="font-family:Arial;background:#101218;color:#f5f6f8;display:grid;place-items:center;min-height:90vh;text-align:center"><div style="padding:32px;border:1px solid #343b47;border-radius:24px;max-width:420px"><div style="font-size:48px;color:#c7f36b">✓</div><h1>Email verificado!</h1><p style="color:#b7bdc9">Sua conta ChatDevs está ativa. Volte ao aplicativo e entre com seu email e senha.</p><a style="display:inline-block;background:#c7f36b;color:#111;text-decoration:none;padding:14px 22px;border-radius:12px;font-weight:bold" href="/">Voltar ao ChatDevs</a></div></body>`);
});
app.post('/api/google-login', async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Login Google ainda não foi configurado pelo administrador.' });
    const credential = String(req.body.credential || ''); if (!credential) return res.status(400).json({ error: 'Credencial Google ausente.' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`); const payload = await verify.json();
    if (!verify.ok || payload.aud !== process.env.GOOGLE_CLIENT_ID || payload.email_verified !== 'true' || !payload.email) return res.status(401).json({ error: 'Não foi possível validar sua conta Google.' });
    const db = loadDB(); const email = String(payload.email).toLowerCase(); let user = db.users.find(u => u.email.toLowerCase() === email);
    if (user && user.bloqueadoAdmin) return res.status(403).json({ error: 'Sua conta foi suspensa. Entre em contato com o suporte.' });
    if (!user) {
      let username = String(payload.name || email.split('@')[0]).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 20) || 'usuario';
      const base = username; let i = 1; while (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) username = `${base.slice(0, 18)}${i++}`;
      user = { id: uuidv4(), username, email, passwordHash: null, contactNumber: novoNumeroContato(db), createdAt: Date.now(), emailVerified: true, authProvider: 'google', photoUrl: payload.picture || null };
      db.users.push(user); saveDB(db);
    } else { user.emailVerified = true; user.authProvider = user.authProvider || 'google'; saveDB(db); }
    res.json({ user: publicUser(user) });
  } catch (e) { console.error('[google-login]', e); res.status(500).json({ error: 'Falha ao entrar com Google. Tente novamente.' }); }
});
app.post('/api/login', async (req, res) => {
  const { emailOrUsername, password } = req.body; const db = loadDB(); const user = findUserByEmailOrUsername(db, String(emailOrUsername || ''));
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (!user.passwordHash) return res.status(401).json({ error: 'Esta conta usa Google. Entre pelo botão Continuar com Google.' });
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Senha incorreta' });
  if (user.bloqueadoAdmin) return res.status(403).json({ error: 'Sua conta foi suspensa. Entre em contato com o suporte.' });
  if (!user.emailVerified) return res.status(403).json({ error: 'Seu email ainda não foi verificado.' });
  res.json({ user: publicUser(user) });
});

// Busca pública por número de contato de 7 dígitos.
app.get('/api/users/search', (req, res) => {
  const q = String(req.query.q || '').trim(); if (!/^\d{7}$/.test(q)) return res.status(400).json({ error: 'Digite o número de contato com 7 dígitos.' });
  const user = loadDB().users.find(u => u.contactNumber === q); if (!user) return res.status(404).json({ error: 'Nenhum perfil encontrado com esse número.' });
  res.json({ user: { id: user.id, username: user.username, contactNumber: user.contactNumber, photoUrl: user.photoUrl || null, bio: user.bio || '' } });
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

// ---------- Atualizar campos do perfil próprio ----------
app.post('/api/users/:userId/profile', (req, res) => {
  const { userId } = req.params;
  if (req.body.userId !== userId) return res.status(403).json({ error: 'Você só pode editar seu próprio perfil.' });
  const db = loadDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  const bio = String(req.body.bio || '').trim().slice(0, 240);
  const phone = String(req.body.phone || '').trim().slice(0, 30);
  const ringColor = /^#[0-9a-fA-F]{6}$/.test(String(req.body.ringColor || '')) ? req.body.ringColor : '#ffb454';
  user.bio = bio;
  user.phone = phone;
  user.ringColor = ringColor;
  user.socials = normalizarSocials(req.body.socials);
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

// ---------- Lista de contatos salvos (fica no servidor, igual em qualquer aparelho) ----------
app.get('/api/contacts', (req, res) => {
  const { ownerId } = req.query;
  if (!ownerId) return res.status(400).json({ error: 'Dados incompletos' });
  const db = loadDB();
  const contatos = db.contacts
    .filter(c => c.ownerId === ownerId)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(c => db.users.find(u => u.id === c.contactId))
    .filter(Boolean)
    .map(u => ({ id: u.id, username: u.username, email: u.email || null, photoUrl: fotoParaViewer(db, u, ownerId) }));
  res.json({ contacts: contatos });
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
    contactNumber: user.contactNumber || null,
    photoUrl: fotoParaViewer(db, user, viewerId),
    bio: user.bio || '',
    phone: user.phone || '',
    ringColor: user.ringColor || '#ffb454',
    socials: normalizarSocials(user.socials)
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
      apagarArquivo(m.mediaUrl);
    });
}

// ---------- Apagar conversa (PV ou grupo) ----------
app.post('/api/chats/:chatId/delete', (req, res) => {
  const { chatId } = req.params;
  const { userId } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat) return res.status(404).json({ error: 'Conversa não encontrada' });

  if (chat.type === 'private' && chat.members.includes(userId)) {
    const eAutoConversa = chat.members.every(m => m === userId);
    if (!eAutoConversa) {
      // PV: apagar é pessoal. Só some pra quem apagou (e o histórico antigo some pra ele);
      // a outra pessoa continua com a conversa. Se os dois apagarem, aí sim limpa tudo.
      if (!chat.hiddenAt) chat.hiddenAt = {};
      chat.hiddenAt[userId] = Date.now();
      if (chat.members.every(m => chat.hiddenAt[m])) {
        apagarArquivosDoChat(db, chatId);
        db.messages = db.messages.filter(m => m.chatId !== chatId);
        db.chats = db.chats.filter(c => c.id !== chatId);
      }
      saveDB(db);
      return res.json({ ok: true });
    }
  }

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

  let novoAdminMsg = null;
  const quemSaiu = db.users.find(u => u.id === userId);
  const msg = criarMensagemSistema(
    chatId,
    `${quemSaiu ? quemSaiu.username : 'Alguém'} saiu do grupo`,
    { kind: 'leave_group', actorId: userId, targetId: userId }
  );

  // quem ainda vai ficar no grupo + quem tá saindo (pra ele ver a própria msg de saída antes de virar fantasma)
  const destinatarios = chat.members.slice();

  const eraDono = souDono(chat, userId);
  chat.members = chat.members.filter(m => m !== userId);
  if (chat.admins) chat.admins = chat.admins.filter(a => a !== userId);
  if (eraDono) {
    // o dono saiu: o grupo fica sem dono (quem criou continua registrado em createdBy).
    // Se não sobrou nenhum admin, um membro aleatório vira admin pro grupo não ficar sem ninguém.
    chat.ownerId = null;
    if (chat.members.length && !(chat.admins || []).length) {
      const sorteado = chat.members[Math.floor(Math.random() * chat.members.length)];
      chat.admins = [sorteado];
      const alvo = db.users.find(u => u.id === sorteado);
      novoAdminMsg = criarMensagemSistema(
        chatId,
        `${alvo ? alvo.username : 'Alguém'} agora é admin do grupo`,
        { kind: 'promote', actorId: sorteado, targetId: sorteado }
      );
    }
  }

  // mesma regra de quando é removido: continua vendo o histórico até agora
  // (modo fantasma), só não recebe mensagem nova nem consegue mandar
  if (!chat.removedMembers) chat.removedMembers = [];
  chat.removedMembers = chat.removedMembers.filter(r => r.userId !== userId);
  chat.removedMembers.push({ userId, removedAt: Date.now() });

  db.messages.push(msg);
  if (novoAdminMsg) db.messages.push(novoAdminMsg);

  if (chat.members.length === 0) {
    apagarArquivosDoChat(db, chatId);
    db.messages = db.messages.filter(m => m.chatId !== chatId);
    db.chats = db.chats.filter(c => c.id !== chatId);
  }

  saveDB(db);
  emitirMensagemSistemaPersonalizada(db, destinatarios, msg);
  if (novoAdminMsg) emitirMensagemSistemaPersonalizada(db, chat.members, novoAdminMsg);
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
      isOwner: id === donoDe(chat),
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
    const admins = [donoDe(chat), ...(chat.admins || [])].filter(Boolean);
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

// ---------- Tirar admin (só o dono do grupo pode) ----------
app.post('/api/chats/:chatId/demote', (req, res) => {
  const { chatId } = req.params;
  const { userId, targetUserId } = req.body;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === chatId);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!souDono(chat, userId)) return res.status(403).json({ error: 'Só o dono do grupo pode tirar admin' });
  if (targetUserId === donoDe(chat)) return res.status(400).json({ error: 'O dono não pode perder o cargo' });
  if (!(chat.admins || []).includes(targetUserId)) return res.json({ ok: true });

  chat.admins = chat.admins.filter(a => a !== targetUserId);
  saveDB(db);
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
  if (targetUserId === donoDe(chat)) return res.status(403).json({ error: 'Não é possível remover o dono do grupo' });
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
    if (c.type === 'private' && c.hiddenAt && c.hiddenAt[userId]) {
      // apaguei essa conversa: só volta pra lista se chegou mensagem depois disso
      return db.messages.some(m => m.chatId === c.id && m.createdAt > c.hiddenAt[userId]);
    }
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
    const jaEntrouEm = c.type === 'group'
      ? ((c.memberJoinedAt && c.memberJoinedAt[userId]) || 0)
      : ((c.hiddenAt && c.hiddenAt[userId]) || 0);
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
      const jaEntrouEm = chat.type === 'group'
        ? ((chat.memberJoinedAt && chat.memberJoinedAt[userId]) || 0)
        : ((chat.hiddenAt && chat.hiddenAt[userId]) || 0);
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
    const tiposComMidia = ['audio', 'video', 'image', 'file'];
    if (tiposComMidia.includes(type) && (typeof mediaUrl !== 'string' || !mediaUrl.trim())) {
      socket.emit('send_message_error', { message: 'A mídia não foi carregada. Tente enviar novamente.' });
      return;
    }
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
      apagarArquivo(msg.mediaUrl);
    }

    msg.deleted = true;
    msg.content = null;
    msg.mediaUrl = null;
    saveDB(db);

    io.to('chat:' + msg.chatId).emit('message_deleted', { id: msg.id });
  });
});

// ---------- Limpeza automática de mídia com mais de 12h ----------
function limparMidiaAntiga() {
  const db = loadDB();
  let mudou = false;
  db.messages.forEach(m => {
    if (m.mediaUrl && m.mediaCreatedAt && Date.now() - m.mediaCreatedAt > VIDA_MIDIA_MS) {
      apagarArquivo(m.mediaUrl);
      m.mediaUrl = null;
      m.mediaExpired = true;
      mudou = true;
    }
  });
  if (mudou) saveDB(db);
}
setInterval(limparMidiaAntiga, 30 * 60 * 1000); // checa a cada 30 min


// ==========================================================================
//  PAINEL ADMIN
// ==========================================================================
const ADMIN_KEY = process.env.ADMIN_KEY || 'chatdevs-admin-2024';

function checkAdmin(req, res) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) { res.status(401).json({ error: 'Não autorizado' }); return false; }
  return true;
}

// ── Novidades ──────────────────────────────────────────────────────────────
app.get('/api/novidades', (req, res) => {
  const db = loadDB();
  res.json({ novidades: db.novidades || [] });
});

app.post('/api/admin/novidades', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { titulo, texto, imageUrl } = req.body;
  if (!titulo || !texto) return res.status(400).json({ error: 'Título e texto são obrigatórios' });
  const db = loadDB();
  if (!db.novidades) db.novidades = [];
  const nova = { id: uuidv4(), titulo, texto, imageUrl: imageUrl || null, criadaEm: Date.now() };
  db.novidades.unshift(nova);
  saveDB(db);
  res.json({ ok: true, novidade: nova });
});

app.put('/api/admin/novidades/:id', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const db = loadDB();
  if (!db.novidades) db.novidades = [];
  const n = db.novidades.find(x => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'Não encontrada' });
  const { titulo, texto, imageUrl } = req.body;
  if (titulo) n.titulo = titulo;
  if (texto) n.texto = texto;
  if (imageUrl !== undefined) n.imageUrl = imageUrl || null;
  n.editadaEm = Date.now();
  saveDB(db);
  res.json({ ok: true, novidade: n });
});

app.delete('/api/admin/novidades/:id', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const db = loadDB();
  db.novidades = (db.novidades || []).filter(x => x.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ── Grupos ─────────────────────────────────────────────────────────────────
app.get('/api/admin/grupos', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const db = loadDB();
  const grupos = db.chats
    .filter(c => c.type === 'group')
    .map(c => {
      const dono = db.users.find(u => u.id === c.ownerId);
      return {
        id: c.id,
        name: c.name,
        description: c.description || '',
        photoUrl: c.photoUrl || null,
        membros: (c.members || []).length,
        trancado: !!c.trancado,
        emailDono: dono ? dono.email : 'desconhecido',
        criadoEm: c.createdAt || null
      };
    });
  res.json({ grupos });
});

app.post('/api/admin/grupos/:chatId/trancar', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const db = loadDB();
  const chat = db.chats.find(c => c.id === req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'Grupo não encontrado' });
  chat.trancado = !chat.trancado;
  chat.modoEnvio = chat.trancado ? 'dono' : 'todos';
  saveDB(db);
  res.json({ ok: true, trancado: chat.trancado });
});

app.delete('/api/admin/grupos/:chatId', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const db = loadDB();
  db.chats = db.chats.filter(c => c.id !== req.params.chatId);
  db.messages = db.messages.filter(m => m.chatId !== req.params.chatId);
  saveDB(db);
  res.json({ ok: true });
});

// ── Membros ────────────────────────────────────────────────────────────────
app.get('/api/admin/membros', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const db = loadDB();
  const membros = db.users.map(u => ({
    id: u.id,
    username: u.username,
    email: u.email,
    photoUrl: u.photoUrl || null,
    bloqueado: !!u.bloqueadoAdmin,
    criadoEm: u.createdAt || null
  }));
  res.json({ membros });
});

app.post('/api/admin/membros/:userId/bloquear', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const db = loadDB();
  const user = db.users.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  user.bloqueadoAdmin = !user.bloqueadoAdmin;
  saveDB(db);
  res.json({ ok: true, bloqueado: user.bloqueadoAdmin });
});

app.delete('/api/admin/membros/:userId', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const db = loadDB();
  db.users = db.users.filter(u => u.id !== req.params.userId);
  // remove de todos os grupos
  db.chats.forEach(c => {
    if (c.members) c.members = c.members.filter(id => id !== req.params.userId);
    if (c.admins) c.admins = c.admins.filter(id => id !== req.params.userId);
  });
  db.messages = db.messages.filter(m => m.senderId !== req.params.userId);
  saveDB(db);
  res.json({ ok: true });
});

// ── Admins do painel ───────────────────────────────────────────────────────
app.get('/api/admin/admins', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const db = loadDB();
  const admins = (db.painelAdmins || []).map(id => {
    const u = db.users.find(u => u.id === id);
    return u ? { id: u.id, username: u.username, email: u.email, photoUrl: u.photoUrl || null } : null;
  }).filter(Boolean);
  res.json({ admins });
});

app.post('/api/admin/admins/:userId', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const db = loadDB();
  if (!db.painelAdmins) db.painelAdmins = [];
  const user = db.users.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (!db.painelAdmins.includes(user.id)) db.painelAdmins.push(user.id);
  saveDB(db);
  res.json({ ok: true });
});
  
app.delete('/api/admin/admins/:userId', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const db = loadDB();
  db.painelAdmins = (db.painelAdmins || []).filter(id => id !== req.params.userId);
  saveDB(db);
  res.json({ ok: true });
});

// Buscar usuário por username (pra adicionar admin)
app.get('/api/admin/buscar-usuario', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { q } = req.query;
  const db = loadDB();
  const u = db.users.find(x => x.username.toLowerCase() === (q || '').toLowerCase() || x.email.toLowerCase() === (q || '').toLowerCase());
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json({ id: u.id, username: u.username, email: u.email, photoUrl: u.photoUrl || null });
});

init()
  .then(() => {
    const db = loadDB(); let changed = false;
    for (const u of db.users) {
      // Contas antigas já existentes não devem perder acesso por causa da nova etapa de verificação.
      if (u.emailVerified === undefined) { u.emailVerified = true; changed = true; }
      if (!u.contactNumber) { u.contactNumber = novoNumeroContato(db); changed = true; }
    }
    if (!db.pendingVerifications) { db.pendingVerifications = {}; changed = true; }
    if (changed) saveDB(db);
    server.listen(PORT, () => {
      console.log(`Servidor rodando em http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('[db] Erro ao inicializar o MongoDB:', err);
    process.exit(1);
  });