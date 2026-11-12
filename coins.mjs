import { daily, exercisePoints } from './deck.mjs';

const prices={voice:2,symbol:5,exercise:6,return:4,rest:12};
const symbols=['💩','❤️','🍑','🍆','🖕'];
const exercises=['3 × 15 Kniebeugen','3 × 30 Sekunden Plank','3 × 10 Liegestütze'];
const audioTypes=['audio/webm','audio/ogg','audio/mp4'];
const maxAudio=600000;

export function setupCoins(db,fail){
 db.exec(`
  CREATE TABLE IF NOT EXISTS coin_entries(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),amount INTEGER NOT NULL,label TEXT NOT NULL,day TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS rest_days(user_id INTEGER NOT NULL REFERENCES users(id),day TEXT NOT NULL,PRIMARY KEY(user_id,day));
  CREATE TABLE IF NOT EXISTS rest_vouchers(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),used TEXT);
  CREATE TABLE IF NOT EXISTS pranks(id INTEGER PRIMARY KEY,sender INTEGER NOT NULL REFERENCES users(id),recipient INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,detail TEXT NOT NULL,day TEXT NOT NULL,expires TEXT NOT NULL,source INTEGER REFERENCES pranks(id),status TEXT NOT NULL DEFAULT 'pending',sender_done INTEGER NOT NULL DEFAULT 0,recipient_done INTEGER NOT NULL DEFAULT 0,audio BLOB);
  CREATE UNIQUE INDEX IF NOT EXISTS prank_return_once ON pranks(source) WHERE source IS NOT NULL;
  DROP VIEW IF EXISTS effective_quantities;
  CREATE VIEW effective_quantities AS
   WITH legacy(exercise,target,points) AS (VALUES ${daily.map(item=>`('${item.id}',${item.target},${exercisePoints(item,item.target)})`).join(',')}),
   targets(user_id,day,exercise,target,points) AS (
    SELECT r.user_id,r.day,item.value->>'id',item.value->>'target',(item.value->>'target')/(item.value->>'step')
    FROM rest_days r JOIN challenge_periods p ON p.period=r.day AND p.kind='daily' JOIN json_each(p.data) item
    UNION ALL
    SELECT r.user_id,r.day,l.* FROM rest_days r CROSS JOIN legacy l
    WHERE NOT EXISTS(SELECT 1 FROM challenge_periods p WHERE p.period=r.day AND p.kind='daily')
   )
   SELECT q.* FROM quantities q WHERE NOT EXISTS(SELECT 1 FROM rest_days r WHERE r.user_id=q.user_id AND r.day=q.day)
   UNION ALL
   SELECT t.user_id,t.day,t.exercise,MAX(t.target,COALESCE(q.amount,0)),MAX(t.points,COALESCE(q.points,0)),1
   FROM targets t LEFT JOIN quantities q ON q.user_id=t.user_id AND q.day=t.day AND q.exercise=t.exercise;
 `);
 if(!db.prepare('PRAGMA table_info(pranks)').all().some(column=>column.name==='voice_shared')){
  db.exec('ALTER TABLE pranks ADD COLUMN voice_shared INTEGER NOT NULL DEFAULT 0');
 }
 const balance=db.prepare('SELECT COALESCE(SUM(amount),0) AS amount FROM coin_entries WHERE user_id=?');
 const credit=db.prepare('INSERT INTO coin_entries(user_id,amount,label,day) VALUES(?,?,?,?)');
 const rest=db.prepare('INSERT OR IGNORE INTO rest_days VALUES(?,?)');
 const hasRest=db.prepare('SELECT 1 FROM rest_days WHERE user_id=? AND day=?');
 const grantRest=db.prepare('INSERT INTO rest_vouchers(user_id) VALUES(?)');
 const vouchers=db.prepare('SELECT id FROM rest_vouchers WHERE user_id=? AND used IS NULL ORDER BY id');
 function transaction(work){
  db.exec('BEGIN IMMEDIATE');
  try{const value=work();db.exec('COMMIT');return value;}
  catch(error){db.exec('ROLLBACK');throw error;}
 }
 function state(user,day){
  const items=db.prepare(`
   SELECT p.id,p.kind,p.detail,p.day,p.expires,p.status,p.sender_done,p.recipient_done,
    p.sender,p.recipient,s.handle AS fromName,r.handle AS toName,
    NOT EXISTS(SELECT 1 FROM pranks child WHERE child.source=p.id) AS canReturn
   FROM pranks p JOIN users s ON s.id=p.sender JOIN users r ON r.id=p.recipient
   WHERE ((p.sender=? OR p.recipient=?) AND p.expires>=?) ORDER BY p.id DESC
  `).all(user,user,day);
  return {balance:balance.get(user).amount,vouchers:vouchers.all(user).length,prices,symbols,exercises,rest:Boolean(hasRest.get(user,day)),
   friends:db.prepare('SELECT id,handle FROM users WHERE id<>? ORDER BY handle').all(user),
   history:db.prepare('SELECT amount,label,day FROM coin_entries WHERE user_id=? ORDER BY id DESC LIMIT 25').all(user),items};
 }
 function buy(user,input,day){
  const kind=input?.kind;
  if(!Object.hasOwn(prices,kind)) fail(400,'Wähle eine Aktion.');
  return transaction(()=>{
   if(kind==='rest'){
    const voucher=vouchers.get(user);
    if(!voucher&&balance.get(user).amount<prices.rest) fail(409,'Du hast nicht genug Münzen.');
    if(!rest.run(user,day).changes) fail(409,'Heute ist bereits ein freier Tag.');
    if(voucher) db.prepare('UPDATE rest_vouchers SET used=? WHERE id=?').run(day,voucher.id);
    else credit.run(user,-prices.rest,'Freier Tag',day);
    return;
   }
   if(balance.get(user).amount<prices[kind]) fail(409,'Du hast nicht genug Münzen.');
   let recipient=input.target;
   let detail=input.detail;
   let source=null;
   let audio=null;
   let expires=day;
   if(kind==='return'){
    const original=db.prepare("SELECT * FROM pranks WHERE id=? AND recipient=? AND kind IN ('voice','symbol','exercise') AND expires>=?").get(Number(input.source)||0,user,day);
    if(!original || db.prepare('SELECT 1 FROM pranks WHERE source=?').get(original.id)) fail(409,'Diese Retourkutsche ist nicht verfügbar.');
    recipient=original.sender;
    detail=original.kind==='exercise'?original.detail:detail;
    source=original.id;
   }
   if(!Number.isSafeInteger(recipient)||recipient===user||!db.prepare('SELECT 1 FROM users WHERE id=?').get(recipient)) fail(400,'Wähle eine Person.');
   if(kind==='symbol'){
    if(!symbols.includes(detail)) fail(400,'Wähle ein Symbol.');
    const end=new Date(day+'T00:00:00Z');
    end.setUTCDate(end.getUTCDate()+6);
    expires=end.toISOString().slice(0,10);
   }
   if(kind==='exercise'||kind==='return'){
    if(!exercises.includes(detail)) fail(400,'Wähle eine Extraübung.');
   }
   if(kind==='voice'){
    if(!audioTypes.includes(detail)||typeof input.audio!=='string'||input.audio.length>maxAudio*4/3||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.audio)) fail(400,'Die Aufnahme fehlt oder ist zu groß.');
    audio=Buffer.from(input.audio,'base64');
    const end=new Date(day+'T00:00:00Z');
    end.setUTCDate(end.getUTCDate()+6);
    expires=end.toISOString().slice(0,10);
   }
   db.prepare('INSERT INTO pranks(sender,recipient,kind,detail,day,expires,source,audio) VALUES(?,?,?,?,?,?,?,?)').run(user,recipient,kind,detail,day,expires,source,audio);
   credit.run(user,-prices[kind],{voice:'Sprachnachricht',symbol:'Symbol-Prank',exercise:'Extraübung',return:'Retourkutsche'}[kind],day);
  });
 }
 function respond(user,input,day){
  if(!Number.isSafeInteger(input?.id)) fail(400,'Ungültige Challenge.');
  const prank=db.prepare("SELECT * FROM pranks WHERE id=? AND kind IN ('exercise','return') AND expires>=?").get(input.id,day);
  if(!prank || ![prank.sender,prank.recipient].includes(user)) fail(404,'Challenge nicht gefunden.');
  if(['accept','decline'].includes(input.action)&&user===prank.recipient&&prank.status==='pending'){
   db.prepare('UPDATE pranks SET status=? WHERE id=?').run(input.action==='accept'?'accepted':'declined',prank.id);
   return;
  }
  if(input.action==='done'&&prank.status==='accepted'&&(user===prank.recipient||prank.kind==='return')){
   const column=user===prank.recipient?'recipient_done':'sender_done';
   db.prepare('UPDATE pranks SET '+column+'=1 WHERE id=?').run(prank.id);
   return;
  }
  fail(409,'Diese Aktion ist für die Challenge nicht verfügbar.');
 }
 const voice=db.prepare("SELECT detail,audio FROM pranks WHERE id=? AND kind='voice' AND (recipient=? OR sender=?) AND expires>=?");
 const archivedVoice=db.prepare("SELECT detail,audio FROM pranks WHERE id=? AND kind='voice' AND (voice_shared=1 OR ? IN (sender,recipient))");
 const archive=db.prepare(`
  SELECT p.id,p.day,s.handle AS fromName,r.handle AS toName,p.sender=? AS own,p.voice_shared AS shared
  FROM pranks p JOIN users s ON s.id=p.sender JOIN users r ON r.id=p.recipient
  WHERE p.kind='voice' AND p.audio IS NOT NULL AND (p.voice_shared=1 OR ? IN (p.sender,p.recipient))
   AND (? IS NULL OR p.id<?) ORDER BY p.id DESC LIMIT 31
 `);
 const shareVoice=db.prepare("UPDATE pranks SET voice_shared=? WHERE id=? AND kind='voice' AND audio IS NOT NULL AND sender=?");
 return {state,buy,respond,voice,archive,archivedVoice,shareVoice,credit,grantRest,transaction,balance:user=>balance.get(user).amount};
}
