const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// DB初期化
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
  // ユーザーテーブル（初期100pt）
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      score INTEGER DEFAULT 100
    )
  `);

  // 試合履歴テーブル
  db.run(`
    CREATE TABLE IF NOT EXISTS game_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      username TEXT NOT NULL,
      rank INTEGER NOT NULL,
      point_change INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

app.use(session({
  secret: 'daifugo2_secret_key',
  resave: false,
  saveUninitialized: false
}));

// ログインチェックミドルウェア
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

// 1. ログイン / 新規登録 ページ
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { error: 'ユーザー名とパスワードを入力してください' });
  }

  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err) return res.render('login', { error: 'DBエラーが発生しました' });

    if (user) {
      // 既存ユーザーのログイン
      const match = await bcrypt.compare(password, user.password);
      if (match) {
        req.session.userId = user.id;
        req.session.username = user.username;
        return res.redirect('/');
      } else {
        return res.render('login', { error: 'パスワードが違います' });
      }
    } else {
      // 新規登録
      const hashedPassword = await bcrypt.hash(password, 10);
      db.run('INSERT INTO users (username, password, score) VALUES (?, ?, 100)', [username, hashedPassword], function (err) {
        if (err) return res.render('login', { error: '登録に失敗しました' });
        req.session.userId = this.lastID;
        req.session.username = username;
        return res.redirect('/');
      });
    }
  });
});

// ログアウト
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ダッシュボード（ゲームID入力 & 機能選択）
app.get('/', requireLogin, (req, res) => {
  db.get('SELECT score FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    res.render('dashboard', { username: req.session.username, score: user ? user.score : 100 });
  });
});

// 2 & 3 & 4. ゲームスコア計算画面
app.get('/game', requireLogin, (req, res) => {
  const gameId = req.query.game_id || '';
  res.render('game', { gameId, error: null });
});

// 計算処理API
app.post('/game/calculate', requireLogin, (req, res) => {
  const { game_id, bet, dice, players_data } = req.body;
  
  // players_data は [{ username: string, cards: number, rank: number }] の配列
  const betNum = parseInt(bet, 10);
  const diceNum = parseInt(dice, 10);
  const players = JSON.parse(players_data);
  const totalPlayers = players.length;

  if (isNaN(betNum) || betNum < 10 || betNum % 10 !== 0) {
    return res.status(400).json({ error: '掛け金は10pt以上、10pt刻みで入力してください' });
  }

  // 他プレイヤーの残り枚数合計を算出
  const totalCardsAll = players.reduce((sum, p) => sum + parseInt(p.cards, 10), 0);
  const threshold = Math.floor(totalPlayers / 2);

  let results = [];
  let nonLastTotalPointChange = 0;

  // 1. 最下位以外の点数を計算
  players.forEach(p => {
    const remainingCards = parseInt(p.cards, 10);
    const otherCardsSum = totalCardsAll - remainingCards;
    const rank = parseInt(p.rank, 10);

    if (rank === totalPlayers) {
      // 最下位は後で計算
      return;
    }

    let pointChange = 0;
    if (rank <= threshold) {
      // 早上がり（勝ち）
      pointChange = Math.floor((otherCardsSum + (betNum / 10)) * diceNum);
    } else {
      // 負け（最下位以外）
      pointChange = -Math.floor(otherCardsSum * diceNum);
    }

    nonLastTotalPointChange += pointChange;
    results.push({ username: p.username, rank, pointChange });
  });

  // 2. 最下位の点数を計算（最下位以外の者の点数を合計し、その分を引く）
  const lastPlayer = players.find(p => parseInt(p.rank, 10) === totalPlayers);
  if (lastPlayer) {
    const lastPointChange = -nonLastTotalPointChange;
    results.push({ username: lastPlayer.username, rank: totalPlayers, pointChange: lastPointChange });
  }

  // DBのスコア更新 & 履歴保存
  db.serialize(() => {
    results.forEach(r => {
      db.run('UPDATE users SET score = score + ? WHERE username = ?', [r.pointChange, r.username]);
      db.run('INSERT INTO game_results (game_id, username, rank, point_change) VALUES (?, ?, ?, ?)', [game_id, r.username, r.rank, r.pointChange]);
    });
  });

  res.json({ success: true, results });
});

// 総合点数ランキング & 週末リセット機能
app.get('/ranking', requireLogin, (req, res) => {
  db.all('SELECT username, score FROM users ORDER BY score DESC', [], (err, rows) => {
    res.render('ranking', { ranking: rows, username: req.session.username });
  });
});

// 週末リセットAPI
app.post('/ranking/reset', requireLogin, (req, res) => {
  db.run('UPDATE users SET score = 100', [], (err) => {
    if (err) return res.status(500).send('リセットに失敗しました');
    res.redirect('/ranking');
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});