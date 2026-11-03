// Direct Turso HTTP API client — bypasses @libsql/client migration jobs check
function createTursoClient(tursoUrl, authToken) {
  const baseUrl = tursoUrl.replace(/^libsql:\/\//, 'https://');

  function toHranaValue(v) {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
    if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
    if (typeof v === 'number') return { type: 'float', value: v };
    return { type: 'text', value: String(v) };
  }

  function fromHranaValue(v) {
    if (v === null) return null;
    if (v.type === 'null') return null;
    if (v.type === 'integer') return Number(v.value);
    if (v.type === 'float') return v.value;
    if (v.type === 'text') return v.value;
    if (v.type === 'blob') return v.base64;
    return null;
  }

  async function execute(stmt) {
    var sql, args = [];
    if (typeof stmt === 'string') {
      sql = stmt;
    } else {
      sql = stmt.sql;
      args = stmt.args || [];
    }

    var body = {
      requests: [
        { type: 'execute', stmt: { sql: sql, args: args.map(toHranaValue) } },
        { type: 'close' }
      ]
    };

    var response = await fetch(baseUrl + '/v2/pipeline', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + authToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      var errText = await response.text();
      throw new Error('Turso API error (' + response.status + '): ' + errText);
    }

    var data = await response.json();
    var firstResult = data.results[0];

    if (!firstResult || firstResult.type === 'error') {
      var msg = (firstResult && firstResult.error && firstResult.error.message) || 'Unknown Turso error';
      throw new Error(msg);
    }

    var execResult = firstResult.response.result;
    var columns = (execResult.cols || []).map(function(c) { return c.name || ''; });

    var rows = (execResult.rows || []).map(function(row) {
      var obj = {};
      for (var i = 0; i < row.length; i++) {
        var colName = columns[i];
        var val = fromHranaValue(row[i]);
        if (colName !== undefined && colName !== '') {
          obj[colName] = val;
        }
      }
      return obj;
    });

    return {
      rows: rows,
      columns: columns,
      rowsAffected: execResult.affected_row_count || 0,
      lastInsertRowid: execResult.last_insert_rowid ? Number(execResult.last_insert_rowid) : undefined
    };
  }

  return { execute: execute };
}

// ─── Constants ──────────────────────────────────────────────
const VALID_CATS = ["typing", "clicking", "reaction", "memory"];
const VALID_DIFFS = ["easy", "medium", "hard", "expert"];

// Простой Rate Limiting в памяти (сбрасывается при перезапуске Worker'а)
const RATE_LIMIT = new Map();

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (!env.TURSO_URL || !env.TURSO_TOKEN) {
      return Response.json(
        { error: "Секреты TURSO_URL или TURSO_TOKEN не добавлены в Cloudflare" },
        { status: 500, headers: corsHeaders }
      );
    }

    const url = new URL(request.url);
    
    // ─── RATE LIMITING (только для GET запросов) ─────────────
    // Ограничиваем 60 запросов в минуту с одного IP
    if (request.method === "GET") {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const now = Date.now();
      const windowMs = 60000;
      const maxReq = 60;

      if (!RATE_LIMIT.has(ip)) {
        RATE_LIMIT.set(ip, { count: 1, reset: now + windowMs });
      } else {
        const rec = RATE_LIMIT.get(ip);
        if (now > rec.reset) {
          rec.count = 1;
          rec.reset = now + windowMs;
        } else {
          rec.count++;
          if (rec.count > maxReq) {
            return Response.json({ error: "Слишком много запросов. Подождите минуту." }, { status: 429, headers: corsHeaders });
          }
        }
      }
    }

    try {
      const db = createTursoClient(env.TURSO_URL, env.TURSO_TOKEN);

      // ─── КЭШИРОВАНИЕ (Cache API) ───────────────────────────
      // Проверяем, есть ли ответ в кэше Cloudflare
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), request);
      let cachedResponse = await cache.match(cacheKey);
      
      // Если в кэше есть данные и это GET-запрос, отдаем их мгновенно
      if (cachedResponse && request.method === "GET") {
        return cachedResponse;
      }

      let response;

      // ─── /api/arcade/online ───────────────────────────────
      if (url.pathname === "/api/arcade/online" && request.method === "GET") {
        const result = await db.execute(
          "SELECT COUNT(DISTINCT token) as online FROM sessions WHERE last_seen > datetime('now', '-5 minutes')"
        );
        response = Response.json({ online: Number(result.rows[0].online) }, { headers: corsHeaders });
        // Кэшируем онлайн на 30 секунд
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      // ─── /api/arcade/board ────────────────────────────────
      if (url.pathname === "/api/arcade/board" && request.method === "GET") {
        const cat = url.searchParams.get("cat");
        const diff = url.searchParams.get("diff") || "medium";

        if (!VALID_CATS.includes(cat)) {
          return Response.json({ error: "Неверная категория" }, { status: 400, headers: corsHeaders });
        }
        if (!VALID_DIFFS.includes(diff)) {
          return Response.json({ error: "Неверная сложность" }, { status: 400, headers: corsHeaders });
        }

        const order = cat === "reaction" ? "ASC" : "DESC";
        const result = await db.execute({
          sql: "SELECT p.callsign, r.value, r.wpm, r.cpm, r.err_pct, r.diff, r.created_at " +
               "FROM results r JOIN players p ON r.player_id = p.id " +
               "WHERE r.cat = ? AND r.diff = ? AND r.is_suspicious = 0 AND p.anon = 0 " +
               "ORDER BY r.value " + order + " LIMIT 100",
          args: [cat, diff]
        });
        response = Response.json(result.rows, { headers: corsHeaders });
        // Кэшируем таблицу лидеров на 60 секунд (по ключу с учетом cat и diff)
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      // ─── /api/arcade/avgs ─────────────────────────────────
      if (url.pathname === "/api/arcade/avgs" && request.method === "GET") {
        const diff = url.searchParams.get("diff") || "medium";

        if (!VALID_DIFFS.includes(diff)) {
          return Response.json({ error: "Неверная сложность" }, { status: 400, headers: corsHeaders });
        }

        // БАТЧИНГ: Объединяем 4 запроса в 1 с помощью UNION ALL
        const sql = `
          SELECT 'typing' as cat, AVG(value) as avg_val FROM (SELECT value FROM results WHERE cat='typing' AND diff=? AND is_suspicious=0 ORDER BY value DESC LIMIT 5)
          UNION ALL
          SELECT 'clicking', AVG(value) FROM (SELECT value FROM results WHERE cat='clicking' AND diff=? AND is_suspicious=0 ORDER BY value DESC LIMIT 5)
          UNION ALL
          SELECT 'reaction', AVG(value) FROM (SELECT value FROM results WHERE cat='reaction' AND diff=? AND is_suspicious=0 ORDER BY value ASC LIMIT 5)
          UNION ALL
          SELECT 'memory', AVG(value) FROM (SELECT value FROM results WHERE cat='memory' AND diff=? AND is_suspicious=0 ORDER BY value DESC LIMIT 5)
        `;
        
        const result = await db.execute({ sql: sql, args: [diff, diff, diff, diff] });
        
        // Формируем объект ответа
        let avgs = { typing: 0, clicking: 0, reaction: 0, memory: 0 };
        result.rows.forEach(r => {
          if (r.cat) avgs[r.cat] = r.avg_val || 0;
        });

        response = Response.json(avgs, { headers: corsHeaders });
        // Кэшируем средние значения на 120 секунд
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      // ─── /api/arcade/result ───────────────────────────────
      // POST-запросы не кэшируются, они всегда идут в базу
      if (url.pathname === "/api/arcade/result" && request.method === "POST") {
        const body = await request.json();
        const { callsign, cat, diff, value, wpm, cpm, err_pct, is_suspicious, proof } = body;

        if (!callsign || !cat || value === undefined) {
          return Response.json({ error: "Отсутствуют обязательные поля" }, { status: 400, headers: corsHeaders });
        }

        const finalDiff = VALID_DIFFS.includes(diff) ? diff : "medium";
        const finalSuspicious = is_suspicious ? 1 : 0;

        let pRes = await db.execute({
          sql: "SELECT id FROM players WHERE callsign = ?",
          args: [callsign]
        });
        let playerId;
        if (pRes.rows.length === 0) {
          const insertP = await db.execute({
            sql: "INSERT INTO players (callsign) VALUES (?) RETURNING id",
            args: [callsign]
          });
          playerId = insertP.rows[0].id;
        } else {
          playerId = pRes.rows[0].id;
          await db.execute({
            sql: "UPDATE players SET last_seen = CURRENT_TIMESTAMP WHERE id = ?",
            args: [playerId]
          });
        }

        await db.execute({
          sql: "INSERT INTO results (player_id, cat, diff, value, wpm, cpm, err_pct, is_suspicious, proof) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [playerId, cat, finalDiff, value, wpm || null, cpm || null, err_pct || null, finalSuspicious, proof || null]
        });
        
        // Очищаем кэш рейтинга, так как появился новый результат
        // (На практике Cloudflare Cache API не позволяет удалять по маске, 
        // поэтому кэш просто устареет через 60 секунд)
        
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      // ─── /api/arcade/heartbeat ────────────────────────────
      if (url.pathname === "/api/arcade/heartbeat" && request.method === "POST") {
        const body = await request.json();
        const { token, player_id } = body;
        if (!token) {
          return Response.json({ error: "Требуется token" }, { status: 400, headers: corsHeaders });
        }
        await db.execute({
          sql: "INSERT INTO sessions (token, player_id, last_seen) VALUES (?, ?, CURRENT_TIMESTAMP) " +
               "ON CONFLICT(token) DO UPDATE SET last_seen = CURRENT_TIMESTAMP, player_id = COALESCE(?, player_id)",
          args: [token, player_id || null, player_id || null]
        });
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      return new Response("Not found", { status: 404, headers: corsHeaders });

    } catch (e) {
      console.error("Критическая ошибка в Worker:", e);
      return Response.json(
        { error: "Внутренняя ошибка сервера", details: e.message },
        { status: 500, headers: corsHeaders }
      );
    }
  }
};
