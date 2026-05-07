/* ══════════════════════════════════════════════════════════
   CIPHER — app.js  (Vanilla JS, no dependencies)
══════════════════════════════════════════════════════════ */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const State = {
  token: localStorage.getItem('cipher_token') || null,
  user:  JSON.parse(localStorage.getItem('cipher_user') || 'null'),
  activeChat: null,        // { _id, username, isOnline }
  recentChats: JSON.parse(localStorage.getItem('cipher_recents') || '[]'),
  messages: {},            // conversationId -> []
  unread: {},              // userId -> count
  socket: null,
  typingTimers: {},
  searchDebounce: null,
  pendingMedia: null,      // { file, objectUrl, type }
  loadingMore: false,
  hasMoreMessages: {},
};

// ─── DOM shortcuts ────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

// ─── API helper ───────────────────────────────────────────────────────────────
async function api(method, path, body, isForm = false) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${State.token}` },
  };
  if (body) {
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(`/api${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const t = el('div', `toast ${type}`, msg);
  $('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3100);
}

// ─── Avatar initials ──────────────────────────────────────────────────────────
function initials(name) {
  return (name || '?').slice(0, 2).toUpperCase();
}

function avatarColor(name) {
  const colors = ['#4f6ef7','#7c5ef7','#ef6c6c','#f7a04f','#4fc3f7','#81c784','#f06292'];
  let h = 0;
  for (const c of (name || '')) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return colors[Math.abs(h) % colors.length];
}

function setAvatarEl(el, name) {
  el.textContent = initials(name);
  el.style.background = avatarColor(name) + '22';
  el.style.color = avatarColor(name);
  el.style.borderColor = avatarColor(name) + '55';
}

// ─── Format time ─────────────────────────────────────────────────────────────
function fmtTime(date) {
  const d = new Date(date);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(date) {
  const d = new Date(date);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1048576).toFixed(1)} MB`;
}

function timeAgo(date) {
  const diff = Date.now() - new Date(date).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}

// ─── Conversation ID ──────────────────────────────────────────────────────────
function convId(a, b) {
  return [a, b].sort().join('_');
}

// ══════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════

function initAuthScreen() {
  // Tabs
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      $('login-form').classList.toggle('hidden', target !== 'login');
      $('register-form').classList.toggle('hidden', target !== 'register');
      $('login-error').textContent = '';
      $('register-error').textContent = '';
    });
  });

  // Enter key on login
  [$('login-email'), $('login-password')].forEach(inp => {
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  });
  [$('reg-username'), $('reg-email'), $('reg-password')].forEach(inp => {
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
  });

  $('login-btn').addEventListener('click', doLogin);
  $('register-btn').addEventListener('click', doRegister);
}

async function doLogin() {
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  const errEl = $('login-error');
  errEl.textContent = '';

  if (!email || !password) { errEl.textContent = 'Please fill in all fields.'; return; }

  const btn = $('login-btn');
  btn.disabled = true;
  btn.classList.add('loading');

  try {
    const data = await api('POST', '/auth/login', { email, password });
    saveSession(data.token, data.user);
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

async function doRegister() {
  const username = $('reg-username').value.trim();
  const email = $('reg-email').value.trim();
  const password = $('reg-password').value;
  const errEl = $('register-error');
  errEl.textContent = '';

  if (!username || !email || !password) { errEl.textContent = 'Please fill in all fields.'; return; }
  if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }

  const btn = $('register-btn');
  btn.disabled = true;
  btn.classList.add('loading');

  try {
    const data = await api('POST', '/auth/register', { username, email, password });
    saveSession(data.token, data.user);
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

function saveSession(token, user) {
  State.token = token;
  State.user = user;
  localStorage.setItem('cipher_token', token);
  localStorage.setItem('cipher_user', JSON.stringify(user));
}

function clearSession() {
  State.token = null;
  State.user = null;
  State.activeChat = null;
  State.recentChats = [];
  State.messages = {};
  State.unread = {};
  localStorage.removeItem('cipher_token');
  localStorage.removeItem('cipher_user');
  localStorage.removeItem('cipher_recents');
  if (State.socket) { State.socket.disconnect(); State.socket = null; }
}

// ══════════════════════════════════════════════════════════
// APP BOOTSTRAP
// ══════════════════════════════════════════════════════════

function showApp() {
  $('auth-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  initApp();
}

function showAuth() {
  $('app-screen').classList.add('hidden');
  $('auth-screen').classList.remove('hidden');
}

function initApp() {
  // Set sidebar user
  const av = $('sidebar-avatar');
  setAvatarEl(av, State.user.username);
  $('sidebar-username').textContent = State.user.username;

  renderRecentChats();
  initSocket();
  initSidebar();
  initChatInput();
  initMobileNav();
}

// ══════════════════════════════════════════════════════════
// SOCKET
// ══════════════════════════════════════════════════════════

function initSocket() {
  if (State.socket) State.socket.disconnect();

  State.socket = io({ auth: { token: State.token } });

  State.socket.on('connect', () => {
    console.log('[Socket] Connected');
  });

  State.socket.on('connect_error', (err) => {
    console.error('[Socket] Connect error:', err.message);
    if (err.message.includes('Authentication')) {
      toast('Session expired. Please log in again.', 'error');
      doLogout();
    }
  });

  State.socket.on('message:new', (msg) => {
    handleIncomingMessage(msg);
  });

  State.socket.on('user:status', ({ userId, isOnline }) => {
    // Update recent chats list
    State.recentChats = State.recentChats.map(u =>
      u._id === userId ? { ...u, isOnline } : u
    );
    renderRecentChats();

    // Update chat header if active
    if (State.activeChat && State.activeChat._id === userId) {
      State.activeChat.isOnline = isOnline;
      updateChatHeader();
    }
  });

  State.socket.on('typing:start', ({ userId, username }) => {
    if (State.activeChat && State.activeChat._id === userId) {
      $('typing-username').textContent = username;
      $('typing-indicator').classList.remove('hidden');
      clearTimeout(State.typingTimers[userId]);
      State.typingTimers[userId] = setTimeout(() => {
        $('typing-indicator').classList.add('hidden');
      }, 3000);
    }
  });

  State.socket.on('typing:stop', ({ userId }) => {
    if (State.activeChat && State.activeChat._id === userId) {
      $('typing-indicator').classList.add('hidden');
      clearTimeout(State.typingTimers[userId]);
    }
  });

  State.socket.on('messages:read', ({ conversationId }) => {
    const cid = State.activeChat
      ? convId(State.user._id, State.activeChat._id)
      : null;
    if (conversationId === cid) {
      markRenderedMessagesRead();
    }
  });

  State.socket.on('error', ({ message }) => {
    toast(message, 'error');
  });

  State.socket.on('disconnect', () => {
    console.log('[Socket] Disconnected');
  });
}

function handleIncomingMessage(msg) {
  const senderId = typeof msg.sender === 'object' ? msg.sender._id : msg.sender;
  const recipientId = typeof msg.recipient === 'object' ? msg.recipient._id : msg.recipient;

  // Determine the other party
  const otherId = senderId === State.user._id ? recipientId : senderId;
  const cid = convId(State.user._id, otherId);

  // Store in messages cache
  if (!State.messages[cid]) State.messages[cid] = [];

  // Avoid duplicates
  const exists = State.messages[cid].some(m => m._id === msg._id);
  if (!exists) {
    State.messages[cid].push(msg);
  }

  // If this is the active chat, render it
  if (State.activeChat && State.activeChat._id === otherId) {
    if (!exists) appendMessage(msg);
    scrollToBottom();
    // Mark as read
    State.socket.emit('messages:read', {
      conversationId: cid,
      senderId: senderId
    });
  } else {
    // Increment unread if incoming
    if (senderId !== State.user._id) {
      State.unread[otherId] = (State.unread[otherId] || 0) + 1;
      renderRecentChats();
      notifySound();
    }
  }

  // Update recent chats with this user
  updateRecentChat(otherId, msg);
}

function notifySound() {
  // Subtle audio cue using Web Audio API
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════
// SIDEBAR
// ══════════════════════════════════════════════════════════

function initSidebar() {
  const searchInput = $('user-search');
  const clearBtn = $('search-clear');

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    clearBtn.classList.toggle('hidden', !q);
    clearTimeout(State.searchDebounce);
    if (!q) {
      $('search-results').classList.add('hidden');
      $('recent-chats').classList.remove('hidden');
      return;
    }
    State.searchDebounce = setTimeout(() => doSearch(q), 250);
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.classList.add('hidden');
    $('search-results').classList.add('hidden');
    $('recent-chats').classList.remove('hidden');
    searchInput.focus();
  });

  $('logout-btn').addEventListener('click', doLogout);
}

async function doSearch(q) {
  try {
    const { users } = await api('GET', `/users/search?q=${encodeURIComponent(q)}`);
    renderSearchResults(users);
  } catch (err) {
    console.error('Search error:', err);
  }
}

function renderSearchResults(users) {
  const container = $('search-results');
  container.innerHTML = '';
  $('recent-chats').classList.add('hidden');

  if (!users.length) {
    container.innerHTML = `<div class="empty-state"><p>No users found</p></div>`;
    container.classList.remove('hidden');
    return;
  }

  const label = el('div', 'list-section-label', 'Results');
  container.appendChild(label);

  users.forEach(u => {
    const item = createUserItem(u);
    container.appendChild(item);
  });

  container.classList.remove('hidden');
}

function renderRecentChats() {
  const list = $('recent-list');
  const noRecent = $('no-recent');
  list.innerHTML = '';

  if (!State.recentChats.length) {
    noRecent.classList.remove('hidden');
    return;
  }
  noRecent.classList.add('hidden');

  State.recentChats.forEach(u => {
    const item = createUserItem(u, true);
    list.appendChild(item);
  });
}

function createUserItem(u, showUnread = false) {
  const item = el('div', 'user-item');
  if (State.activeChat && State.activeChat._id === u._id) {
    item.classList.add('active');
  }

  const avatarDiv = el('div', 'user-item-avatar', initials(u.username));
  avatarDiv.style.background = avatarColor(u.username) + '22';
  avatarDiv.style.color = avatarColor(u.username);

  if (u.isOnline) {
    avatarDiv.appendChild(el('span', 'online-dot'));
  }

  const info = el('div', 'user-item-info');
  const name = el('div', 'user-item-name', escHtml(u.username));

  let metaText = '';
  if (u.lastMsg) {
    metaText = u.lastMsg;
  } else if (u.isOnline) {
    metaText = 'Online';
  } else if (u.lastSeen) {
    metaText = timeAgo(u.lastSeen);
  }

  const meta = el('div', 'user-item-meta', escHtml(metaText));
  info.appendChild(name);
  info.appendChild(meta);

  item.appendChild(avatarDiv);
  item.appendChild(info);

  if (showUnread && State.unread[u._id]) {
    const badge = el('div', 'unread-badge', String(State.unread[u._id]));
    item.appendChild(badge);
  }

  item.addEventListener('click', () => openChat(u));
  return item;
}

function updateRecentChat(userId, msg) {
  const existing = State.recentChats.findIndex(u => u._id === userId);
  const senderId = typeof msg.sender === 'object' ? msg.sender._id : msg.sender;
  const senderName = typeof msg.sender === 'object' ? msg.sender.username : '';

  let lastMsg = '';
  if (msg.mediaType) {
    lastMsg = msg.mediaType === 'image' ? '📷 Image' : '🎬 Video';
  } else if (msg.content) {
    lastMsg = (senderId === State.user._id ? 'You: ' : '') + msg.content.slice(0, 40);
  }

  if (existing >= 0) {
    State.recentChats[existing].lastMsg = lastMsg;
    // Move to top
    const [user] = State.recentChats.splice(existing, 1);
    user.lastMsg = lastMsg;
    State.recentChats.unshift(user);
  } else {
    // Need to fetch user info or use what we have from the message
    const otherId = senderId === State.user._id
      ? (typeof msg.recipient === 'object' ? msg.recipient._id : msg.recipient)
      : senderId;

    if (otherId !== State.user._id) {
      const uname = senderId === State.user._id
        ? (typeof msg.recipient === 'object' ? msg.recipient.username : '')
        : senderName;

      State.recentChats.unshift({ _id: otherId, username: uname, lastMsg });
    }
  }

  saveRecents();
  renderRecentChats();
}

function saveRecents() {
  // Keep max 30 recent chats, only store necessary fields
  const slim = State.recentChats.slice(0, 30).map(u => ({
    _id: u._id, username: u.username, isOnline: u.isOnline, lastMsg: u.lastMsg
  }));
  localStorage.setItem('cipher_recents', JSON.stringify(slim));
}

// ══════════════════════════════════════════════════════════
// CHAT
// ══════════════════════════════════════════════════════════

async function openChat(user) {
  State.activeChat = user;
  State.unread[user._id] = 0;

  // Update sidebar
  document.querySelectorAll('.user-item').forEach(i => i.classList.remove('active'));
  renderRecentChats();

  // Show chat view
  $('chat-empty').classList.add('hidden');
  $('chat-view').classList.remove('hidden');

  // Update header
  updateChatHeader();

  // Clear messages area
  const container = $('messages-container');
  container.innerHTML = '<div class="messages-loader hidden" id="messages-loader">Loading…</div>';

  $('typing-indicator').classList.add('hidden');
  clearPendingMedia();

  // Mobile: hide sidebar
  if (window.innerWidth <= 700) {
    $('sidebar').classList.add('hidden-mobile');
  }

  // Load messages
  await loadMessages(user._id, true);

  // Focus input
  setTimeout(() => $('message-input').focus(), 100);

  // Add to recents if not there
  if (!State.recentChats.find(u => u._id === user._id)) {
    State.recentChats.unshift(user);
    saveRecents();
    renderRecentChats();
  }
}

function updateChatHeader() {
  const u = State.activeChat;
  if (!u) return;

  const av = $('chat-avatar');
  setAvatarEl(av, u.username);
  $('chat-username').textContent = u.username;

  const statusEl = $('chat-status');
  if (u.isOnline) {
    statusEl.textContent = 'Online';
    statusEl.className = 'chat-header-status online';
  } else if (u.lastSeen) {
    statusEl.textContent = `Last seen ${timeAgo(u.lastSeen)}`;
    statusEl.className = 'chat-header-status';
  } else {
    statusEl.textContent = 'Offline';
    statusEl.className = 'chat-header-status';
  }
}

async function loadMessages(userId, fresh = false) {
  const cid = convId(State.user._id, userId);
  const loader = $('messages-loader');

  if (fresh) {
    State.messages[cid] = [];
    State.hasMoreMessages[cid] = false;
  }

  if (loader) loader.classList.remove('hidden');

  try {
    const data = await api('GET', `/messages/${userId}?limit=50`);
    State.messages[cid] = data.messages;
    State.hasMoreMessages[cid] = data.hasMore;

    if (loader) loader.classList.add('hidden');
    renderMessages(cid);
    scrollToBottom(true);

    // Mark as read via socket
    State.socket.emit('messages:read', {
      conversationId: cid,
      senderId: userId
    });
  } catch (err) {
    if (loader) loader.classList.add('hidden');
    console.error('Load messages error:', err);
    toast('Failed to load messages.', 'error');
  }
}

function renderMessages(cid) {
  const container = $('messages-container');
  container.innerHTML = '<div class="messages-loader hidden" id="messages-loader"></div>';

  const messages = State.messages[cid] || [];
  if (!messages.length) {
    const empty = el('div', 'empty-state');
    empty.style.position = 'absolute';
    empty.style.top = '50%';
    empty.style.left = '50%';
    empty.style.transform = 'translate(-50%,-50%)';
    empty.style.width = '100%';
    empty.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <p>No messages yet. Say hello! 👋</p>`;
    container.style.position = 'relative';
    container.appendChild(empty);
    return;
  }
  container.style.position = '';

  let lastDate = null;
  let lastSenderId = null;

  messages.forEach((msg, idx) => {
    const msgDate = fmtDate(msg.createdAt);
    if (msgDate !== lastDate) {
      container.appendChild(el('div', 'date-separator', msgDate));
      lastDate = msgDate;
      lastSenderId = null;
    }

    const senderId = typeof msg.sender === 'object' ? msg.sender._id : msg.sender;
    const isOut = senderId === State.user._id;
    const isFirst = senderId !== lastSenderId;
    const isLast = idx === messages.length - 1 ||
      (() => {
        const nextSenderId = typeof messages[idx+1]?.sender === 'object'
          ? messages[idx+1].sender._id : messages[idx+1]?.sender;
        return nextSenderId !== senderId;
      })();

    const row = buildMsgRow(msg, isOut, isFirst, isLast);
    container.appendChild(row);
    lastSenderId = senderId;
  });
}

function appendMessage(msg) {
  const container = $('messages-container');
  const messages = State.messages[convId(State.user._id, State.activeChat._id)] || [];
  const idx = messages.length - 1;
  const senderId = typeof msg.sender === 'object' ? msg.sender._id : msg.sender;
  const isOut = senderId === State.user._id;

  // Remove empty-state if present
  container.querySelectorAll('.empty-state').forEach(e => e.remove());
  container.style.position = '';

  // Date separator if needed
  const lastMsg = messages[idx - 1];
  if (!lastMsg || fmtDate(lastMsg.createdAt) !== fmtDate(msg.createdAt)) {
    container.appendChild(el('div', 'date-separator', fmtDate(msg.createdAt)));
  }

  const row = buildMsgRow(msg, isOut, true, true);
  container.appendChild(row);
}

function buildMsgRow(msg, isOut, isFirst, isLast) {
  const senderId = typeof msg.sender === 'object' ? msg.sender._id : msg.sender;
  const senderName = typeof msg.sender === 'object' ? msg.sender.username : '';

  const row = el('div', `msg-row ${isOut ? 'out' : 'in'}${isFirst ? ' first' : ''}${isLast ? ' last show-avatar' : ''}`);
  row.dataset.msgId = msg._id;

  // Avatar (only for incoming, last in group)
  const avatar = el('div', 'msg-avatar', initials(senderName));
  avatar.style.background = avatarColor(senderName) + '22';
  avatar.style.color = avatarColor(senderName);

  const bubble = el('div', 'msg-bubble');

  if (msg.mediaUrl) {
    const mediawrap = el('div', 'msg-media');
    if (msg.mediaType === 'image') {
      const img = el('img');
      img.src = msg.mediaUrl;
      img.alt = 'image';
      img.loading = 'lazy';
      img.addEventListener('click', () => openLightbox('image', msg.mediaUrl));
      mediawrap.appendChild(img);
    } else if (msg.mediaType === 'video') {
      const vid = el('video');
      vid.src = msg.mediaUrl;
      vid.controls = true;
      vid.preload = 'metadata';
      vid.addEventListener('click', (e) => {
        e.preventDefault();
        openLightbox('video', msg.mediaUrl);
      });
      mediawrap.appendChild(vid);
    }
    bubble.appendChild(mediawrap);
    if (msg.content) {
      bubble.appendChild(el('div', null, escHtml(msg.content)));
    }
  } else {
    bubble.innerHTML = formatMessageText(msg.content);
  }

  // Time + read
  const timeEl = el('div', 'msg-time');
  timeEl.innerHTML = `<span>${fmtTime(msg.createdAt)}</span>`;
  if (isOut && msg.read) {
    timeEl.innerHTML += `<svg class="msg-read" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg>`;
  }

  const wrap = el('div');
  wrap.appendChild(bubble);
  wrap.appendChild(timeEl);

  if (isOut) {
    row.appendChild(wrap);
    row.appendChild(avatar);
  } else {
    row.appendChild(avatar);
    row.appendChild(wrap);
  }

  return row;
}

function markRenderedMessagesRead() {
  document.querySelectorAll('.msg-row.out .msg-time').forEach(t => {
    if (!t.querySelector('.msg-read')) {
      t.innerHTML += `<svg class="msg-read" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg>`;
    }
  });
}

function formatMessageText(text) {
  if (!text) return '';
  // URLs
  const urlRegex = /https?:\/\/[^\s<>"]+/g;
  return escHtml(text).replace(urlRegex, url =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

function scrollToBottom(instant = false) {
  const wrap = $('messages-wrap');
  if (!wrap) return;
  if (instant) {
    wrap.scrollTop = wrap.scrollHeight;
  } else {
    wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
  }
}

// ══════════════════════════════════════════════════════════
// CHAT INPUT
// ══════════════════════════════════════════════════════════

function initChatInput() {
  const input = $('message-input');
  const sendBtn = $('send-btn');
  const mediaInput = $('media-input');

  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    sendBtn.disabled = !input.value.trim() && !State.pendingMedia;
    handleTyping();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSendMessage();
    }
  });

  sendBtn.addEventListener('click', doSendMessage);

  mediaInput.addEventListener('change', () => {
    const file = mediaInput.files[0];
    if (!file) return;
    handleMediaSelect(file);
    mediaInput.value = '';
  });

  $('media-remove-btn').addEventListener('click', clearPendingMedia);
}

let typingTimeout = null;
let isTyping = false;

function handleTyping() {
  if (!State.activeChat || !State.socket) return;

  if (!isTyping) {
    isTyping = true;
    State.socket.emit('typing:start', { recipientId: State.activeChat._id });
  }

  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    isTyping = false;
    State.socket.emit('typing:stop', { recipientId: State.activeChat._id });
  }, 1500);
}

function stopTyping() {
  if (isTyping) {
    isTyping = false;
    clearTimeout(typingTimeout);
    if (State.socket && State.activeChat) {
      State.socket.emit('typing:stop', { recipientId: State.activeChat._id });
    }
  }
}

async function doSendMessage() {
  if (!State.activeChat) return;

  const input = $('message-input');
  const content = input.value.trim();

  if (!content && !State.pendingMedia) return;

  stopTyping();
  $('send-btn').disabled = true;

  // If there's pending media, upload it first
  if (State.pendingMedia) {
    await doSendMedia(content);
    return;
  }

  // Text-only message via socket
  input.value = '';
  input.style.height = 'auto';

  State.socket.emit('message:send', {
    recipientId: State.activeChat._id,
    content
  });
}

async function doSendMedia(caption = '') {
  if (!State.pendingMedia || !State.activeChat) return;

  const formData = new FormData();
  formData.append('media', State.pendingMedia.file);

  const input = $('message-input');
  input.value = '';
  input.style.height = 'auto';

  const previewWrap = $('media-preview-wrap');
  previewWrap.style.opacity = '0.5';

  try {
    const { message } = await api('POST', `/messages/media/${State.activeChat._id}`, formData, true);

    clearPendingMedia();

    // Notify via socket so the recipient gets it
    State.socket.emit('media:sent', message);

    // Also add to local state (the socket event will handle dedup)
    const cid = convId(State.user._id, State.activeChat._id);
    if (!State.messages[cid]) State.messages[cid] = [];
    const exists = State.messages[cid].some(m => m._id === message._id);
    if (!exists) {
      State.messages[cid].push(message);
      appendMessage(message);
      scrollToBottom();
    }

    updateRecentChat(State.activeChat._id, message);
  } catch (err) {
    toast(err.message || 'Failed to send media.', 'error');
    clearPendingMedia();
  } finally {
    $('send-btn').disabled = false;
  }
}

function handleMediaSelect(file) {
  const MAX = 50 * 1024 * 1024;
  const allowed = ['image/jpeg','image/jpg','image/png','image/webp','video/mp4','video/webm'];

  if (!allowed.includes(file.type)) {
    toast('Invalid file type. Use JPG, PNG, WEBP, MP4, or WEBM.', 'error');
    return;
  }
  if (file.size > MAX) {
    toast('File too large. Maximum 50MB.', 'error');
    return;
  }

  const objectUrl = URL.createObjectURL(file);
  const mediaType = file.type.startsWith('image/') ? 'image' : 'video';

  State.pendingMedia = { file, objectUrl, type: mediaType };

  // Show preview
  const previewWrap = $('media-preview-wrap');
  const previewImg = $('media-preview-img');
  const previewVid = $('media-preview-vid');

  previewImg.classList.add('hidden');
  previewVid.classList.add('hidden');
  previewWrap.style.opacity = '1';

  if (mediaType === 'image') {
    previewImg.src = objectUrl;
    previewImg.classList.remove('hidden');
  } else {
    previewVid.src = objectUrl;
    previewVid.classList.remove('hidden');
  }

  $('media-filename').textContent = file.name.slice(0, 30) + (file.name.length > 30 ? '…' : '');
  $('media-filesize').textContent = fmtFileSize(file.size);
  previewWrap.classList.remove('hidden');
  $('send-btn').disabled = false;
}

function clearPendingMedia() {
  if (State.pendingMedia) {
    URL.revokeObjectURL(State.pendingMedia.objectUrl);
    State.pendingMedia = null;
  }
  $('media-preview-wrap').classList.add('hidden');
  $('media-preview-img').src = '';
  $('media-preview-vid').src = '';
  $('media-filename').textContent = '';
  $('media-filesize').textContent = '';

  const input = $('message-input');
  $('send-btn').disabled = !input.value.trim();
}

// ══════════════════════════════════════════════════════════
// LIGHTBOX
// ══════════════════════════════════════════════════════════

function openLightbox(type, src) {
  const lightbox = $('lightbox');
  const content = $('lightbox-content');
  content.innerHTML = '';

  if (type === 'image') {
    const img = el('img');
    img.src = src;
    content.appendChild(img);
  } else {
    const vid = el('video');
    vid.src = src;
    vid.controls = true;
    vid.autoplay = true;
    content.appendChild(vid);
  }

  lightbox.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const lightbox = $('lightbox');
  const content = $('lightbox-content');
  lightbox.classList.add('hidden');
  content.innerHTML = '';
  document.body.style.overflow = '';
}

// ══════════════════════════════════════════════════════════
// MOBILE NAV
// ══════════════════════════════════════════════════════════

function initMobileNav() {
  $('back-btn').addEventListener('click', () => {
    $('sidebar').classList.remove('hidden-mobile');
    $('chat-view').classList.add('hidden');
    $('chat-empty').classList.remove('hidden');
    State.activeChat = null;
  });

  $('sidebar-overlay').addEventListener('click', () => {
    $('sidebar').classList.add('hidden-mobile');
    $('sidebar-overlay').classList.add('hidden');
  });
}

// ══════════════════════════════════════════════════════════
// LOGOUT
// ══════════════════════════════════════════════════════════

function doLogout() {
  clearSession();
  showAuth();
  // Reset forms
  $('login-email').value = '';
  $('login-password').value = '';
  $('reg-username').value = '';
  $('reg-email').value = '';
  $('reg-password').value = '';
  $('login-error').textContent = '';
  $('register-error').textContent = '';
}

// ══════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════

function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ══════════════════════════════════════════════════════════
// GLOBAL EVENTS
// ══════════════════════════════════════════════════════════

// Lightbox
$('lightbox-close').addEventListener('click', closeLightbox);
$('lightbox').addEventListener('click', e => {
  if (e.target === $('lightbox')) closeLightbox();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeLightbox();
});

// Infinite scroll — load older messages
$('messages-wrap').addEventListener('scroll', async () => {
  const wrap = $('messages-wrap');
  if (wrap.scrollTop < 60 && !State.loadingMore && State.activeChat) {
    const cid = convId(State.user._id, State.activeChat._id);
    if (!State.hasMoreMessages[cid]) return;

    State.loadingMore = true;
    const loader = $('messages-loader');
    if (loader) { loader.textContent = 'Loading older messages…'; loader.classList.remove('hidden'); }

    try {
      const msgs = State.messages[cid] || [];
      const page = Math.ceil(msgs.length / 50) + 1;
      const data = await api('GET', `/messages/${State.activeChat._id}?page=${page}&limit=50`);

      if (data.messages.length) {
        // Prepend to state
        State.messages[cid] = [...data.messages, ...State.messages[cid]];
        State.hasMoreMessages[cid] = data.hasMore;

        // Re-render and preserve scroll position
        const prevHeight = wrap.scrollHeight;
        renderMessages(cid);
        wrap.scrollTop = wrap.scrollHeight - prevHeight;
      } else {
        State.hasMoreMessages[cid] = false;
      }
    } catch (err) {
      console.error('Load more error:', err);
    } finally {
      State.loadingMore = false;
      const l = $('messages-loader');
      if (l) l.classList.add('hidden');
    }
  }
});

// ══════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════

(async function boot() {
  initAuthScreen();

  if (State.token && State.user) {
    // Verify token is still valid
    try {
      await api('GET', '/auth/me');
      showApp();
    } catch (_) {
      clearSession();
      showAuth();
    }
  } else {
    showAuth();
  }
})();
