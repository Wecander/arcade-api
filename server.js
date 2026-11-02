// Direct Turso HTTP API client — bypasses @libsql/client migration jobs check
// Uses the Turso /v2/pipeline endpoint with JSON encoding (hrana protocol)

function createTursoClient(tursoUrl, authToken) {
  // Convert libsql:// to https://
  const baseUrl = tursoUrl.replace(/^libsql:\/\//, 'https://');

  // Convert a JS value to the hrana JSON Value format for request args
  function toHranaValue(v) {
    if (v === null || v === undefined) {
      return { type: 'null' };
    }
    if (typeof v === 'bigint') {
      return { type: 'integer', value: String(v) };
    }
    if (typeof v === 'boolean') {
      return { type: 'integer', value: v ? '1' : '0' };
    }
    if (typeof v === 'number') {
      return { type: 'float', value: v };
    }
    // string and everything else
    return { type: 'text', value: String(v) };
  }

  // Convert a hrana JSON Value from the response back to a JS value
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
        {
          type: 'execute',
          stmt: {
            sql: sql,
            args: args.map(toHranaValue)
          }
        },
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

export default {
  async fetch(request, env) {
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
    try {
      const db = createTursoClient(env.TURSO_URL, env.TURSO_TOKEN);

      // 1. Онлайн и общее количество результатов
      if (url.pathname === "/api/arcade/online" && request.method === "GET") {
        const onlineRes = await db.execute(
          "SELECT COUNT(DISTINCT token) as online FROM sessions WHERE last_seen > datetime('now', '-1 minutes')"
        );
        const totalRes = await db.execute(
          "SELECT COUNT(*) as total FROM results WHERE is_suspicious = 0"
        );
        return Response.json({ 
          online: Number(onlineRes.rows[0].online),
          total: Number(totalRes.rows[0].total)
        }, { headers: corsHeaders });
      }

      // 2. Таблица лидеров (с фильтром сложности и античитом)
      if (url.pathname === "/api/arcade/board" && request.method === "GET") {
        const cat = url.searchParams.get("cat");
        const diff = url.searchParams.get("diff") || "all";
        const validCats = ["typing", "clicking", "reaction", "memory"];
        
        if (!validCats.includes(cat)) {
          return Response.json({ error: "Неверная категория" }, { status: 400, headers: corsHeaders });
        }
        
        const order = cat === "reaction" ? "ASC" : "DESC";
        
        // Исключаем читеров (is_suspicious = 0)
        let sql = "SELECT p.callsign, r.value, r.wpm, r.cpm, r.err_pct, r.diff, r.created_at " +
                  "FROM results r JOIN players p ON r.player_id = p.id " +
                  "WHERE r.cat = ? AND p.anon = 0 AND r.is_suspicious = 0";
        
        const args = [cat];

        if (diff !== "all") {
          sql += " AND r.diff = ?";
          args.push(diff);
        }

        sql += " ORDER BY r.value " + order + " LIMIT 100";

        const result = await db.execute({ sql: sql, args: args });
        return Response.json(result.rows, { headers: corsHeaders });
      }

      // 3. Средние значения (для графика)
      if (url.pathname === "/api/arcade/avgs" && request.method === "GET") {
        const cat = url.searchParams.get("cat") || "typing";
        const diff = url.searchParams.get("diff") || "all";
        const order = cat === "reaction" ? "ASC" : "DESC";
        
        let sql = "SELECT AVG(value) as avg_val FROM (" +
                  "SELECT value FROM results WHERE cat = ? AND is_suspicious = 0";
        const args = [cat];

        if (diff !== "all") {
          sql += " AND diff = ?";
          args.push(diff);
        }

        sql += " ORDER BY value " + order + " LIMIT 5)";

        const result = await db.execute({ sql: sql, args: args });
        return Response.json({ avg: result.rows[0].avg_val || 0 }, { headers: corsHeaders });
      }

      // 4. Сохранение результата (с сложностью и античитом)
      if (url.pathname === "/api/arcade/result" && request.method === "POST") {
        const body = await request.json();
        const { callsign, cat, value, wpm, cpm, err_pct, difficulty, is_suspicious } = body;
        
        if (!callsign || !cat || value === undefined) {
          return Response.json({ error: "Отсутствуют обязательные поля" }, { status: 400, headers: corsHeaders });
        }

        // Проверяем игрока
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

        // Записываем результат с учетом новых полей
        await db.execute({
          sql: "INSERT INTO results (player_id, cat, value, wpm, cpm, err_pct, diff, is_suspicious) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            playerId, 
            cat, 
            value, 
            wpm || null, 
            cpm || null, 
            err_pct || null, 
            difficulty || 'medium', 
            is_suspicious ? 1 : 0
          ]
        });
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      // 5. Хартбит (онлайн)
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

      // 6. Пользователь ушел (закрыл вкладку)
      if (url.pathname === "/api/arcade/leave" && request.method === "POST") {
        const body = await request.json();
        const { token } = body;
        if (token) {
          await db.execute({
            sql: "DELETE FROM sessions WHERE token = ?",
            args: [token]
          });
        }
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
