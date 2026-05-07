# Cipher — Private Real-Time Messenger

A self-hosted, end-to-end private one-to-one chat application.
Messages and media auto-delete after **48 hours**.

---

## Project Structure

```
chat-app/
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js
└── backend/
    ├── server.js
    ├── package.json
    ├── .env.example
    ├── models/
    │   ├── User.js
    │   └── Message.js
    ├── routes/
    │   ├── auth.js
    │   ├── users.js
    │   └── messages.js
    ├── middleware/
    │   ├── auth.js
    │   └── upload.js
    └── uploads/          ← auto-created, stores media files
```

---

## Requirements

| Tool       | Version     |
|------------|-------------|
| Node.js    | ≥ 18.x      |
| npm        | ≥ 9.x       |
| MongoDB    | ≥ 6.x       |

---

## Local Development Setup

### 1. Clone / copy the project

```bash
# If using git
git clone <your-repo-url> chat-app
cd chat-app/backend
```

### 2. Install dependencies

```bash
cd backend
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
nano .env        # or use any editor
```

Edit `.env`:

```env
PORT=3000
NODE_ENV=development
MONGODB_URI=mongodb://127.0.0.1:27017/chatapp
JWT_SECRET=change_this_to_a_random_64_char_string_like_xK9mP2qR...
JWT_EXPIRES_IN=7d
MAX_FILE_SIZE=52428800
UPLOADS_DIR=uploads
MESSAGE_TTL_HOURS=48
```

> **IMPORTANT:** Generate a real secret:
> ```bash
> node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
> ```

### 4. Start MongoDB (local)

```bash
# Ubuntu / Debian
sudo systemctl start mongod

# macOS (Homebrew)
brew services start mongodb-community

# Or run directly
mongod --dbpath /data/db
```

### 5. Run the app

```bash
# From the backend directory
npm start

# Or with auto-reload during development
npm run dev
```

Open your browser at: **http://localhost:3000**

---

## VPS / Production Deployment

### Step 1 — Server prerequisites

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install MongoDB 7.x
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor

echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] \
  https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list

sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod

# Install PM2 globally
sudo npm install -g pm2
```

### Step 2 — Upload project files

```bash
# From your local machine
scp -r chat-app/ user@your-vps-ip:/home/user/

# Or use rsync
rsync -avz chat-app/ user@your-vps-ip:/home/user/chat-app/
```

### Step 3 — Install dependencies on VPS

```bash
ssh user@your-vps-ip
cd /home/user/chat-app/backend
npm install --production
```

### Step 4 — Create production .env

```bash
cp .env.example .env
nano .env
```

```env
PORT=3000
NODE_ENV=production
MONGODB_URI=mongodb://127.0.0.1:27017/chatapp
JWT_SECRET=<your-64-char-random-secret>
JWT_EXPIRES_IN=7d
MAX_FILE_SIZE=52428800
UPLOADS_DIR=uploads
MESSAGE_TTL_HOURS=48
```

### Step 5 — Start with PM2

```bash
cd /User/user/chat-app/backend

# Start the app
pm2 start server.js --name cipher-chat

# Save PM2 process list (so it survives reboots)
pm2 save

# Enable PM2 on system startup
pm2 startup
# → Copy and run the command it prints

# View logs
pm2 logs cipher-chat

# Monitor
pm2 monit
```

### Step 6 — Nginx reverse proxy (recommended)

```bash
sudo apt install -y nginx

sudo nano /etc/nginx/sites-available/cipher
```

Paste:

```nginx
server {
    listen 80;
    server_name your-domain.com;    # ← change this

    client_max_body_size 55M;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/cipher /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Step 7 — HTTPS with Let's Encrypt (optional but recommended)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## PM2 Useful Commands

```bash
pm2 list                    # List all processes
pm2 logs cipher-chat        # View live logs
pm2 restart cipher-chat     # Restart app
pm2 stop cipher-chat        # Stop app
pm2 delete cipher-chat      # Remove from PM2
pm2 monit                   # Live dashboard
```

---

## MongoDB Maintenance

```bash
# Connect to MongoDB shell
mongosh chatapp

# View collections
show collections

# Count messages
db.messages.countDocuments()

# Manually clear expired messages (TTL index handles this automatically)
db.messages.deleteMany({ expiresAt: { $lt: new Date() } })

# Check TTL index
db.messages.getIndexes()
```

---

## Security Notes

- **JWT_SECRET** must be at least 32 characters, ideally 64+. Never commit `.env` to git.
- File uploads are validated by MIME type and size (50MB max).
- Rate limiting: 20 auth requests / 15 min, 120 API requests / min.
- MongoDB runs locally (127.0.0.1) — not exposed to the internet.
- All routes are protected by JWT middleware except `/api/auth/login` and `/api/auth/register`.

---

## Features Summary

| Feature                  | Details                                    |
|--------------------------|--------------------------------------------|
| Auth                     | JWT + bcrypt (12 rounds)                   |
| Real-time messaging      | Socket.io (WebSocket)                      |
| Media sharing            | Images (jpg/png/webp), Videos (mp4/webm)   |
| Max media size           | 50 MB                                      |
| Message expiry           | 48 hours (MongoDB TTL index)               |
| File cleanup             | Cron job every hour                        |
| Typing indicators        | Real-time                                  |
| Read receipts            | ✓                                          |
| Online/offline status    | ✓                                          |
| Dark mode                | Always on                                  |
| Mobile responsive        | ✓                                          |
| Rate limiting            | express-rate-limit                         |
| Input sanitization       | ✓                                          |

---

## Troubleshooting

**App won't start:**
```bash
pm2 logs cipher-chat --lines 50
```

**MongoDB connection refused:**
```bash
sudo systemctl status mongod
sudo systemctl start mongod
```

**Port 3000 already in use:**
```bash
lsof -i :3000
# Change PORT in .env
```

**Socket.io connection fails behind Nginx:**
Make sure your Nginx config includes the `Upgrade` and `Connection` headers (shown above).

**Uploads not served:**
The `uploads/` folder is created automatically. Check permissions:
```bash
chmod 755 /User/user/chat-app/backend/uploads
```
