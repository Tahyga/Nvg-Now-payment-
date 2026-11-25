# NVG MINING — NOWPayments backend

This project keeps the NOWPayments API key and IPN secret on the server. The browser HTML never receives either credential.

## Important security steps

1. The API key previously pasted into chat should be revoked in NOWPayments and replaced with a newly generated key before deployment.
2. Generate an IPN Secret in NOWPayments Store Settings. It is separate from the API key.
3. Put both values into your hosting provider's private Environment Variables / Secrets. Never put them in `index.html`, Git, localStorage, or a public client bundle.
4. Use HTTPS and set `APP_BASE_URL` to the exact public origin of this app.
5. Configure the Supabase URL and anon/publishable key. Backend endpoints require a valid Supabase login token; the local-only demo login cannot create payments.

## Run locally

```bash
cp .env.example .env
# Edit .env and enter the rotated API key, IPN secret, Supabase URL/key and APP_BASE_URL
npm install
npm start
```

Serve `../nvg_mining_updated.html` from the same origin as this API (or configure a reverse proxy so `/api/*` reaches this server). The app uses `/api/payments/create` and `/api/nowpayments/ipn`.

## Supported payment networks

- USDT TRC20 -> NOWPayments currency code `usdttrc20`
- USDT BEP20 / BNB Smart Chain -> NOWPayments currency code `usdtbsc`

Minimum app deposit is $10. NOWPayments may still impose a dynamic minimum based on network and currency conditions.

## IPN

Set the NOWPayments IPN callback URL to:

`https://YOUR-DOMAIN.example/api/nowpayments/ipn`

The backend verifies `x-nowpayments-sig` using HMAC-SHA512 and the separate IPN Secret. It records a credit once only after a matching payment is reported `finished`. The server database is the authoritative ledger; the legacy browser-only wallet display still needs to be migrated to read this ledger before balances can be treated as fully synchronized.

## Withdrawals

Automatic withdrawals are intentionally disabled. NOWPayments documents Mass Payouts as a separate product/workflow involving account authentication, payout creation and a 2FA verification step. The ordinary payment API key alone is not enough to safely assume automatic payouts are enabled. Do not enable payouts until that separate product is approved, funded, tested, and its verification flow is implemented.

## Admin stats

`GET /api/admin/stats` requires a valid Supabase session and the authenticated email `misterabout2@gmail.com`. It reports only payment records stored by this backend; it does not claim to be a complete app-wide user/mining report.

## Production notes

- Use a persistent disk for `DB_PATH` because SQLite data must survive restarts.
- Add a database backup and monitoring process.
- Restrict CORS at your reverse proxy if frontend and backend are hosted on different origins.
- Add server-side wallet/plan accounting and audit review before treating this as a real-money mining platform. The frontend's previous local wallet values are not a financial ledger.
