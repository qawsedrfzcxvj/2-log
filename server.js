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

  // 各自が提出したゲームデータのテーブル
  db.run(`
    CREATE TABLE IF NOT EXISTS game_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      prefix TEXT NOT NULL,
      username TEXT NOT NULL,
      bet INTEGER NOT NULL,
      dice INTEGER NOT NULL,
      rank INTEGER NOT NULL,
      cards INTEGER NOT NULL,
      calculated INTEGER DEFAULT 0,
      UNIQUE(game_id, username)
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

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

// ログイン・登録画面
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
      const match = await bcrypt.compare(password, user.password);
      if (match) {
        req.session.userId = user.id;
        req.session.username = user.username;
        return res.redirect('/');
      } else {
        return res.render('login', { error: 'パスワードが違います' });
      }
    } else {
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

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// トップページ（未ログインならログイン画面を200 OKで返し、ヘルスチェックを通す）
app.get('/', (req, res) => {
  if (!req.session.userId) {
    return res.render('login', { error: null });
  }
  db.get('SELECT score FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    res.render('dashboard', { username: req.session.username, score: user ? user.score : 100 });
  });
});

// ゲーム画面
app.get('/game', requireLogin, (req, res) => {
  const gameId = req.query.game_id || '';
  res.render('game', { gameId, username: req.session.username });
});

// 自分の情報を提出して新ルールで計算・反映
app.post('/game/submit', requireLogin, (req, res) => {
  const { game_id, bet, dice, cards } = req.body;
  const username = req.session.username;

  if (!game_id) return res.status(400).json({ error: 'ゲームIDを入力してください' });

  db.get('SELECT score FROM users WHERE username = ?', [username], (err, currentUser) => {
    if (err || !currentUser) return res.status(400).json({ error: 'ユーザー情報が見つかりません' });

    if (currentUser.score <= 0) {
      return res.status(400).json({ error: '持ち点が0以下のため参加できません' });
    }

    const betNum = parseInt(bet, 10);
    const diceNum = parseInt(dice, 10);
    const cardsNum = parseInt(cards, 10);

    if (isNaN(betNum) || betNum < 10 || betNum % 10 !== 0) {
      return res.status(400).json({ error: '掛け金は10pt以上、10pt刻みで入力してください' });
    }

    if (betNum > currentUser.score) {
      return res.status(400).json({ error: `掛け金は現在の持ち点（${currentUser.score}pt）以下にしてください` });
    }

    const prefixMatch = game_id.trim().match(/^[a-zA-Z]+/);
    const numberMatch = game_id.trim().match(/\d+$/);
    
    const prefix = prefixMatch ? prefixMatch[0].toLowerCase() : 'other';
    const totalPlayers = numberMatch ? parseInt(numberMatch[0], 10) : 4;

    db.run(`
      INSERT INTO game_submissions (game_id, prefix, username, bet, dice, rank, cards, calculated)
      VALUES (?, ?, ?, ?, ?, 0, ?, 0)
      ON CONFLICT(game_id, username) 
      DO UPDATE SET bet=excluded.bet, dice=excluded.dice, cards=excluded.cards
    `, [game_id, prefix, username, betNum, diceNum, cardsNum], (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: '保存に失敗しました' });
      }

      db.all('SELECT * FROM game_submissions WHERE game_id = ?', [game_id], (err, players) => {
        if (err || players.length === 0) return res.status(400).json({ error: 'データ計算エラー' });

        players.sort((a, b) => a.cards - b.cards);
        players.forEach((p, idx) => { p.rank = idx + 1; });

        const totalCardsAll = players.reduce((sum, p) => sum + p.cards, 0);
        const totalBet = players.reduce((sum, p) => sum + p.bet, 0);

        const upperCount = (totalPlayers % 2 === 0) 
          ? (totalPlayers / 2) 
          : Math.floor((totalPlayers - 1) / 2);

        const shareOfPool = upperCount > 0 ? Math.floor((totalBet / upperCount) / 10) * 10 : 0;

        let nonLastBaseSum = 0;
        let basePoints = {};

        players.forEach(p => {
          const otherCardsSum = totalCardsAll - p.cards;
          let base = 0;

          if (p.rank === totalPlayers) {
            base = 0;
          } else if (p.rank <= upperCount) {
            base = Math.floor((otherCardsSum + (p.bet / 10)) * p.dice);
          } else if (totalPlayers % 2 !== 0 && p.rank === upperCount + 1) {
            base = 0;
          } else {
            base = -Math.floor(otherCardsSum * p.dice);
          }

          basePoints[p.username] = base;
          if (p.rank !== totalPlayers) {
            nonLastBaseSum += base;
          }
        });

        let myPointChange = 0;
        let myRank = 1;

        players.forEach(p => {
          let finalChange = 0;
          if (p.rank <= upperCount) {
            finalChange = basePoints[p.username] + shareOfPool;
          } else if (p.rank === totalPlayers) {
            finalChange = -nonLastBaseSum;
          } else {
            finalChange = basePoints[p.username];
          }

          if (p.username === username) {
            myPointChange = finalChange;
            myRank = p.rank;
          }
        });

        db.run('UPDATE users SET score = score + ? WHERE username = ?', [myPointChange, username], () => {
          db.get('SELECT score FROM users WHERE username = ?', [username], (err, user) => {
            res.json({
              success: true,
              rank: myRank,
              totalPlayers: totalPlayers,
              pointChange: myPointChange,
              currentScore: user ? user.score : 100
            });
          });
        });
      });
    });
  });
});

// 総合 & アルファベット別ランキング
app.get('/ranking', requireLogin, (req, res) => {
  const prefixFilter = req.query.prefix || '';

  db.all('SELECT username, score FROM users ORDER BY score DESC', [], (err, overallRanking) => {
    db.all('SELECT DISTINCT prefix FROM game_submissions', [], (err, prefixes) => {
      
      if (prefixFilter) {
        db.all(`
          SELECT DISTINCT u.username, u.score 
          FROM users u 
          JOIN game_submissions gs ON u.username = gs.username 
          WHERE gs.prefix = ? 
          ORDER BY u.score DESC
        `, [prefixFilter], (err, fRows) => {
          res.render('ranking', {
            overallRanking,
            filteredRanking: fRows,
            prefixes: prefixes ? prefixes.map(p => p.prefix) : [],
            currentPrefix: prefixFilter,
            username: req.session.username
          });
        });
      } else {
        res.render('ranking', {
          overallRanking,
          filteredRanking: null,
          prefixes: prefixes ? prefixes.map(p => p.prefix) : [],
          currentPrefix: '',
          username: req.session.username
        });
      }
    });
  });
});

// 週末リセット
app.post('/ranking/reset', requireLogin, (req, res) => {
  db.run('UPDATE users SET score = 100', [], (err) => {
    if (err) return res.status(500).send('リセットに失敗しました');
    res.redirect('/ranking');
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
