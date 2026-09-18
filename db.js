// Banco de dados simples baseado em arquivo JSON.
// Zero configuração, zero custo, zero serviço externo.
// Guarda tudo em data/db.json

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const empty = { users: [], chats: [], messages: [], ipCounts: {}, blocks: [], reads: {}, pendingInvites: [], contacts: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }

  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  let db;
  try {
    db = JSON.parse(raw);
  } catch (erro) {
    // data/db.json está corrompido (não é um JSON válido).
    // Em vez de derrubar o servidor a cada requisição, guarda uma cópia
    // do arquivo problemático e recomeça com um banco vazio.
    const backupPath = DB_PATH + '.corrompido.' + Date.now() + '.bak';
    try { fs.copyFileSync(DB_PATH, backupPath); } catch (e) {}
    console.error('[db.js] data/db.json estava corrompido e foi reiniciado. Cópia salva em: ' + backupPath);
    db = { users: [], chats: [], messages: [], ipCounts: {}, blocks: [], reads: {}, pendingInvites: [], contacts: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    return db;
  }

  if (!db.blocks) db.blocks = [];
  if (!db.reads) db.reads = {}; // reads["userId|chatId"] = timestamp da última leitura
  if (!db.pendingInvites) db.pendingInvites = []; // convites pra grupo que ficaram esperando um desbloqueio
  if (!db.contacts) db.contacts = []; // { ownerId, contactId, createdAt } — contato "de verdade", salvo por escolha da pessoa
  return db;
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

module.exports = { loadDB, saveDB };