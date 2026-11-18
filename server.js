const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const DATA_FILE = './data.json';

// 初期データ構造
let state = {
  users: {}, // { username: { points: 0 } }
  game: {
    status: 'waiting', // 'waiting' | 'playing'
    targetCount: 4,
    participants: [], // [username1, username2, ...]
    inputs: {}        // { username: { a: 順位, b: 枚数, c: サイコロ } }
  }
};

// 起動時にデータ読み込み
if (fs.existsSync(DATA_FILE)) {
  try { state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
}

function saveAndBroadcast() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state));
  io.emit('stateUpdate', state);
}

io.on('connection', (socket) => {
  socket.emit('stateUpdate', state);

  // アカウント登録・ログイン
  socket.on('login', (username) => {
    if (!username) return;
    if (!state.users…
