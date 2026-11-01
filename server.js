import { createClient } from '@libsql/client/web';

export default {
  async fetch(request, env) {
    // 1. Настройка заголовков CORS (чтобы Tilda могла делать запросы)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // 2. Обработка preflight-запросов от браузера
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 3. Проверка наличия секретов (защита от ошибки 1101)
    if (!env.TURSO_URL || !env.TURSO_TOKEN) {
      return Response.json(
        { error: 'Секреты TURSO_URL или TURSO_TOKEN не добавлены в Cloudflare' }, 
        { status: 500, headers: corsHeaders }
      );
    }

    const url = new URL(request.url);

    try {
      // 4. Инициализация базы данных Turso
      const db = createClient({
        url: env.TURSO_URL,
        authToken: env.TURSO_TOKEN,
      });

      // --- МАРШРУТ 1: Онлайн ---
      if (url.pathname === '/api/arcade/online' && request.method === 'GET') {
        const result = await db.execute(`
          SELECT COUNT(DISTINCT token) as online 
          FROM sessions 
          WHERE last_seen > datetime('now', '-5 minutes')
        `);
        // Используем Number(), так как Turso может вернуть строку
        return Response.json({ online: Number(result.rows[0].online) }, { headers: corsHeaders });
      }

      // --- МАРШРУТ 2: Таблица лидеров ---
      if (url.pathname === '/api/arcade/board' && request.method === 'GET') {
        const cat = url.searchParams.get('cat');
        const validCats = ['typing', 'clicking', 'reaction', 'memory'];
        
        if (!validCats.includes(cat)) {
          return Response.json({ error: 'Неверная категория' }, { status: 400, headers: corsHeaders });
        }
        
        // Для реакции меньше — лучше (ASC), для остальных больше — лучше (DESC)
        const order = cat === 'reaction' ? 'ASC' : 'DESC';
        
        const result = await db.execute({
          sql: `SELECT p.callsign, r.value, r.wpm, r.cpm, r.err_pct, r.created_at 
                FROM results r
                JOIN players p ON r.player_id = p.id
                WHERE r.cat = ? AND p.anon = 0
                ORDER BY r.value ${order}
                LIMIT 100`,
          args: [cat]
        });
        return Response.json(result.rows, { headers: corsHeaders });
      }

      // --- МАРШРУТ 3: Средние значения топа ---
      if (url.pathname === '/api/arcade/avgs' && request.method === 'GET') {
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
        return Response.json(avgs, { headers: corsHeaders });
      }

      // --- МАРШРУТ 4: Сохранение результата ---
      if (url.pathname === '/api/arcade/result' && request.method === 'POST') {
        const body = await request.json();
        const { callsign, cat, value, wpm, cpm, err_pct } = body;
        
        if (!callsign || !cat || value === undefined) {
          return Response.json({ error: 'Отсутствуют обязательные поля' }, { status: 400, headers: corsHeaders });
        }

        // Проверяем, есть ли игрок
        let pRes = await db.execute({ 
          sql: 'SELECT id FROM players WHERE callsign = ?', 
          args: [callsign] 
        });
        
        let playerId;
        if (pRes.rows.length === 0) {
          // Создаем нового игрока
          const insertP = await db.execute({ 
            sql: 'INSERT INTO players (callsign) VALUES (?) RETURNING id', 
            args: [callsign] 
          });
          playerId = insertP.rows[0].id;
        } else {
          // Обновляем время последнего визита
          playerId = pRes.rows[0].id;
          await db.execute({ 
            sql: 'UPDATE players SET last_seen = CURRENT_TIMESTAMP WHERE id = ?', 
            args: [playerId] 
          });
        }

        // Записываем результат
        await db.execute({
          sql: `INSERT INTO results (player_id, cat, value, wpm, cpm, err_pct) VALUES (?, ?, ?, ?, ?, ?)`,
          args: [playerId, cat, value, wpm || null, cpm || null, err_pct || null]
        });
        
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      // --- МАРШРУТ 5: Хартбит (поддержание сессии) ---
      if (url.pathname === '/api/arcade/heartbeat' && request.method === 'POST') {
        const body = await request.json();
        const { token, player_id } = body;
        
        if (!token) {
          return Response.json({ error: 'Требуется token' }, { status: 400, headers: corsHeaders });
        }

        await db.execute({
          sql: `INSERT INTO sessions (token, player_id, last_seen) VALUES (?, ?, CURRENT_TIMESTAMP) 
                ON CONFLICT(token) DO UPDATE SET last_seen = CURRENT_TIMESTAMP, player_id = COALESCE(?, player_id)`,
          args: [token, player_id || null, player_id || null]
        });
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      // --- ОБЯЗАТЕЛЬНО: Если запрос пришел не по адресу ---
      return new Response('Not found', { status: 404, headers: corsHeaders });

    } catch (e) {
      // Ловим ЛЮБЫЕ ошибки базы данных или JS, чтобы не было ошибки 1101
      console.error('Критическая ошибка в Worker:', e);
      return Response.json(
        { error: 'Внутренняя ошибка сервера', details: e.message }, 
        { status: 500, headers: corsHeaders }
      );
    }
  }
};
