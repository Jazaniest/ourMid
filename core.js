import fs from 'fs/promises';
import path from 'path';

const DATA_FILE = path.resolve('data.json');

async function readData() {
  try {
    const content = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') return { users: [], transactions: [] };
    throw err;
  }
}

async function writeData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export async function createUser(telegramId, name) {
  const data = await readData();
  if (data.users.some(u => u.telegramId === telegramId)) throw new Error('Already registered');
  const id = data.users.length ? Math.max(...data.users.map(u => u.id)) + 1 : 1;
  const user = { id, telegramId, name, balance: 0, lastUpdated: null };
  data.users.push(user);
  await writeData(data);
  return user;
}

export async function getUserByTelegramId(telegramId) {
  const { users } = await readData();
  const u = users.find(x => x.telegramId === telegramId);
  if (!u) throw new Error('Not registered');
  return u;
}

export async function getUserByTelegramName(telegramName) {
  const { users } = await readData();
  const u = users.find(x => x.name === telegramName);
  if (!u) throw new Error('Not registered');
  return u;
}

export async function getUserById(id) {
  const data = await readData();
  const u = data.users.find(x => x.id === id);
  if (!u) throw new Error('User ID not found');
  return u;
}

export async function createTransaction(buyerId, sellerId, amount) {
  const data = await readData();
  const buyer = data.users.find(u=>u.id===buyerId);
  if (!buyer) throw new Error('Buyer not found');
  if (buyer.balance<amount) throw new Error('Insufficient balance');
  buyer.balance -= amount;
  buyer.lastUpdated = new Date().toISOString();
  const txId = data.transactions.length ? Math.max(...data.transactions.map(t=>t.id))+1 : 1;
  const tx = { id:txId,buyerId,sellerId,amount,status:'pending',createdAt:new Date().toISOString(),completedAt:null };
  data.transactions.push(tx);
  await writeData(data);
  return tx;
}

export async function confirmTransaction(txId, buyerId) {
  const data = await readData();
  const tx = data.transactions.find(t=>t.id===txId);
  if (!tx) throw new Error('Transaction not found');
  if (tx.status!=='pending') throw new Error('Already processed');
  if (tx.buyerId!==buyerId) throw new Error('Not authorized');
  const seller = data.users.find(u=>u.id===tx.sellerId);
  if (!seller) throw new Error('Seller not found');
  seller.balance += tx.amount;
  seller.lastUpdated = new Date().toISOString();
  tx.status = 'completed';
  tx.completedAt = new Date().toISOString();
  await writeData(data);
  return tx;
}

export async function getTransactionsByUser(userId) {
  const { transactions } = await readData();
  return transactions.filter(t=>t.buyerId===userId||t.sellerId===userId);
}