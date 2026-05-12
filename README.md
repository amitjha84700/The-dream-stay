# The Dream Residency

A complete boutique-hotel website + admin panel built with Node.js, Express and SQLite.

## Features
- **Public site** — hotel info, 3 fixed room categories (Suite / Deluxe / Twin Bed) with Read-More modals, booking-request form with country-code phone, dynamic per-guest fields, future-only dates, animated success overlay
- **Admin panel** — booking requests, walk-in / check-in with guest history, visitor analytics, site content editor, room types editor, room inventory, customers (edit-only), bookings with multi-guest + per-guest documents, payments tracker, weekly/monthly/yearly reports + CSV export
- **Auto-pricing** — `total = nights × room price × rooms_count`, computed server-side
- **SMTP auto-detect** — host/port auto-filled for Gmail, Outlook/Office365, Yahoo, Zoho, iCloud
- **Cloud image links** — Google Drive and Dropbox share URLs are auto-normalized

## Local development

```bash
npm install
npm start
```

Then open <http://localhost:5000>.

Admin panel:

- URL: `/admin-dream/login`
- User: `Harsh@2003`
- Password: `Dream@2010`

## Deploying to Render

1. Push this folder to a GitHub repo.
2. On <https://render.com> click **New → Web Service** and connect your repo.
3. Use these settings:
   - **Environment:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** any (free tier works)
4. (Optional) Add a **Disk** so SQLite data and uploaded documents survive
   restarts:
   - Mount path: `/opt/render/project/src` (the project root)
   - Size: 1 GB+
5. Click **Create Web Service**. Render will install dependencies, start the
   server on its `PORT` env variable and give you a `https://*.onrender.com`
   URL.

> ⚠️ Without a persistent disk, Render's filesystem is wiped on every deploy,
> meaning `data.db` and `uploads/` will be lost. Always attach a disk for
> production use.

## Stack

- Node.js 20+
- Express 5
- better-sqlite3
- multer (file uploads)
- nodemailer (booking emails)
- express-session + cookie-parser

## Project layout

```
server.js              — Express app + all API routes + SQLite schema
public/index.html      — public hotel website
public/admin.html      — admin panel SPA
public/styles.css      — shared styles
uploads/               — uploaded ID documents and images (created at runtime)
data.db                — SQLite database (created at runtime)
package.json
```
