# Kisan Depot — Shop Management

Shop management app for a fertilizer/seed/pesticide depot. Node.js + Express + PostgreSQL.

## Start the app

Double-click **`start-kisan-depot.bat`** — it opens http://localhost:3000 in your browser.

Or from a terminal:

```
cd C:\Users\harri\kisan-depot
node server.js
```

## Login

The app is protected by a login page.

- Default username: `admin`
- Default password: `kisan123`

**Change the default password after first login** with the 🔑 Change Password button in the sidebar.
Sessions last 12 hours; use 🚪 Logout to sign out sooner.

## Pages

- **Dashboard** — stock value, total profit, 5% profit share, today's sales, cash vs bank received, totals, last-7-days sales chart, low-stock alerts (10 or fewer left).
- **Products** — add products (name, category, unit, description); see purchased/sold/remaining stock and average cost.
- **Purchases** — record stock you buy (product, date, quantity, unit price).
- **Sales** — record sales with payment method and customer details (name, phone, address). Selling more than the remaining stock is blocked.
- **Full Register** — every purchase and sale in one book with all 18 columns: description, date, qty purchased, unit price, total amount, total stock, date, qty sold, sale price, total amount, payment, profit, name, phone, address, remaining stock, 5% of profit, stock price. Filter by product/date and print.
- **Partners** — three business partners (editable names). Record each partner's investments
  per product; a product's profit is split between partners in proportion to what each
  invested in that product. Cards show total invested and each partner's profit.
- **Backup Data** — downloads all data as a JSON file.

## Database

PostgreSQL 17, database `kisan_depot` (user `postgres`, password `postgres`, port 5432).
Tables: `products`, `purchases`, `sales`. Profit is computed as
`qty × (sale price − average purchase cost)` per sale.

To re-create the tables: `node setup-db.js`

Connection settings can be overridden with environment variables:
`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`.
