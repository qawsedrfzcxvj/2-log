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
  users: {}, 
  game: {
    status: 'waiting',
    targetCount: 4,
    participants: [],
    inputs: {}
  }
};

// 起動時にデータ読み込み（エラーや空ファイル対策を追加）
if (fs.existsSync(DATA_FILE)) {
  try {
    const fileContent = fs.readFileSync(DATA_FILE, 'utf8');
    if (fileContent.trim()) {
      const parsed = JSON.parse(fileContent);
      // 必要なプロパティが欠けている場合に備えてマージ
      state.users = parsed.users || {};
      state.game = parsed.game || state.game;
    }
  } catch (e) {
    console.log('data.jsonの読み込みに失敗したため、初期状態から開始します。');
  }
}

function saveAndBroadcast() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state));
  io.emit('stateUpdate', state);
}

io.on('connection', (socket) => …
