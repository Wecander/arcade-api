import { createClient } from '@libsql/client/web';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const db = createClient({
      url: env.TURSO_URL,
      authToken: env.TURSO_TOKEN,
    });

    try {
      // Ваш существующий код (онлайн, таблица лидеров, сохранение результата и т.д.)
      // ... 
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
    }
  }
};
