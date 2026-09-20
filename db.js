const mongoose = require('mongoose');

const opts = { strict: false, timestamps: false };
const User    = mongoose.model('User',    new mongoose.Schema({}, opts));
const Chat    = mongoose.model('Chat',    new mongoose.Schema({}, opts));
const Message = mongoose.model('Message', new mongoose.Schema({}, opts));
const Meta    = mongoose.model('Meta',    new mongoose.Schema({}, opts));

const META_KEYS = { ipCounts: {}, blocks: [], reads: {}, pendingInvites: [], contacts: [] };
const ultimo = { User: new Map(), Chat: new Map(), Message: new Map(), Meta: new Map() };
let cache = null;

const limpa = d => { delete d._id; delete d.__v; return d; };

async function init() {
  await mongoose.connect(process.env.MONGODB_URI);
  const [users, chats, messages, metaDocs] = await Promise.all([
    User.find({}).lean(), Chat.find({}).lean(),
    Message.find({}).lean(), Meta.find({}).lean()
  ]);
  const meta = JSON.parse(JSON.stringify(META_KEYS));
  for (const d of metaDocs) if (d.key in meta) meta[d.key] = d.value;

  cache = {
    users: users.map(limpa),
    chats: chats.map(limpa),
    messages: messages.map(limpa),
    ...meta
  };

  for (const [M, docs] of [[User, cache.users], [Chat, cache.chats], [Message, cache.messages]]) {
    docs.forEach(d => ultimo[M.modelName].set(d.id, JSON.stringify(d)));
  }
  for (const k of Object.keys(META_KEYS)) ultimo.Meta.set(k, JSON.stringify(cache[k]));
  console.log('[db] Conectado ao MongoDB Atlas');
}

function loadDB() { return cache; }

async function persistir() {
  const tarefas = [];

  for (const [M, docs] of [[User, cache.users], [Chat, cache.chats], [Message, cache.messages]]) {
    const mapa = ultimo[M.modelName];
    const ids = new Set(), ops = [], novos = [], remover = [];

    for (const d of docs) {
      ids.add(d.id);
      const s = JSON.stringify(d);
      if (mapa.get(d.id) !== s) {
        ops.push({ updateOne: { filter: { id: d.id }, update: { $set: d }, upsert: true } });
        novos.push([d.id, s]);
      }
    }
    for (const id of mapa.keys()) if (!ids.has(id)) remover.push(id);
    if (remover.length) ops.push({ deleteMany: { filter: { id: { $in: remover } } } });

    if (ops.length) {
      tarefas.push(M.bulkWrite(ops, { ordered: false }).then(() => {
        novos.forEach(([id, s]) => mapa.set(id, s));
        remover.forEach(id => mapa.delete(id));
      }));
    }
  }

  for (const k of Object.keys(META_KEYS)) {
    const s = JSON.stringify(cache[k]);
    if (ultimo.Meta.get(k) !== s) {
      tarefas.push(
        Meta.updateOne({ key: k }, { $set: { key: k, value: cache[k] } }, { upsert: true })
          .then(() => ultimo.Meta.set(k, s))
      );
    }
  }

  await Promise.all(tarefas);
}

let fila = Promise.resolve();
function saveDB() {
  fila = fila.then(persistir).catch(e => console.error('[db] erro ao salvar:', e.message));
}

module.exports = { init, loadDB, saveDB, User, Chat, Message, Meta };
