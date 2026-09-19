// db.js — MongoDB com Mongoose
// Mantém a mesma interface (loadDB / saveDB) que o código antigo usava,
// mas agora os dados ficam no Atlas em vez de um arquivo local.

const mongoose = require('mongoose');

// ── Conexão ────────────────────────────────────────────────────────────────
let conectado = false;

async function conectar() {
  if (conectado) return;
  await mongoose.connect(process.env.MONGODB_URI);
  conectado = true;
  console.log('[db] Conectado ao MongoDB Atlas');
}

// ── Schemas ────────────────────────────────────────────────────────────────
// Usamos schemas flexíveis (strict: false) pra não precisar mapear cada campo
// novo que o app vier a ter — o comportamento fica igual ao do JSON antigo.

const opts = { strict: false, timestamps: false };

const User    = mongoose.model('User',    new mongoose.Schema({}, opts));
const Chat    = mongoose.model('Chat',    new mongoose.Schema({}, opts));
const Message = mongoose.model('Message', new mongoose.Schema({}, opts));
const Meta    = mongoose.model('Meta',    new mongoose.Schema({}, opts)); // ipCounts, reads, etc.

// ── Carrega TUDO numa estrutura igual ao db.json antigo ───────────────────
// Cada chamada a loadDB() faz um round-trip ao Atlas.
// Em produção isso é rápido (< 50 ms na mesma região), mas se quiser otimizar
// depois é só adicionar um cache em memória aqui.
async function loadDB() {
  await conectar();

  const [users, chats, messages, metaDocs] = await Promise.all([
    User.find({}).lean(),
    Chat.find({}).lean(),
    Message.find({}).lean(),
    Meta.find({}).lean(),
  ]);

  // metaDocs guarda ipCounts, blocks, reads, pendingInvites, contacts
  // como documentos individuais com um campo "key" e "value".
  const meta = {
    ipCounts: {},
    blocks: [],
    reads: {},
    pendingInvites: [],
    contacts: [],
  };
  for (const doc of metaDocs) {
    if (doc.key && doc.key in meta) meta[doc.key] = doc.value;
  }

  return { users, chats, messages, ...meta };
}

// ── Salva tudo de volta ────────────────────────────────────────────────────
// Faz um bulk upsert: documentos existentes são atualizados, novos são criados.
async function saveDB(db) {
  await conectar();

  const upsertMany = async (Model, docs) => {
    if (!docs || !docs.length) return;
    const ops = docs.map(doc => ({
      updateOne: {
        filter: { id: doc.id },
        update: { $set: doc },
        upsert: true,
      },
    }));
    await Model.bulkWrite(ops, { ordered: false });
  };

  const saveMeta = async (key, value) => {
    await Meta.updateOne({ key }, { $set: { key, value } }, { upsert: true });
  };

  await Promise.all([
    upsertMany(User,    db.users),
    upsertMany(Chat,    db.chats),
    upsertMany(Message, db.messages),
    saveMeta('ipCounts',      db.ipCounts      || {}),
    saveMeta('blocks',        db.blocks        || []),
    saveMeta('reads',         db.reads         || {}),
    saveMeta('pendingInvites',db.pendingInvites || []),
    saveMeta('contacts',      db.contacts      || []),
  ]);
}

// ── Apagar um único documento (ex: apagar mensagem/chat) ──────────────────
async function deleteDoc(Model, id) {
  await conectar();
  await Model.deleteOne({ id });
}

module.exports = { loadDB, saveDB, User, Chat, Message, Meta, conectar };
