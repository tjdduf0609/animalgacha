// Vercel 서버리스 함수: 가챠 1회 뽑기 + IP별 하루 횟수 제한
// 필요한 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IP_SALT (선택: DAILY_LIMIT, 기본 20)
const crypto = require('crypto');
const { CARDS, ZERO } = require('./_cards.js');

const LIMIT = parseInt(process.env.DAILY_LIMIT || '20', 10);
const RANGE = { R: [1, 10000], SR: [10001, 20000], SSR: [20001, 100000] };

// ---- 한국 시간(KST) 기준 날짜 ----
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function kstDay(d) { return d.toISOString().slice(0, 10); }
function kstStamp(d) { const s = d.toISOString(); return s.slice(0, 10) + ' ' + s.slice(11, 19); }

// ---- IP 정리: IPv6는 /64 단위로 묶어서 주소를 바꿔 우회하기 어렵게 함 ----
function expandIPv6(ip) {
  ip = ip.split('%')[0].toLowerCase();
  const halves = ip.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length > 1 ? 8 - head.length - tail.length : 0;
  const groups = head.concat(Array(Math.max(0, fill)).fill('0'), tail);
  return groups.map((g) => g.padStart(4, '0'));
}
function normalizeIp(raw) {
  let ip = String(raw || '').trim();
  if (!ip) return 'unknown';
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (ip.includes(':')) return 'v6/' + expandIPv6(ip).slice(0, 4).join(':');
  return ip;
}
function getIp(req) {
  const h = req.headers || {};
  const xff = (h['x-forwarded-for'] || '').split(',')[0];
  return normalizeIp(h['x-vercel-forwarded-for'] || h['x-real-ip'] || xff);
}
function hashIp(ip) {
  return crypto.createHash('sha256').update(String(process.env.IP_SALT || '') + '|' + ip).digest('hex');
}

// ---- 뽑기 (등급은 카드 이름과 무관하게 매번 따로) ----
function rollRarity() {
  const r = crypto.randomInt(10000);
  return r < 5 ? 'SSR' : (r < 1005 ? 'SR' : 'R');
}
function pull() {
  const name = CARDS[crypto.randomInt(CARDS.length)];
  const rar = rollRarity();
  const [lo, hi] = RANGE[rar];
  const stat = ZERO.has(name) ? 0 : lo + crypto.randomInt(hi - lo + 1);
  return { name, rar, stat };
}

// ---- Supabase (서비스 키는 서버에서만 사용) ----
function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}
async function consume(day, ipHash) {
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/rpc/gacha_consume', {
    method: 'POST', headers: sbHeaders(),
    body: JSON.stringify({ p_day: day, p_ip_hash: ipHash, p_limit: LIMIT }),
  });
  if (!r.ok) throw new Error('rpc ' + r.status);
  const n = await r.json();
  if (typeof n !== 'number') throw new Error('rpc result');
  return n;
}
async function usedToday(day, ipHash) {
  const url = process.env.SUPABASE_URL + '/rest/v1/gacha_usage?select=used&day=eq.' + day + '&ip_hash=eq.' + ipHash;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('select ' + r.status);
  const rows = await r.json();
  return rows.length ? rows[0].used : 0;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.IP_SALT) {
    return res.status(500).json({ error: 'config' });
  }
  const day = kstDay(kstNow());
  const ipHash = hashIp(getIp(req));
  try {
    if (req.method === 'GET') {
      const used = await usedToday(day, ipHash);
      return res.status(200).json({ used, remaining: Math.max(0, LIMIT - used), limit: LIMIT });
    }
    if (req.method === 'POST') {
      const used = await consume(day, ipHash);          // 횟수를 먼저 차감한 뒤에만 뽑기를 진행
      if (used < 0) return res.status(429).json({ error: 'limit', remaining: 0, limit: LIMIT });
      return res.status(200).json(Object.assign(pull(), {
        used, remaining: Math.max(0, LIMIT - used), limit: LIMIT, at: kstStamp(kstNow()),
      }));
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    console.error('gacha api error:', e && e.message);   // IP 등 개인정보는 로그에 남기지 않음
    return res.status(503).json({ error: 'service' });
  }
};

module.exports._test = { normalizeIp, getIp, hashIp, pull, kstDay, LIMIT };
