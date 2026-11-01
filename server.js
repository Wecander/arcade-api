import express from 'express';
import cors from 'cors';
import { createClient } from '@libsql/client';

const app = express();
app.use(cors()); // Разрешаем запросы с Tilda
app.use(express.json());

// ==========================================
// ВСТАВЬТЕ СЮДА ВАШИ ДАННЫЕ ИЗ TURSO
// ==========================================
const TURSO_URL = 'libsql://reflexarena-wecander.aws-eu-west-1.turso.io'; 
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJnaWQiOiIxMDBiMTFlMi0wYjQ0LTQzNjYtOTRjNC0wNzA5YmE0YzBkMGEiLCJpYXQiOjE3OTM1MjE1ODIsImtpZCI6IjZUb0RIUnpLLUQ0RTJzSVZoMXJRNTQ4M2F1c1QzRlNKeEJPOFB3R0NIVE0iLCJyaWQiOiJhOTM1Mzc5NC01ZmY1LTQzNGMtOTc1NS1lZTFkMmExN2VkMTQifQ.pJI9x2VpNLrOT5Yevfzs4oTDLXeRM2sD5fingxwIlUrZxOct_9ml_dkUJUSp_ZYaKwrVQNIYqzIdqZg9FBSGDQ';

const db = createClient({
  url: TURSO_URL,
  authToken: TURSO_TOKEN,
});

// 1. Онлайн (хартбит)
app.post('/api/arcade/heartbeat', async (req, res) => {
  const { token, player_id } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  try {
    await db.execute({
      sql: `INSERT INTO sessions (token, player_id, last_seen) 
            VALUES (?, ?, CURRENT_TIMESTAMP) 
            ON CONFLICT(token) DO UPDATE SET last_seen = CURRENT_TIMESTAMP, player_id = COALESCE(?, player_id)`,
      args: [token, player_id || null, player_id || null]
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. Получить онлайн
app.get('/api/arcade/online', async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT COUNT(DISTINCT token) as online 
      FROM sessions 
      WHERE last_seen > datetime('now', '-5 minutes')
    `);
    res.json({ online: result.rows[0].online });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. Таблица лидеров (Топ-100)
app.get('/api/arcade/board', async (req, res) => {
  const { cat } = req.query;
  const validCats = ['typing', 'clicking', 'reaction', 'memory'];
  if (!validCats.includes(cat)) return res.status(400).json({ error: 'Invalid category' });

  // Для реакции лучше меньшее время (ASC), для остальных - большее (DESC)
  const order = cat === 'reaction' ? 'ASC' : 'DESC';

  try {
    const result = await db.execute({
      sql: `SELECT p.callsign, r.value, r.wpm, r.cpm, r.err_pct, r.created_at 
            FROM results r
            JOIN players p ON r.player_id = p.id
            WHERE r.cat = ? AND p.anon = 0
            ORDER BY r.value ${order}
            LIMIT 100`,
      args: [cat]
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 4. Средние значения (пунктир на графике)
app.get('/api/arcade/avgs', async (req, res) => {
  try {
    const cats = ['typing', 'clicking', 'reaction', 'memory'];
    let avgs = {};
    
    for (const cat of cats) {
      const order = cat === 'reaction' ? 'ASC' : 'DESC';
      const result = await db.execute({
        sql: `SELECT AVG(value) as avg_val FROM (
                SELECT value FROM results 
                WHERE cat = ? 
                ORDER BY value ${order} 
                LIMIT 5
              )`,
        args: [cat]
      });
      avgs[cat] = result.rows[0].avg_val || 0;
    }
    res.json(avgs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 5. Сохранение результата
app.post('/api/arcade/result', async (req, res) => {
  const { callsign, cat, value, wpm, cpm, err_pct } = req.body;
  if (!callsign || !cat || value === undefined) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    // Ищем игрока или создаём нового
    let pRes = await db.execute({
      sql: 'SELECT id FROM players WHERE callsign = ?',
      args: [callsign]
    });
    
    let playerId;
    if (pRes.rows.length === 0) {
      const insertP = await db.execute({
        sql: 'INSERT INTO players (callsign) VALUES (?) RETURNING id',
        args: [callsign]
      });
      playerId = insertP.rows[0].id;
    } else {
      playerId = pRes.rows[0].id;
      // Обновляем last_seen
      await db.execute({ sql: 'UPDATE players SET last_seen = CURRENT_TIMESTAMP WHERE id = ?', args: [playerId] });
    }

    // Сохраняем результат
    await db.execute({
      sql: `INSERT INTO results (player_id, cat, value, wpm, cpm, err_pct) 
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [playerId, cat, value, wpm || null, cpm || null, err_pct || null]
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});