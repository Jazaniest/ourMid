import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import './bot.js';
import { bot } from './bot.js';
import { createUser, getUserByTelegramId, getUserById, createTransaction, confirmTransaction } from './core.js';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
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

app.use(bodyParser.json());
app.use('/public', express.static(path.resolve('public')));

app.post('/api/register', async (req, res) => {
  const { telegramId, name } = req.body;
  try {
    const u = await createUser(telegramId, name);
    res.json(u);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/admin', (_, res) => res.sendFile(path.resolve('public/admin.html')));
app.get('/api/admin/users', async (_, res) => { const d = await readData(); res.json(d.users); });
app.get('/api/admin/transactions', async (_, res) => { const d = await readData(); res.json(d.transactions); });
app.post('/api/admin/confirm/:txId', async (req, res) => {
  const id = parseInt(req.params.txId, 10);
  const { buyerId } = req.body;
  try {
    const tx = await confirmTransaction(id, buyerId);
    res.json(tx);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/broadcast', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }
  try {
    const data = await readData();
    const users = data.users;
    await Promise.all(users.map(u =>
      bot.sendMessage(u.telegramId, message, { parse_mode: 'HTML' })
    ));
    res.json({ success: true, sent: users.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));