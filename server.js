const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'password123';

app.use(express.json());

const db = new sqlite3.Database('./scores.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, points INTEGER DEFAULT 100, cards INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1)`);
  db.run(`CREATE TABLE IF NOT EXISTS round_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

const verifyAdmin = (req, res, next) => {
  const { adminUser, adminPass } = req.body;
  if (adminUser === ADMIN_USER && adminPass === ADMIN_PASS) next();
  else res.status(403).json({ error: '認証失敗' });
};

app.post('/api/admin/verify', verifyAdmin, (req, res) => res.json({ success: true }));
app.get('/api/users', (req, res) => db.all(`SELECT * FROM users`, [], (err, rows) => res.json(rows)));
app.get('/api/ranking', (req, res) => db.all(`SELECT * FROM users WHERE is_active = 1 ORDER BY points DESC`, [], (err, rows) => res.json(rows)));
app.get('/api/submissions', (req, res) => db.all(`SELECT name FROM round_submissions ORDER BY timestamp ASC`, [], (err, rows) => res.json(rows)));

app.post('/api/admin/add-user', verifyAdmin, (req, res) => {
  const { name, cards } = req.body;
  if (!name) return res.status(400).json({ error: '名前必須' });
  db.run(`INSERT INTO users (name, points, cards, is_active) VALUES (?, 100, ?, 1) ON CONFLICT(name) DO UPDATE SET cards = ?`, [name.trim(), Number(cards)||0, Number(cards)||0], () => res.json({ success: true }));
});

app.post('/api/admin/toggle-active', verifyAdmin, (req, res) => {
  db.run(`UPDATE users SET is_active = ? WHERE name = ?`, [req.body.isActive ? 1 : 0, req.body.name], () => res.json({ success: true }));
});

app.post('/api/admin/reset-user', verifyAdmin, (req, res) => {
  db.run(`UPDATE users SET points = 100 WHERE name = ?`, [req.body.targetName], () => res.json({ success: true }));
});

app.post('/api/admin/reset-all', verifyAdmin, (req, res) => {
  db.serialize(() => {
    db.run(`UPDATE users SET points = 100`);
    db.run(`DELETE FROM round_submissions`, () => res.json({ success: true }));
  });
});

app.post('/api/submit-round', (req, res) => {
  const { name } = req.body;
  db.get(`SELECT name FROM round_submissions WHERE name = ?`, [name], (err, row) => {
    if (row) return res.status(400).json({ error: '入力済です' });
    db.run(`INSERT INTO round_submissions (name) VALUES (?)`, [name], () => res.json({ success: true }));
  });
});

app.post('/api/admin/execute-round', verifyAdmin, (req, res) => {
  const { a, b, c, dice } = req.body;
  db.all(`SELECT name FROM round_submissions ORDER BY timestamp ASC`, [], (err, subs) => {
    if (!subs.length) return res.status(400).json({ error: '入力者なし' });
    db.all(`SELECT * FROM users`, [], (err, allUsers) => {
      const userMap = {};
      allUsers.forEach(u => userMap[u.name] = { ...u });
      const totalCards = allUsers.reduce((s, u) => s + u.cards, 0);
      const N = subs.length;
      const halfN = Math.floor(N / 2);
      const isOdd = N % 2 !== 0;

      subs.forEach((sub, i) => {
        if (!userMap[sub.name]) return;
        if (!(isOdd && i === Math.floor(N / 2))) {
          if (i < halfN) userMap[sub.name].points += (Number(c) + Number(b) / 10) * Number(a);
          else userMap[sub.name].points -= (totalCards - userMap[sub.name].cards) * Number(dice);
        }
      });

      const list = Object.values(userMap);
      if (list.length) {
        const minPt = Math.min(...list.map(u => u.points));
        const minNames = list.filter(u => u.points === minPt).map(u => u.name);
        const sumNonMin = list.filter(u => !minNames.includes(u.name)).reduce((s, u) => s + u.points, 0);
        minNames.forEach(n => userMap[n].points -= sumNonMin);
      }

      db.serialize(() => {
        Object.values(userMap).forEach(u => db.run(`UPDATE users SET points = ? WHERE name = ?`, [u.points, u.name]));
        db.run(`DELETE FROM round_submissions`, () => res.json({ success: true }));
      });
    });
  });
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>ランキング</title><style>body{font-family:sans-serif;max-width:600px;margin:20px auto;padding:0 10px;}table{width:100%;border-collapse:collapse;margin:10px 0;}th,td{border:1px solid #ccc;padding:6px;text-align:left;}input,select,button{padding:5px;margin:3px 0;}.admin{background:#eee;padding:10px;margin-top:20px;}.hidden{display:none;}</style></head>
<body>
  <h2>プレイヤー入力</h2>
  <select id="us"></select> <button onclick="sub()">入力確定</button>
  <p>入力順: <span id="sub-list"></span></p>

  <h2>ランキング</h2>
  <table><thead><tr><th>順位</th><th>名前</th><th>Pt</th><th>カード</th><th class="ac hidden">操作</th></tr></thead><tbody id="rank"></tbody></table>

  <div class="admin">
    <h3>管理者</h3>
    <div id="alog"><input id="au" placeholder="ID"><input type="password" id="ap" placeholder="Pass"><button onclick="login()">認証</button></div>
    <div id="actrl" class="hidden">
      <input id="nn" placeholder="名前"><input id="nc" type="number" placeholder="カード" value="0"><button onclick="addU()">追加/更新</button><br>
      <table><thead><tr><th>名前</th><th>Pt</th><th>カード</th><th>掲載</th><th>操作</th></tr></thead><tbody id="alist"></tbody></table>
      変数a:<input id="va" type="number"> b:<input id="vb" type="number"> c:<input id="vc" type="number"> サイコロ:<input id="vd" type="number">
      <button onclick="execR()">ラウンド計算実行</button><br>
      <button onclick="resetA()" style="background:red;color:white;">全初期化</button> <button onclick="logout()">ログアウト</button>
    </div>
  </div>
<script>
let cred = null;
async function load() {
  const [r, u, s] = await Promise.all([fetch('/api/ranking').then(x=>x.json()), fetch('/api/users').then(x=>x.json()), fetch('/api/submissions').then(x=>x.json())]);
  document.getElementById('us').innerHTML = u.map(x=>\`<option value="\${x.name}">\${x.name}</option>\`).join('');
  document.getElementById('rank').innerHTML = r.map((x,i)=>\`<tr><td>\${i+1}位</td><td>\${x.name}</td><td>\${x.points}</td><td>\${x.cards}</td>\${cred?\`<td><button onclick="resU('\${x.name}')">初期化</button></td>\`:\'\'}</tr>\`).join('');
  document.getElementById('sub-list').textContent = s.map(x=>x.name).join(' -> ');
  if(cred) {
    document.getElementById('alist').innerHTML = u.map(x=>\`<tr><td>\${x.name}</td><td>\${x.points}</td><td>\${x.cards}</td><td><input type="checkbox" \${x.is_active?'checked':\'\'} onchange="toggle(\'\${x.name}\',this.checked)"></td><td><button onclick="resU('\${x.name}')">初期化</button></td></tr>\`).join('');
  }
}
async function sub() {
  const res = await fetch('/api/submit-round', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:document.getElementById('us').value})});
  if(res.ok) load(); else alert((await res.json()).error);
}
async function login() {
  const adminUser = document.getElementById('au').value, adminPass = document.getElementById('ap').value;
  const res = await fetch('/api/admin/verify', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({adminUser, adminPass})});
  if(res.ok) { cred = {adminUser, adminPass}; document.getElementById('alog').classList.add('hidden'); document.getElementById('actrl').classList.remove('hidden'); document.querySelectorAll('.ac').forEach(el=>el.classList.remove('hidden')); load(); }
  else alert('失敗');
}
function logout() { cred = null; document.getElementById('actrl').classList.add('hidden'); document.getElementById('alog').classList.remove('hidden'); document.querySelectorAll('.ac').forEach(el=>el.classList.add('hidden')); load(); }
async function addU() {
  await fetch('/api/admin/add-user', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...cred, name:document.getElementById('nn').value, cards:document.getElementById('nc').value})});
  load();
}
async function toggle(name, isActive) {
  await fetch('/api/admin/toggle-active', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...cred, name, isActive})});
  load();
}
async function resU(targetName) {
  if(!confirm('初期化しますか？'))return;
  await fetch('/api/admin/reset-user', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...cred, targetName})});
  load();
}
async function resetA() {
  if(!confirm('全初期化しますか？'))return;
  await fetch('/api/admin/reset-all', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(cred)});
  load();
}
async function execR() {
  const res = await fetch('/api/admin/execute-round', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...cred, a:document.getElementById('va').value, b:document.getElementById('vb').value, c:document.getElementById('vc').value, dice:document.getElementById('vd').value})});
  if(res.ok) { alert('完了'); load(); } else alert((await res.json()).error);
}
load(); setInterval(load, 5000);
</script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
