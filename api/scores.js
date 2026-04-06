// api/scores.js — Vercel Serverless Function
// Fetches Masters leaderboard from ESPN + masters.com fallback
// Also writes scores directly to Supabase if SUPABASE keys are set

export default async function handler(req, res) {
  // CORS headers so your frontend can call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');

  try {
    let scores = [];
    let source = '';
    let eventName = '';

    // Try masters.com first (best data during tournament)
    try {
      const mastersRes = await fetch('https://www.masters.com/en_US/scores/feeds/2026/scores.json', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      if (mastersRes.ok) {
        const data = await mastersRes.json();
        source = 'masters.com';
        eventName = 'Masters Tournament 2026';
        // masters.com format: data.data.player[] with properties like
        // first_name, last_name, today, topar, thru, status, round1, round2, etc.
        const players = data?.data?.player || data?.data?.players || [];
        if (Array.isArray(players) && players.length > 0) {
          scores = players.map(p => {
            const name = `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.display_name || p.name || '';
            let toPar = 0;
            if (p.topar !== undefined && p.topar !== null && p.topar !== '') {
              if (p.topar === 'E') toPar = 0;
              else toPar = parseInt(p.topar) || 0;
            }
            const status = (p.status || '').toLowerCase();
            const isCut = status === 'cut' || status === 'wd' || status === 'withdrawn' || status === 'mdf';
            return { name, score: toPar, is_cut: isCut, pos: p.pos || p.position || '', thru: p.thru || '', today: p.today || '', status };
          }).filter(s => s.name);
        }
      }
    } catch (e) {
      // masters.com not available yet, fall through to ESPN
    }

    // Fallback: ESPN PGA scoreboard
    if (scores.length === 0) {
      const espnRes = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard');
      if (espnRes.ok) {
        const data = await espnRes.json();
        source = 'espn.com';
        // Find Masters event
        const evt = (data.events || []).find(e =>
          (e.name || '').toLowerCase().includes('masters') ||
          (e.shortName || '').toLowerCase().includes('masters')
        );
        if (evt) {
          eventName = evt.name || 'Masters Tournament';
          const comp = evt.competitions?.[0];
          const competitors = comp?.competitors || [];
          scores = competitors.map(c => {
            const name = c.athlete?.displayName || '';
            const status = (c.status?.type?.name || '').toLowerCase();
            const isCut = status === 'cut' || status === 'wd';
            let toPar = 0;
            // Try score field
            if (c.score) {
              if (c.score === 'E') toPar = 0;
              else if (c.score.startsWith('+') || c.score.startsWith('-')) toPar = parseInt(c.score);
            }
            // Try statistics
            for (const stat of (c.statistics || [])) {
              if (stat.name === 'scoreToPar' || stat.abbreviation === 'TOPAR') {
                const val = stat.displayValue || stat.value;
                if (val === 'E') toPar = 0;
                else toPar = parseInt(val) || 0;
              }
            }
            const pos = c.status?.position?.displayName || '';
            const thru = c.status?.thru?.toString() || '';
            return { name, score: isCut ? 10 : toPar, is_cut: isCut, pos, thru, today: '', status };
          }).filter(s => s.name);
        }
      }
    }

    // Fallback: SportRadar via our built-in tool can't be used here,
    // but the two sources above should cover it

    // If SUPABASE env vars are set, also write to the database
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_KEY;
    let dbUpdated = false;

    if (sbUrl && sbKey && scores.length > 0) {
      try {
        const rows = scores.map(s => ({
          group_id: 'lamivoie',
          golfer_name: s.name,
          score: s.is_cut ? 10 : s.score,
          is_cut: s.is_cut
        }));

        const upsertRes = await fetch(`${sbUrl}/rest/v1/golfer_scores`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': sbKey,
            'Authorization': `Bearer ${sbKey}`,
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify(rows)
        });
        dbUpdated = upsertRes.ok;
      } catch (e) {
        // DB write failed silently — scores still returned to frontend
      }
    }

    return res.status(200).json({
      success: true,
      source,
      event: eventName,
      count: scores.length,
      db_updated: dbUpdated,
      updated_at: new Date().toISOString(),
      scores
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
