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

io.on('connection', (socket) => {
  socket.emit('stateUpdate', state);

  socket.on('login', (username) => {
    if (!username) return;
    if (!state.users[username]) {
      state.users[username] = { points: 0 };
    }
    saveAndBroadcast();
  });

  socket.on('startGame', ({ targetCount }) => {
    state.game = {
      status: 'playing',
      targetCount: Number(targetCount) || 2,
      participants: [],
      inputs: {}
    };
    saveAndBroadcast();
  });

  socket.on('joinGame', (username) => {
    if (state.game.status !== 'playing') return;
    if (!state.game.participants.includes(username) && state.game.participants.length < state.game.targetCount) {
      state.game.participants.push(username);
      saveAndBroadcast();
    }
  });

  socket.on('submitInput', ({ username, a, b, c }) => {
    if (!state.game.participants.includes(username)) return;
    state.game.inputs[username] = { a: Number(a), b: Number(b), c: Number(c) };

    if (Object.keys(state.game.inputs).length === state.game.targetCount) {
      calculateScores();
    } else {
      saveAndBroadcast();
    }
  });

  socket.on('adminAction', ({ type, targetUser, amount }) => {
    if (type === 'resetAll') {
      Object.keys(state.users).forEach(u => state.users[u].points = 0);
      state.game.status = 'waiting';
    } else if (type === 'adjust' && state.users[targetUser]) {
      state.users[targetUser].points += Number(amount);
    } else if (type === 'forceResetGame') {
      state.game.status = 'waiting';
    }
    saveAndBroadcast();
  });
});

function calculateScores() {
  const N = state.game.targetCount;
  const sorted = Object.entries(state.game.inputs).sort((x, y) => x[1].a - y[1].a);

  const half = Math.floor(N / 2);
  const isOdd = N % 2 !== 0;

  sorted.forEach(([username, val], index) => {
    const delta = val.b * val.c;
    if (index < half) {
      state.users[username].points += delta;
    } else if (isOdd && index === half) {
      // 奇数時の真ん中は増減なし
    } else {
      state.users[username].points -= delta;
    }
  });

  state.game.status = 'waiting';
  saveAndBroadcast();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
