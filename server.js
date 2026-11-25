import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const required = ['NOWPAYMENTS_API_KEY','NOWPAYMENTS_IPN_SECRET','SUPABASE_URL','SUPABASE_ANON_KEY','APP_BASE_URL'];
const missing = required.filter(k => !process.env[k]);
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '64kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 50, standardHeaders: 'draft-7', legacyHeaders: false }));
const db = new Database(process.env.DB_PATH || './nvg.sqlite');
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS deposits (
  payment_id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
  amount_usd REAL NOT NULL, network TEXT NOT NULL, pay_currency TEXT NOT NULL,
  pay_address TEXT, pay_amount TEXT, status TEXT NOT NULL, credited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, payment_id TEXT NOT NULL UNIQUE,
  amount_usd REAL NOT NULL, kind TEXT NOT NULL DEFAULT 'deposit', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } }) : null;

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'hex'); const bb = Buffer.from(String(b || ''), 'hex');
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((o,k) => { o[k] = sortObject(value[k]); return o; }, {});
  return value;
}
function verifyIpn(body, signature) {
  const canonical = JSON.stringify(sortObject(body));
  const expected = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET).update(canonical).digest('hex');
  return safeEqual(expected, signature);
}
async function requireUser(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token || !supabase) return res.status(401).json({ error: 'Sign in with the connected Supabase account first.' });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired login session.' });
    req.user = data.user; next();
  } catch { res.status(401).json({ error: 'Authentication failed.' }); }
}
function requireAdmin(req, res, next) {
  if ((req.user?.email || '').toLowerCase() !== 'misterabout2@gmail.com') return res.status(403).json({ error: 'Administrator access required.' });
  next();
}
app.get('/api/health', (_req,res) => res.json({ ok:true, provider:'NOWPayments', nowpaymentsConfigured:!!(process.env.NOWPAYMENTS_API_KEY && process.env.NOWPAYMENTS_IPN_SECRET), missing: process.env.NODE_ENV === 'development' ? missing : undefined }));

app.post('/api/payments/create', requireUser, async (req,res) => {
  try {
    if (!process.env.NOWPAYMENTS_API_KEY || !process.env.NOWPAYMENTS_IPN_SECRET) return res.status(503).json({ error:'Payment gateway is not configured on the server.' });
    const amount = Number(req.body?.amount);
    const network = req.body?.network;
    if (!Number.isFinite(amount) || amount < 10 || amount > 100000 || !['TRC20','BEP20'].includes(network)) return res.status(400).json({ error:'Choose at least 10 USDT and a supported network.' });
    const orderId = `NVG-${crypto.randomUUID()}`;
    const payCurrency = network === 'TRC20' ? 'usdttrc20' : 'usdtbsc';
    const upstream = await fetch('https://api.nowpayments.io/v1/payment', {
      method:'POST', headers:{ 'x-api-key':process.env.NOWPAYMENTS_API_KEY, 'Content-Type':'application/json' },
      body:JSON.stringify({ price_amount:amount, price_currency:'usd', pay_currency:payCurrency,
        ipn_callback_url:`${process.env.APP_BASE_URL.replace(/\/$/,'')}/api/nowpayments/ipn`,
        order_id:orderId, order_description:`NVG MINING user deposit ${network}` })
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return res.status(502).json({ error:payload.message || payload.status || 'NOWPayments could not create the payment.' });
    const paymentId = String(payload.payment_id || '');
    if (!paymentId || !payload.pay_address) return res.status(502).json({ error:'NOWPayments returned an incomplete payment response.' });
    db.prepare(`INSERT INTO deposits(payment_id,order_id,user_id,amount_usd,network,pay_currency,pay_address,pay_amount,status) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(paymentId,orderId,req.user.id,amount,network,payCurrency,payload.pay_address,String(payload.pay_amount || ''),String(payload.payment_status || 'waiting'));
    res.status(201).json({ payment_id:paymentId, payment_status:payload.payment_status, pay_address:payload.pay_address, pay_amount:payload.pay_amount, pay_currency:payload.pay_currency, order_id:orderId });
  } catch (e) { console.error('Create payment error:', e); res.status(500).json({ error:'Unable to create payment right now.' }); }
});

app.post('/api/nowpayments/ipn', (req,res) => {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    if (!verifyIpn(req.body, signature)) return res.status(401).send('Invalid signature');
    const paymentId = String(req.body.payment_id || '');
    const status = String(req.body.payment_status || '').toLowerCase();
    const orderId = String(req.body.order_id || '');
    if (!paymentId || !orderId) return res.status(400).send('Missing payment identifiers');
    const payment = db.prepare('SELECT * FROM deposits WHERE payment_id=? AND order_id=?').get(paymentId,orderId);
    if (!payment) return res.status(404).send('Unknown payment');
    const update = db.prepare('UPDATE deposits SET status=?, updated_at=CURRENT_TIMESTAMP WHERE payment_id=?');
    update.run(status,paymentId);
    // Credit only a verified, finished, correctly matched payment; unique payment_id prevents duplicate credits.
    if (status === 'finished' && !payment.credited && Number(req.body.price_amount) === Number(payment.amount_usd) && String(req.body.pay_currency || '').toLowerCase() === payment.pay_currency) {
      const tx = db.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO ledger(user_id,payment_id,amount_usd) VALUES(?,?,?)').run(payment.user_id,paymentId,payment.amount_usd);
        db.prepare('UPDATE deposits SET credited=1, updated_at=CURRENT_TIMESTAMP WHERE payment_id=?').run(paymentId);
      });
      tx();
    }
    res.status(200).send('OK');
  } catch (e) { console.error('IPN error:', e); res.status(500).send('IPN processing failed'); }
});

app.get('/api/admin/stats', requireUser, requireAdmin, (_req,res) => {
  const deposits = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(amount_usd),0) total FROM deposits WHERE status='finished'`).get();
  const pending = db.prepare(`SELECT COUNT(*) count FROM deposits WHERE status NOT IN ('finished','failed','expired','refunded')`).get();
  const credits = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(amount_usd),0) total FROM ledger`).get();
  res.json({ completedDeposits:deposits.count, completedDepositUsd:deposits.total, pendingDeposits:pending.count, ledgerEntries:credits.count, creditedUsd:credits.total });
});

// Payouts deliberately remain disabled: NOWPayments Mass Payouts is a separate flow with account authentication and 2FA verification.
app.post('/api/withdrawals', requireUser, (_req,res) => res.status(501).json({ error:'Payouts are not enabled. Configure and test the separate NOWPayments Mass Payouts API and 2FA flow before enabling withdrawals.' }));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`NVG backend listening on ${port}; secrets loaded: ${!missing.length}`));
