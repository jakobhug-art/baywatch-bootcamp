import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { daily, schedule, exercisePoints, monthTarget, monthBonus, wheel } from './deck.mjs';
import { setupCoins } from './coins.mjs';
import { setupChallenges } from './challenges.mjs';
import { setupRankings } from './rankings.mjs';

const db = new DatabaseSync(process.env.REPDECK_DB || 'repdeck.sqlite');
db.exec(`
 PRAGMA foreign_keys=ON;
 PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, handle TEXT UNIQUE COLLATE NOCASE, secret TEXT);
 CREATE TABLE IF NOT EXISTS admins(user_id INTEGER PRIMARY KEY REFERENCES users(id));
 CREATE TABLE IF NOT EXISTS reports(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('bug','feedback')),
  title TEXT NOT NULL, message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved')),
  created INTEGER NOT NULL, updated INTEGER NOT NULL
 );
 CREATE INDEX IF NOT EXISTS reports_by_user ON reports(user_id,id);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), expires INTEGER);
 CREATE TABLE IF NOT EXISTS quantities(user_id INTEGER REFERENCES users(id), day TEXT, exercise TEXT, amount INTEGER, points INTEGER, reached INTEGER, PRIMARY KEY(user_id,day,exercise));
 CREATE TABLE IF NOT EXISTS marks(user_id INTEGER REFERENCES users(id), period TEXT, exercise TEXT, week TEXT, points INTEGER, PRIMARY KEY(user_id,period,exercise));
 CREATE TABLE IF NOT EXISTS wheel_spins(
  user_id INTEGER REFERENCES users(id), day TEXT, slot INTEGER, title TEXT, description TEXT,
  initial INTEGER NOT NULL, reward INTEGER, completed INTEGER NOT NULL DEFAULT 0,
  turn INTEGER NOT NULL DEFAULT 1, bonus INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,day,turn)
 );
`);
if(!db.prepare('PRAGMA table_info(wheel_spins)').all().some(column=>column.name==='turn')){
 db.exec(`
  BEGIN IMMEDIATE;
  ALTER TABLE wheel_spins RENAME TO wheel_spins_old;
  CREATE TABLE wheel_spins(
   user_id INTEGER REFERENCES users(id), day TEXT, slot INTEGER, title TEXT, description TEXT,
   initial INTEGER NOT NULL, reward INTEGER, completed INTEGER NOT NULL DEFAULT 0,
   turn INTEGER NOT NULL DEFAULT 1, bonus INTEGER NOT NULL DEFAULT 0,
   PRIMARY KEY(user_id,day,turn)
  );
  INSERT INTO wheel_spins(user_id,day,slot,title,description,initial,reward,completed)
   SELECT user_id,day,slot,title,description,initial,reward,completed FROM wheel_spins_old;
  DROP TABLE wheel_spins_old;
  COMMIT;
 `);
}
const wheelResults=db.prepare('SELECT turn,slot,title,description,initial,reward,completed,bonus FROM wheel_spins WHERE user_id=? AND day=? ORDER BY turn');
const challenges=setupChallenges(db,fail);
const coins=setupCoins(db,fail);
const rankings=setupRankings(db,{legacyCount:daily.length,monthTarget,monthBonus});
// Apply new scoring to the open day while preserving closed days.
const currentDay=challenges.current();
const currentAmounts=db.prepare('SELECT user_id,amount FROM quantities WHERE day=? AND exercise=?');
const updatePoints=db.prepare('UPDATE quantities SET points=? WHERE user_id=? AND day=? AND exercise=?');
coins.transaction(()=>{
 for(const exercise of currentDay.daily){
  for(const row of currentAmounts.all(currentDay.day,exercise.id)){
   updatePoints.run(exercisePoints(exercise,row.amount),row.user_id,currentDay.day,exercise.id);
  }
 }
});
const dailyPassed=db.prepare('SELECT COUNT(*) AS count FROM effective_quantities WHERE user_id=? AND day=? AND reached=1');
if(process.argv[2]==='--grant-admin'){
 const handle=process.argv[3];
 const account=handle && db.prepare('SELECT id,handle FROM users WHERE handle=?').get(handle);
 if(!account){
  console.error('Konto nicht gefunden. Zuerst in der App registrieren.');
  process.exit(1);
 }
 db.prepare('INSERT OR IGNORE INTO admins(user_id) VALUES(?)').run(account.id);
 console.log('Adminrechte erteilt für '+account.handle);
 db.close();
 process.exit(0);
}
const hash = value => createHash('sha256').update(value).digest('hex');
const assets = new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/style.css',['style.css','text/css']]]);
const attempts = new Map();
const resetAttempts = new Map();
const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
const cookie = 'repdeck=';
const invite = process.env.REPDECK_INVITE;
if (process.env.NODE_ENV === 'production' && (!invite || invite.length < 16 || invite==='repdeck-lokaler-testcode')) throw new Error('REPDECK_INVITE muss ein eigener Einladungscode mit mindestens 16 Zeichen sein.');
function verifyPassword(password,secret){
 const [salt,expected]=(secret || '00000000000000000000000000000000:'+ '0'.repeat(128)).split(':');
 return timingSafeEqual(scryptSync(password,salt,64),Buffer.from(expected,'hex'));
}
function fail(status,message) { throw Object.assign(new Error(message),{status}); }
async function body(req,limit=4096) {
 req.setEncoding('utf8');
 let value='';
 for await (const chunk of req) {
  value+=chunk;
  if(value.length>limit) fail(413,'Anfrage zu groß.');
 }
 try { return JSON.parse(value); } catch { fail(400,'Ungültige Anfrage.'); }
}
createServer(async (req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 const reply=(data,status=200)=>{
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
 };
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'; form-action 'self'");
 try {
  if(req.method==='GET' && assets.has(path)){
   const [file,type]=assets.get(path);
   res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});
   return res.end(readFileSync(new URL(file,import.meta.url)));
  }
  if(req.method==='POST' && !req.headers['content-type']?.startsWith('application/json')) fail(415,'JSON erforderlich.');
  const token=req.headers.cookie?.match(/(?:^|; )repdeck=([a-f0-9]{64})(?:;|$)/)?.[1];
  const user=token && db.prepare('SELECT users.id,handle,EXISTS(SELECT 1 FROM admins WHERE admins.user_id=users.id) AS admin FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>?').get(hash(token),Date.now());
  if(req.method==='GET' && path==='/api/state' && !user) return reply({user:null});
  const portrait=path.match(/^\/api\/portrait\/([12])$/);
  if(req.method==='GET' && portrait){
   if(!user) fail(401,'Bitte melde dich an.');
   let photo;
   try { photo=readFileSync(new URL('private-portraits/'+portrait[1]+'.jpg',import.meta.url)); }
   catch { fail(404,'Foto nicht gefunden.'); }
   res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, no-store'});
   return res.end(photo);
  }
  if(req.method==='POST' && ['/api/register','/api/login'].includes(path)){
   const now=Date.now();
   for(const [ip,entry] of attempts) if(entry.until<=now) attempts.delete(ip);
   const ip=req.socket.remoteAddress;
   const entry=attempts.get(ip) || {until:now+60000,count:0};
   attempts.set(ip,entry);
   if(++entry.count>12) fail(429,'Bitte warte kurz und versuche es erneut.');
   const input=await body(req);
   const handle=typeof input?.handle==='string'?input.handle.trim():'';
   const password=input?.password;
   if(!/^[\p{L}\p{N}_-]{2,24}$/u.test(handle)||typeof password!=='string'||password.length<10||password.length>128) fail(400,'Name: 2–24 Zeichen. Passwort: 10–128 Zeichen.');
   let account=db.prepare('SELECT * FROM users WHERE handle=?').get(handle);
   if(path==='/api/register'){
    if(!invite || hash(String(input.invite))!==hash(invite)) fail(403,'Der Einladungscode stimmt nicht oder fehlt.');
    if(account) fail(409,'Dieser Name ist schon vergeben.');
    const salt=randomBytes(16).toString('hex');
    const secret=salt+':'+scryptSync(password,salt,64).toString('hex');
    const result=db.prepare('INSERT INTO users(handle,secret) VALUES(?,?)').run(handle,secret);
    account={id:result.lastInsertRowid};
   } else {
    const valid=verifyPassword(password,account?.secret);
    if(!account||!valid) fail(401,'Name oder Passwort stimmt nicht.');
   }
   const key=randomBytes(32).toString('hex');
   db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
   db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(key),account.id,now+2592000000);
   res.setHeader('Set-Cookie',cookie+key+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000'+secure);
   return reply({ok:true});
  }
  if(req.method==='POST' && path==='/api/logout'){
   if(token) db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token));
   res.setHeader('Set-Cookie',cookie+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'+secure);
   return reply({ok:true});
  }
  if(path.startsWith('/api/reports')){
   if(!user) fail(401,'Bitte melde dich an.');
   if(req.method==='GET' && path==='/api/reports'){
    const reports=user.admin
     ? db.prepare('SELECT reports.id,kind,title,message,status,created,updated,users.handle FROM reports JOIN users ON users.id=reports.user_id ORDER BY reports.id DESC').all()
     : db.prepare('SELECT id,kind,title,message,status,created,updated FROM reports WHERE user_id=? ORDER BY id DESC').all(user.id);
    return reply({admin:Boolean(user.admin),reports});
   }
   if(req.method==='POST' && path==='/api/reports'){
    const input=await body(req);
    const title=typeof input?.title==='string'?input.title.trim():'';
    const message=typeof input?.message==='string'?input.message.trim():'';
    if(!['bug','feedback'].includes(input?.kind) || title.length<3 || title.length>90 || message.length<5 || message.length>1500){
     fail(400,'Bitte wähle eine Kategorie und gib einen Titel (3–90 Zeichen) sowie eine Beschreibung (5–1.500 Zeichen) ein.');
    }
    const now=Date.now();
    const recent=db.prepare('SELECT COUNT(*) AS count FROM reports WHERE user_id=? AND created>?').get(user.id,now-3600000);
    if(recent.count>=10) fail(429,'Du kannst bis zu zehn Meldungen pro Stunde senden.');
    db.prepare('INSERT INTO reports(user_id,kind,title,message,created,updated) VALUES(?,?,?,?,?,?)').run(user.id,input.kind,title,message,now,now);
    return reply({ok:true},201);
   }
   if(req.method==='POST' && path==='/api/reports/status'){
    if(!user.admin) fail(403,'Für diese Aktion brauchst du Adminrechte.');
    const input=await body(req);
    if(!Number.isSafeInteger(input?.id) || input.id<1 || !['open','acknowledged','resolved'].includes(input.status)){
     fail(400,'Ungültige Meldung oder ungültiger Status.');
    }
    const result=db.prepare('UPDATE reports SET status=?, updated=? WHERE id=?').run(input.status,Date.now(),input.id);
    if(!result.changes) fail(404,'Meldung nicht gefunden.');
    return reply({ok:true});
   }
  }
  const deck=challenges.current();
  if(req.method==='POST' && path==='/api/admin/reset-points'){
   if(!user?.admin) fail(403,'Für diese Aktion brauchst du Adminrechte.');
   const input=await body(req);
   if(input?.confirm!=='PUNKTE RESETTEN' || typeof input.password!=='string' || input.password.length>128) fail(400,'Bestätigung und Passwort sind erforderlich.');
   const now=Date.now();
   const recent=(resetAttempts.get(user.id)||[]).filter(time=>time>now-600000);
   if(recent.length>=5) fail(429,'Zu viele Versuche. Warte zehn Minuten.');
   resetAttempts.set(user.id,[...recent,now]);
   const {secret}=db.prepare('SELECT secret FROM users WHERE id=?').get(user.id);
   if(!verifyPassword(input.password,secret)) fail(401,'Das Passwort stimmt nicht.');
   if(input.day!==deck.day || schedule().day!==deck.day) fail(409,'Der Tag hat gewechselt. Lade die Seite neu.');
   coins.transaction(()=>rankings.reset(user.id,deck.day));
   resetAttempts.delete(user.id);
   return reply({ok:true});
  }
  if(path==='/api/admin/challenges'){
   if(!user?.admin) fail(403,'Für diese Aktion brauchst du Adminrechte.');
   if(req.method==='GET') return reply({entries:challenges.list()});
   if(req.method==='POST'){
    challenges.update(await body(req));
    return reply({ok:true});
   }
  }
  if(req.method==='POST' && ['/api/coins/buy','/api/coins/respond'].includes(path)){
   if(!user) fail(401,'Bitte melde dich an.');
   const input=await body(req,path.endsWith('/buy')?810000:4096);
   if(input?.day!==deck.day || schedule().day!==deck.day) fail(409,'Der Tag hat gewechselt. Lade die Seite neu.');
   if(path.endsWith('/buy')) coins.buy(user.id,input,deck.day);
   else coins.respond(user.id,input,deck.day);
   return reply({ok:true});
  }
  const voice=path.match(/^\/api\/voice\/(\d+)$/);
  if(req.method==='GET' && voice){
   if(!user) fail(401,'Bitte melde dich an.');
   const recording=coins.voice.get(Number(voice[1]),user.id,user.id,deck.day);
   if(!recording) fail(404,'Aufnahme nicht gefunden.');
   res.writeHead(200,{'Content-Type':recording.detail,'Cache-Control':'private, no-store'});
   return res.end(recording.audio);
  }
  if(req.method==='POST' && ['/api/wheel/spin','/api/wheel/complete'].includes(path)){
   if(!user) fail(401,'Bitte melde dich an.');
   const input=await body(req);
   if(input?.day!==deck.day || schedule().day!==deck.day) fail(409,'Der Tag hat gewechselt. Lade die Seite neu.');
   if(path==='/api/wheel/spin'){
    if(dailyPassed.get(user.id,deck.day).count!==deck.daily.length) fail(403,'Erreiche zuerst alle Tagesziele.');
    const spins=wheelResults.all(user.id,deck.day);
    const nextTurn=spins.length+1;
    if(input.turn!==nextTurn || nextTurn>2 || (nextTurn===2 && !spins[0].bonus)) fail(409,'Heute ist kein weiterer Dreh verfügbar.');
    const slot=randomInt(wheel.length);
    const card=wheel[slot];
    const bonus=Number(nextTurn===1 && card.bonus===true);
    coins.transaction(()=>{
     const result=db.prepare('INSERT OR IGNORE INTO wheel_spins(user_id,day,slot,title,description,initial,reward,turn,bonus) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(user.id,deck.day,slot,card.title,card.description,card.initial,card.reward??null,nextTurn,bonus);
     if(!result.changes) fail(409,'Du hast heute bereits gedreht.');
     const won=randomInt(3)===0?randomInt(1,4):0;
     if(won) coins.credit.run(user.id,won,'Glücksrad',deck.day);
     if(card.rest) coins.grantRest.run(user.id);
    });
   } else {
    if(![1,2].includes(input.turn)) fail(400,'Ungültiger Dreh.');
    const result=db.prepare('UPDATE wheel_spins SET completed=1 WHERE user_id=? AND day=? AND turn=? AND reward IS NOT NULL AND completed=0')
     .run(user.id,deck.day,input.turn);
    if(!result.changes) fail(409,'Für heute gibt es keine offene Rad-Aufgabe.');
   }
   return reply({ok:true});
  }
  if(req.method==='POST' && path==='/api/quantity'){
   if(!user) fail(401,'Bitte melde dich an.');
   const input=await body(req);
   const exercise=deck.daily.find(item=>item.id===input?.id);
   if(input?.day!==deck.day || schedule().day!==deck.day) fail(409,'Der Tag hat gewechselt. Lade die Seite neu.');
   if(!exercise || !Number.isInteger(input.amount) || input.amount<0 || input.amount>10000) fail(400,'Gib eine ganze Zahl zwischen 0 und 10.000 ein.');
   db.prepare(`
    INSERT INTO quantities VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id,day,exercise) DO UPDATE SET amount=excluded.amount,points=excluded.points,reached=excluded.reached
   `).run(user.id,deck.day,exercise.id,input.amount,exercisePoints(exercise,input.amount),Number(input.amount>=exercise.target));
   return reply({ok:true});
  }
  if(req.method==='POST' && path==='/api/mark'){
   if(!user) fail(401,'Bitte melde dich an.');
   const input=await body(req);
   const item=deck.weekly.find(([id])=>id===input?.id);
   const period=deck.week;
   if(!item || period!==input?.period || schedule().week!==period || typeof input.done!=='boolean') fail(409,'Das Deck hat gewechselt. Lade die Seite neu.');
   if(input.done) coins.transaction(()=>{
    db.prepare('INSERT OR IGNORE INTO marks VALUES(?,?,?,?,?)').run(user.id,period,item[0],deck.week,item[4]);
    rankings.recordWeekly.run(user.id,deck.week,item[0],schedule().day);
   });
   else db.prepare('DELETE FROM marks WHERE user_id=? AND period=? AND exercise=?').run(user.id,period,item[0]);
   return reply({ok:true});
  }
  if(req.method==='GET' && path==='/api/state'){
   const marks=user?db.prepare('SELECT exercise FROM marks WHERE user_id=? AND period=? AND week=?').all(user.id,deck.week,deck.week):[];
   const quantities=user?db.prepare('SELECT exercise,amount,points FROM quantities WHERE user_id=? AND day=?').all(user.id,deck.day):[];
   const activeDays=user?db.prepare(`
    SELECT q.day FROM effective_quantities q LEFT JOIN challenge_periods p ON p.period=q.day AND p.kind='daily'
    WHERE q.user_id=? AND q.day LIKE ? AND q.reached=1 GROUP BY q.day HAVING COUNT(*)=COALESCE(json_array_length(p.data),?)
   `).all(user.id,deck.month+'-%',daily.length).map(row=>row.day):[];
   const standings=user?rankings.state(deck):{};
   const spins=user?wheelResults.all(user.id,deck.day):[];
   return reply({deck,user:user||null,marks,quantities,activeDays,...standings,spins,coins:user?coins.state(user.id,deck.day):null});
  }
  fail(404,'Seite nicht gefunden.');
 } catch(error) {
  if(!error.status) console.error(error);
  reply({error:error.status?error.message:'Die Anfrage konnte nicht verarbeitet werden.'},error.status||500);
 }
}).listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log('Baywatch Bootcamp ist bereit.'));
