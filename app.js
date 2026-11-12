const $ = selector => document.querySelector(selector);
function showCoins(element,amount,suffix=''){
 const icon=document.createElement('span');
 icon.className='coin-icon';
 icon.setAttribute('role','img');
 icon.setAttribute('aria-label','Münzen');
 element.replaceChildren(String(amount)+' ',icon,suffix);
}
const icons = {push:'↗',plank:'▱',pull:'↟',situp:'◒',squat:'◇'};
const categories = ['Bewegung','Ernährung','Spaß & Abwechslung'];
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
 '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
})[character]);
const dateFormat = new Intl.DateTimeFormat('de-DE',{weekday:'long',day:'numeric',month:'long',timeZone:'UTC'});
const monthFormat = new Intl.DateTimeFormat('de-DE',{month:'long',year:'numeric',timeZone:'UTC'});
let state;
let rankingPeriod = 'seasonRanking';
let register = false;
let busy = false;
const quantityQueue = new Map();
let quantityRefresh;
let trainingAudio;
let trainingAudioQueue=Promise.resolve();

function prepareTrainingAudio(){
 const AudioContext=window.AudioContext||window.webkitAudioContext;
 if(!AudioContext) return;
 try{
  trainingAudio??=new AudioContext();
  if(trainingAudio.state==='suspended') trainingAudio.resume().catch(()=>{});
 } catch {}
}

function playTrainingVoices(ids,owner){
 if(!ids?.length) return;
 const context=trainingAudio;
 trainingAudioQueue=trainingAudioQueue.then(async ()=>{
  for(const id of ids){
   if(state?.user?.id!==owner || trainingAudio!==context) return;
   if(!context || context.state!=='running') throw new Error('Audio gesperrt');
   const {url}=await api('voice/'+id);
   const response=await fetch(url);
   if(!response.ok) throw new Error('Aufnahme nicht verfügbar');
   const buffer=await context.decodeAudioData(await response.arrayBuffer());
   if(state?.user?.id!==owner || trainingAudio!==context) return;
   await new Promise(resolve=>{
    const source=context.createBufferSource();
    source.buffer=buffer;
    source.connect(context.destination);
    source.onended=resolve;
    source.start();
   });
  }
 }).catch(()=>{
  if(state?.user?.id===owner) setError('#notice','Die Sprachnachricht konnte nicht automatisch abgespielt werden. Du findest sie im Münzkonto.');
 });
}
const rateFormat = new Intl.NumberFormat('de-DE',{maximumFractionDigits:6});
const dailyTerms = {
 push:'Liegestütz',
 plank:'Plank-Sekunde',
 pull:'Klimmzug',
 situp:'Bauchaufzug',
 squat:'Kniebeuge'
};
const weeklyDifficulty={
 Leicht:{label:'Einfach',points:45},
 Mittel:{label:'Mittel',points:60},
 Schwer:{label:'Schwierig',points:75}
};

function estimatedPoints(card,amount){
 const extra=Math.min(Math.max(amount-card.target,0),card.target);
 if(card.goalPoints){
  return Math.min(75,Math.floor(Math.min(amount,card.target)*card.goalPoints/card.target)
   +Math.floor(extra*card.goalPoints/(4*card.target)));
 }
 return Math.floor(Math.min(amount,card.target)/card.step)+Math.floor(extra/(4*card.step));
}

function rates(card){
 const normal=card.goalPoints?card.goalPoints/card.target:1/card.step;
 return [rateFormat.format(normal),rateFormat.format(card.goalPoints===75?0:normal/4)];
}

function visibleAmounts(){
 const amounts=new Map(state.quantities.map(item=>[item.exercise,item]));
 for(const entry of quantityQueue.values()){
  if(entry.day===state.deck.day && entry.owner===state.user?.id){
   const card=state.deck.daily.find(item=>item.id===entry.id);
   if(card) amounts.set(card.id,{amount:entry.amount,points:estimatedPoints(card,entry.amount)});
  }
 }
 return amounts;
}

function renderDaySummary(amounts){
 const {deck,spins,coins,photoBonus=0}=state;
 const wheelPoints=spins.reduce((sum,spin)=>sum+(spin.completed?spin.reward:spin.initial),0);
 const rest=Boolean(coins?.rest);
 const points=deck.daily.reduce((sum,item)=>sum+Math.max(amounts.get(item.id)?.points||0,rest?estimatedPoints(item,item.target):0),wheelPoints+photoBonus);
 const reached=rest?deck.daily.length:deck.daily.filter(item=>(amounts.get(item.id)?.amount||0)>=item.target).length;
 $('#daily-summary').textContent=(rest?'Freier Tag':reached+' / '+deck.daily.length+' Ziele')+' · '+points+' P';
 const workout=$('#workout-summary');
 if(!workout) return;
 let earnedBase=0;
 let availableBase=0;
 let earnedBonus=0;
 let availableBonus=0;
 for(const card of deck.daily){
  const base=estimatedPoints(card,card.target);
  const earned=Math.max(amounts.get(card.id)?.points||0,rest?base:0);
  earnedBase+=Math.min(earned,base);
  availableBase+=base;
  earnedBonus+=Math.max(0,earned-base);
  availableBonus+=estimatedPoints(card,card.target*2)-base;
 }
 $('#workout-base').textContent=earnedBase+' / '+availableBase+' P';
 $('#workout-bonus').textContent=earnedBonus+' / '+availableBonus+' P';
 $('#workout-photo-bonus').textContent=state.workoutFinished?signed(photoBonus)+' P':'+10 P mit Foto';
 $('#workout-penalty').textContent=signed(-10*(deck.daily.length-reached))+' P';
 $('#workout-finish').disabled=Boolean(state.workoutFinished || quantityQueue.size);
}

const cloudUrl = document.querySelector('meta[name="bootcamp-api"]')?.content;
const cloudKey = document.querySelector('meta[name="bootcamp-key"]')?.content;
const sessionKey = 'baywatch-bootcamp-session';
let cloudSession = null;
let sessionStorageSource;
let sessionRefresh;
if(cloudUrl){
 cloudSession=readCloudSession();
 if(cloudSession) saveCloudSession(cloudSession);
}

function readCloudSession(){
 if(sessionStorageSource==='memory') return cloudSession;
 for(const kind of sessionStorageSource?[sessionStorageSource]:['localStorage','sessionStorage']){
  try{
   const session=JSON.parse(window[kind].getItem(sessionKey));
   if(session?.access_token && session?.refresh_token) return session;
  } catch {}
 }
 return null;
}

function saveCloudSession(session){
 cloudSession=session;
 sessionStorageSource='memory';
 for(const kind of ['localStorage','sessionStorage']){
  try{
   if(session && sessionStorageSource==='memory'){
    window[kind].setItem(sessionKey,JSON.stringify(session));
    sessionStorageSource=kind;
   } else window[kind].removeItem(sessionKey);
  } catch {}
 }
 if(!session) sessionStorageSource=undefined;
}

async function timedFetch(url,options){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),12000);
 try{return await fetch(url,{...options,signal:controller.signal});}
 catch{throw new Error('Der Server ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.');}
 finally{clearTimeout(timer);}
}

async function cloudRequest(path,payload,token){
 const headers={apikey:cloudKey};
 if(token) headers.Authorization='Bearer '+token;
 if(payload!==undefined) headers['Content-Type']='application/json';
 const response=await timedFetch(cloudUrl+'/'+path,{
  method:payload===undefined?'GET':'POST',headers,body:JSON.stringify(payload)
 });
 const data=await response.json().catch(()=>null);
 if(!response.ok || !data) throw Object.assign(new Error(data?.error||'Der Server konnte die Anfrage gerade nicht beantworten. Bitte versuche es erneut.'),{status:response.status});
 return data;
}

async function refreshCloudSession(rejectedToken){
 const needsRenewal=session=>session && (session.access_token===rejectedToken || !(session.expires_at>Date.now()/1000+60));
 cloudSession=readCloudSession();
 if(!needsRenewal(cloudSession)) return;
 if(!sessionRefresh){
  const renew=async ()=>{
   const latest=readCloudSession();
   if(!needsRenewal(latest)){cloudSession=latest;return;}
   try{
    const renewed=await cloudRequest('refresh',{refresh_token:latest.refresh_token});
    if(readCloudSession()?.refresh_token===latest.refresh_token) saveCloudSession(renewed);
   }
   catch(error){
    if(error.status!==401) throw error;
    if(readCloudSession()?.refresh_token===latest.refresh_token) saveCloudSession(null);
   }
   cloudSession=readCloudSession();
  };
  sessionRefresh=(navigator.locks?navigator.locks.request(sessionKey,renew):renew())
   .finally(()=>{sessionRefresh=undefined;});
 }
 await sessionRefresh;
}

async function api(path, payload) {
 if(cloudUrl){
  if(path==='login'||path==='register'){
   saveCloudSession(await cloudRequest(path,payload));
   return {ok:true};
  }
  await refreshCloudSession();
  if(path==='logout'){
   await cloudRequest(path,payload,cloudSession?.access_token);
   saveCloudSession(null);
   trainingAudio?.close().catch(()=>{});
   trainingAudio=undefined;
   trainingAudioQueue=Promise.resolve();
   return {ok:true};
  }
  if(path==='state'){
   const token=cloudSession?.access_token;
   try{return await cloudRequest(path,undefined,token);}
   catch(error){
    if(error.status!==401 || !token) throw error;
    await refreshCloudSession(token);
    const renewed=cloudSession?.access_token;
    if(!renewed) return {user:null};
    try{return await cloudRequest(path,undefined,renewed);}
    catch(retryError){
     if(retryError.status!==401) throw retryError;
     if(readCloudSession()?.access_token===renewed) saveCloudSession(null);
     return {user:null};
    }
   }
  }
  if(path==='coins/buy') payload={...payload,requestId:crypto.randomUUID()};
  return cloudRequest(path,payload,cloudSession?.access_token);
 }
 const response = await fetch('/api/'+path,payload===undefined?{}:{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
 });
 const data = await response.json();
 if(!response.ok) throw new Error(data.error);
 return data;
}

function dailyPrankSymbols(items,userId){
 const counts=new Map();
 for(const {kind,recipient,detail} of items){
  if(kind==='symbol'&&recipient===userId) counts.set(detail,(counts.get(detail)||0)+1);
 }
 if(!counts.size) return '';
 return `<div class="prank-symbols" role="group" aria-label="Aktive Symbol-Pranks">${[...counts].map(([symbol,count])=>
  `<span class="prank-symbol">${escapeHtml(symbol)}${count>1?`<small>×${count}</small>`:''}</span>`
 ).join('')}</div>`;
}

function render() {
 const {deck,user,marks,quantities,activeDays,coins} = state;
 $('#challenge-admin').hidden=!user?.admin;
 $('#member-admin').hidden=!cloudUrl||!user?.admin;
 if(cloudUrl&&user?.admin){
  const members=[{id:user.id,handle:user.handle},...coins.friends];
  setOptions($('#member-admin-form').elements.member,members.map(member=>[member.id,member.handle]));
 }
 const amounts = visibleAmounts();
 const rest=Boolean(coins?.rest);
 const symbols=dailyPrankSymbols(coins?.items||[],user.id);
 const savedAmounts=new Map(quantities.map(item=>[item.exercise,item.amount]));
 const unlocked=cloudUrl?state.workoutFinished||state.spins.length>0:rest||deck.daily.every(item=>(savedAmounts.get(item.id)||0)>=item.target);
 $('#date').textContent = dateFormat.format(new Date(deck.day+'T00:00:00Z'));
 $('#account').textContent = user?'Abmelden':'Anmelden';
 renderDaySummary(amounts);
 const extras=coins?.items.filter(item=>['exercise','return'].includes(item.kind)&&item.recipient===user.id&&item.status!=='declined'&&!item.recipient_done)||[];
 $('#daily-extra').hidden=!extras.length;
 $('#daily-extra').textContent=extras.length>1?extras.length+' offene Extraübungen · Ansehen'
  :extras.length?'Extraübung für heute: '+extras[0].detail+' · Ansehen':'';
 $('#week-summary').textContent = marks.length+' / '+deck.weekly.length+' erledigt';
 $('#daily').innerHTML = deck.daily.map(source=>{
  const item={...source,name:escapeHtml(source.name)};
  const {amount=0,points=0} = amounts.get(item.id)||{};
  const unit=dailyTerms[item.id]||(item.unit==='Sek.'?'Sekunde':'Wiederholung');
  const [normal,bonus]=rates(item);
  return `<article class="card ${item.color}">
   ${symbols}
   <div class="card-head"><span class="tile-icon" aria-hidden="true">${icons[item.icon]}</span><span class="points">${points} P</span></div>
   <h3>${item.name}</h3>
   <dl class="daily-rates">
    <div><dt>Punkte pro ${unit}</dt><dd>${normal}</dd></div>
    <div><dt>Bonus-Punkte pro ${unit}</dt><dd>${bonus}</dd></div>
   </dl>
   <progress max="${item.target}" value="${Math.min(amount,item.target)}" aria-label="Tagesziel ${item.name}"></progress>
   <p class="progress-label">${amount} / ${item.target} ${item.unit}${amount>=item.target?' · ✓':''}</p>
   <form class="counter" data-id="${item.id}"><fieldset class="counter-fields" ${state.workoutFinished?'disabled':''}>
    <button type="button" data-delta="-${item.step}" aria-label="${item.name}: ${item.step} ${item.unit} abziehen">−</button>
    <input type="number" name="amount" value="${amount}" min="0" max="10000" step="1" inputmode="numeric" required aria-label="${item.name}: Tagesmenge in ${item.unit}" title="Tagesmenge eingeben und mit Enter speichern">
    <button type="button" data-delta="+${item.step}" aria-label="${item.name}: ${item.step} ${item.unit} hinzufügen">+${item.step}</button>
    <button type="submit" class="save-amount" aria-label="${item.name}: Tagesmenge speichern">Speichern</button>
   </fieldset></form>
  </article>`;
 }).join('')+(cloudUrl?`<article class="card workout-card" id="workout-summary">
   <h3>Workout abschließen</h3>
   <dl class="daily-rates">
    <div><dt>Grundpunkte</dt><dd id="workout-base"></dd></div>
    <div><dt>Bonuspunkte</dt><dd id="workout-bonus"></dd></div>
    <div><dt>Foto-Bonus</dt><dd id="workout-photo-bonus"></dd></div>
    <div><dt>Abzug für offene Ziele</dt><dd id="workout-penalty"></dd></div>
   </dl>
   <p class="hint">${state.workoutFinished?'Deine Tageswertung ist abgeschlossen.':'Mit deinem Foto schließt du das Workout ab und schaltest das Glücksrad frei.'}</p>
   <button class="primary" id="workout-finish" type="button">${state.workoutFinished?'Abgeschlossen':'Workout abschließen'}</button>
  </article>`:'');
 renderDaySummary(amounts);
 $('#weekly').innerHTML = deck.weekly.map(([id,icon,name,description,points,color,category,difficulty],index)=>{
  const done=marks.some(mark=>mark.exercise===id);
  return `<article class="card ${color}"><div class="card-head"><span class="tile-icon" aria-hidden="true">${icon}</span><span class="points">+${points} P</span></div>
   <p class="eyebrow">${escapeHtml(category||categories[index])}${difficulty?' · '+escapeHtml(weeklyDifficulty[difficulty]?.label||difficulty):''}</p><h3>${escapeHtml(name)}</h3><p class="hint">${escapeHtml(description)}</p>
   <button class="mark" type="button" data-mark="${id}" aria-pressed="${done}">${done?'✓ Erledigt':'Als erledigt markieren'}</button>
  </article>`;
 }).join('');
 const days=activeDays.length;
 $('#monthly').innerHTML = `<div class="card-head cyan"><strong>${monthFormat.format(new Date(deck.month+'-01T00:00:00Z'))}</strong><span class="points">${days>=deck.monthTarget?'✓ ': '+'}${deck.monthBonus} P</span></div>
  <p>Erreiche an ${deck.monthTarget} Tagen alle Tagesziele.</p>
  <progress class="cyan" max="${deck.monthTarget}" value="${Math.min(days,deck.monthTarget)}" aria-label="Monatsziel"></progress>
  <p>${days} / ${deck.monthTarget} vollständige Tage</p>`;
 renderRanking();
 renderWheel(unlocked);
 renderCoins();
}

const signed = points => points>0?'+'+points:points<0?'−'+Math.abs(points):'0';
let animateSpin=false;

function renderWheel(unlocked) {
 const {spins,user}=state;
 const spin=spins.at(-1);
 const disc=$('#wheel-disc');
 const result=$('#wheel-result');
 const action=$('#wheel-action');
 disc.classList.toggle('wheel-spinning',Boolean(animateSpin && spin));
 disc.style.setProperty('--wheel-turn',spin?((animateSpin?1440:0)-spin.slot*36)+'deg':'0deg');
 animateSpin=false;
 result.hidden=!spin;
 result.replaceChildren();
 const pending=spin && spin.reward!==null && !spin.completed;
 const bonus=spins.length===1 && spin.bonus;
 action.hidden=Boolean(spin && !pending && !bonus);
 action.disabled=Boolean(user && !unlocked && !pending);
 action.textContent=pending?'Aufgabe erledigt':bonus?'Bonusdreh nutzen':user?'Rad drehen':'Anmelden';
 $('#wheel-lock').hidden=Boolean(unlocked || pending || action.hidden);
 for(const card of spins){
  const entry=document.createElement('div');
  const title=document.createElement('h3');
  title.textContent=card.title;
  const description=document.createElement('p');
  description.textContent=card.description;
  const score=document.createElement('strong');
  if(card.completed) score.textContent='✓ Erledigt · '+signed(card.reward)+' P';
  else if(card.reward===null) score.textContent=card.slot===8?'Gutschein im Münzkonto':signed(card.initial)+' P'+(card.bonus?' · Bonusdreh freigeschaltet':'');
  else if(card.initial<0) score.textContent=signed(card.initial)+' P aktuell · bei Erledigung kein Abzug';
  else score.textContent=signed(card.reward)+' P bei Erledigung';
  entry.append(title,description,score);
  result.append(entry);
 }
}

function renderRanking() {
 const target=$('#ranking');
 const seasonInfo=$('#season-info');
 const winner=$('#season-winner');
 seasonInfo.hidden=true;
 winner.hidden=true;
 for(const button of document.querySelectorAll('[data-ranking]')){
  button.setAttribute('aria-pressed',String(button.dataset.ranking===rankingPeriod));
 }
 target.replaceChildren();
 if(!state.user){
  const copy=document.createElement('p');
  copy.textContent='Melde dich an, um die Rangliste deiner Freunde zu sehen.';
  target.append(copy);
  return;
 }
 if(rankingPeriod==='seasonRanking'){
  const {start,end,winners}=state.season;
  const date=day=>day.split('-').reverse().join('.');
  seasonInfo.textContent=date(start)+' – '+date(end)+' · Die Gruppe spendiert Platz 1 einen Döner.';
  seasonInfo.hidden=false;
  if(winners.length){
   winner.textContent='Platz 1 der letzten Runde: '+winners.map(row=>row.handle).join(', ')+' · '+winners[0].points+' P'+(winners.length>1?' · Gleichstand':'');
   winner.hidden=false;
  }
 }
 const list=document.createElement('ol');
 list.className='ranking';
 const memberIds=new Map((state.coins?.friends||[]).map(member=>[member.handle,member.id]));
 let rank=0;
 let previous=null;
 state[rankingPeriod].forEach(({handle,points},index)=>{
  if(previous!==points) rank=index+1;
  previous=points;
  const row=document.createElement('li');
  const place=document.createElement('span');
  const memberId=memberIds.get(handle);
  const name=document.createElement(memberId?'button':'span');
  const score=document.createElement('strong');
  place.textContent=rank+'.';
  name.textContent=handle+(handle===state.user.handle?' · Du':'');
  if(memberId){
   name.type='button';
   name.className='member-link';
   name.setAttribute('aria-haspopup','dialog');
   name.addEventListener('click',()=>showMemberSummary(memberId,handle));
  }
  score.textContent=points+' P';
  row.append(place,name,score);
  list.append(row);
 });
 target.append(list);
}

const memberDialog=$('#member-summary');
let memberSummaryRequest=0;
$('#close-member-summary').addEventListener('click',()=>memberDialog.close());

async function showMemberSummary(id,handle){
 const request=++memberSummaryRequest;
 const owner=state.user.id;
 const content=$('#member-summary-content');
 $('#member-summary-title').textContent=handle;
 content.hidden=true;
 setError('#member-summary-status','Übersicht wird geladen …');
 memberDialog.showModal();
 const isCurrent=()=>request===memberSummaryRequest && memberDialog.open && owner===state.user?.id;
 try{
  const summary=await api('members/'+encodeURIComponent(id));
  if(!isCurrent()) return;
  $('#member-summary-title').textContent=summary.handle;
  showCoins($('#member-summary-balance'),summary.balance);
  const daily=$('#member-summary-daily');
  daily.replaceChildren();
  let reached=0;
  for(const {name,unit,target,amount} of summary.daily){
   const item=document.createElement('li');
   const label=document.createElement('span');
   const value=document.createElement('strong');
   label.textContent=name;
   value.textContent=amount+' / '+target+' '+unit;
   if(amount>=target){
    reached++;
    value.classList.add('member-goal-reached');
    value.append(' ✓');
   }
   item.append(label,value);
   daily.append(item);
  }
  const status=[reached+' / '+summary.daily.length+' Tagesziele erreicht'];
  if(summary.rest) status.push('Freier Tag');
  if(summary.workoutFinished) status.push('Workout abgeschlossen');
  $('#member-summary-progress').textContent=status.join(' · ');
  const weekly=$('#member-summary-weekly');
  weekly.replaceChildren();
  for(const name of summary.weekly){
   const item=document.createElement('li');
   item.textContent=name;
   weekly.append(item);
  }
  $('#member-summary-weekly-section').hidden=!summary.weekly.length;
  setError('#member-summary-status');
  content.hidden=false;
  loadMemberGallery(id,isCurrent);
 } catch(error){
  if(isCurrent()) setError('#member-summary-status',error.message);
 }
}

let portraitLoad;
const portraits=[...document.querySelectorAll('[data-portrait]')];
const portraitRetry=$('#portrait-retry');

function clearPortrait(portrait){
 const src=portrait.getAttribute('src');
 portrait.removeAttribute('src');
 if(src?.startsWith('blob:')) URL.revokeObjectURL(src);
}

async function loadPortrait(portrait,load){
 if(portraitLoad!==load || load.pending.has(portrait) || load.ready.has(portrait)) return;
 load.pending.add(portrait);
 try{
  const path='/portrait/'+portrait.dataset.portrait;
  let response;
  for(let attempt=0;attempt<2;attempt++){
   if(portraitLoad!==load) return;
   try{
    if(cloudUrl) await refreshCloudSession(attempt?load.rejectedToken:undefined);
    if(portraitLoad!==load || (cloudUrl&&!cloudSession)) return;
    const token=cloudSession?.access_token;
    const headers=cloudUrl?{apikey:cloudKey,Authorization:'Bearer '+token}:{};
    response=await timedFetch(cloudUrl?cloudUrl+path:'/api'+path,{headers});
    if(response.status===401 && token) load.rejectedToken=token;
    if(!response.ok || !response.headers.get('Content-Type')?.startsWith('image/')) throw new Error('Foto nicht verfügbar.');
    const blob=await response.blob();
    if(portraitLoad!==load) return;
    portrait.src=URL.createObjectURL(blob);
    await portrait.decode();
    load.ready.add(portrait);
    return;
   } catch {
    if(portraitLoad!==load) return;
    clearPortrait(portrait);
    if(!attempt) await new Promise(resolve=>setTimeout(resolve,750));
   }
  }
 } finally {
  load.pending.delete(portrait);
  if(portraitLoad===load) portraitRetry.hidden=load.pending.size>0 || load.ready.size===portraits.length;
 }
}

function syncPortraits(){
 const owner=state.user?.id;
 if(owner!==portraitLoad?.owner){
  portraits.forEach(clearPortrait);
  portraitLoad=owner?{owner,pending:new Set(),ready:new Set()}:undefined;
  portraitRetry.hidden=true;
 }
 if(!portraitLoad || portraitLoad.ready.size===portraits.length) return;
 portraitRetry.hidden=true;
 portraits.forEach(portrait=>loadPortrait(portrait,portraitLoad));
}

portraitRetry.addEventListener('click',syncPortraits);
window.addEventListener('online',()=>{if(state?.user) syncPortraits();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden && state?.user) syncPortraits();});

async function refresh() {
 const hadCloudSession=Boolean(cloudSession);
 state=await api('state');
 const signedIn=Boolean(state.user);
 if(!signedIn && memberDialog.open) memberDialog.close();
 syncVoiceArchive();
 syncSeasonMedia();
 for(const element of document.querySelectorAll('[data-member]')) element.hidden=!signedIn;
 $('#sign-in-panel').hidden=signedIn;
 $('#account').textContent=signedIn?'Abmelden':'Anmelden';
 syncPortraits();
 if(signedIn) render();
 else if(hadCloudSession && !cloudSession) setError('#notice','Deine Anmeldung ist abgelaufen. Bitte melde dich erneut an.');
 syncReportAccount();
}

function setError(selector,message='') {
 const box=$(selector);
 box.textContent=message;
 box.hidden=!message;
}

function authMode(isRegister) {
 register=isRegister;
 $('#auth-title').textContent=register?'Konto erstellen':'Anmelden';
 $('#auth-submit').textContent=$('#auth-title').textContent;
 $('#auth-mode').textContent=register?'Ich habe schon ein Konto':'Konto erstellen';
 $('#invite-label').hidden=!register;
 $('#invite-label input').required=register;
 $('#auth-form [name=password]').autocomplete=register?'new-password':'current-password';
 setError('#auth-error');
}

function showAuth() {
 authMode(false);
 $('#auth').showModal();
}

async function change(path,payload,focusSelector) {
 if(!state?.user){showAuth();return;}
 if(busy) return;
 busy=true;
 setError('#notice');
 try {
  await api(path,payload);
  await refresh();
  if(focusSelector) $(focusSelector)?.focus({preventScroll:true});
 } catch(error){setError('#notice',error.message);}
 finally{busy=false;}
}

function updateQuantityCard(form,card,amount){
 const tile=form.closest('.card');
 tile.querySelector('.points').textContent=estimatedPoints(card,amount)+' P';
 tile.querySelector('progress').value=Math.min(amount,card.target);
 tile.querySelector('.progress-label').textContent=amount+' / '+card.target+' '+card.unit+(amount>=card.target?' · ✓':'');
 renderDaySummary(visibleAmounts());
}

function refreshAfterQuantities(){
 clearTimeout(quantityRefresh);
 quantityRefresh=setTimeout(async ()=>{
  if(quantityQueue.size) return;
  if(busy){refreshAfterQuantities();return;}
  const active=document.activeElement;
  const form=active?.closest('.counter');
  const control=form && [...form.elements].indexOf(active);
  const draft=form?.elements.amount.value;
  const oldDay=state.deck.day;
  try{
   await refresh();
   if(form && state.deck.day===oldDay && (document.activeElement===document.body || document.activeElement===active)){
    const current=$(`[data-id="${form.dataset.id}"]`);
    if(active===form.elements.amount && current && draft!==form.elements.amount.defaultValue){
     current.elements.amount.value=draft;
    }
    current?.elements[control]?.focus({preventScroll:true});
   }
  } catch(error){setError('#notice',error.message);}
 },350);
}

async function flushQuantity(key,entry){
 if(entry.saving) return;
 entry.saving=true;
 try{
  let amount;
  do {
   if(state?.user?.id!==entry.owner) return;
   amount=entry.amount;
   const result=await api('quantity',{id:entry.id,day:entry.day,amount});
   playTrainingVoices(result.voiceIds,entry.owner);
   if(state.deck.day===entry.day && state.user?.id===entry.owner){
    const card=state.deck.daily.find(item=>item.id===entry.id);
    if(card) state.quantities=[...state.quantities.filter(item=>item.exercise!==entry.id),{exercise:entry.id,amount,points:estimatedPoints(card,amount)}];
   }
  } while(entry.amount!==amount);
 } catch(error){
  setError('#notice','Änderung nicht gespeichert. '+error.message);
 } finally {
  clearTimeout(entry.timer);
  quantityQueue.delete(key);
  refreshAfterQuantities();
 }
}

function saveAmount(form, delta) {
 if(!state?.user){showAuth();return;}
 if(busy || state.workoutFinished) return;
 const field=form.elements.amount;
 if(!form.reportValidity()) return;
 const amount=Math.min(10000,Math.max(0,Number(field.value)+delta));
 const id=form.dataset.id;
 const card=state.deck.daily.find(item=>item.id===id);
 if(cloudUrl && amount>=card.target) prepareTrainingAudio();
 const key=state.user.id+':'+state.deck.day+':'+id;
 const entry=quantityQueue.get(key)||{id,day:state.deck.day,owner:state.user.id,saving:false};
 entry.amount=amount;
 quantityQueue.set(key,entry);
 field.value=amount;
 field.defaultValue=amount;
 updateQuantityCard(form,card,amount);
 setError('#notice');
 clearTimeout(entry.timer);
 entry.timer=setTimeout(()=>flushQuantity(key,entry),180);
}

$('#daily').addEventListener('click',event=>{
 if(event.target.closest('#workout-finish')){
  if(!busy && !quantityQueue.size && !state.workoutFinished){
   setError('#workout-photo-status');
   $('#workout-photo').showModal();
  }
  return;
 }
 const button=event.target.closest('[data-delta]');
 if(button) saveAmount(button.form,Number(button.dataset.delta));
});
$('#daily').addEventListener('submit',event=>{
 event.preventDefault();
 saveAmount(event.target,0);
});
$('#weekly').addEventListener('click',event=>{
 const button=event.target.closest('[data-mark]');
 if(button) change('mark',{id:button.dataset.mark,period:state.deck.week,done:button.getAttribute('aria-pressed')!=='true'},`[data-mark="${button.dataset.mark}"]`);
});
$('.segments').addEventListener('click',event=>{
 if(!event.target.dataset.ranking || !state) return;
 rankingPeriod=event.target.dataset.ranking;
 renderRanking();
});
$('#account').addEventListener('click',()=>{
 if(state?.user) change('logout',{},'#account');
 else showAuth();
});
$('#wheel-action').addEventListener('click',async event=>{
 if(!state?.user){showAuth();return;}
 if(busy) return;
 const button=event.currentTarget;
 const latest=state.spins.at(-1);
 const spinning=!latest || latest.reward===null;
 const turn=spinning?state.spins.length+1:latest.turn;
 busy=true;
 button.disabled=true;
 button.setAttribute('aria-busy','true');
 setError('#notice');
 try {
  await api(spinning?'wheel/spin':'wheel/complete',{day:state.deck.day,turn});
  animateSpin=spinning;
  await refresh();
 } catch(error){
  setError('#notice',error.message);
  if(spinning) await refresh().catch(()=>{});
 } finally {
  const pending=state.spins.some(card=>card.reward!==null && !card.completed);
  button.removeAttribute('aria-busy');
  const unlocked=cloudUrl?state.workoutFinished||state.spins.length>0:state.activeDays.includes(state.deck.day);
  button.disabled=!pending && !unlocked;
  busy=false;
 }
});
$('#auth-mode').addEventListener('click',()=>authMode(!register));
$('#close-auth').addEventListener('click',()=>$('#auth').close());
$('#auth-form').addEventListener('submit',async event=>{
 event.preventDefault();
 const button=$('#auth-submit');
 if(button.disabled) return;
 button.disabled=true;
 setError('#auth-error');
 try {
  await api(register?'register':'login',Object.fromEntries(new FormData(event.target)));
  await refresh();
  if(!state.user) throw new Error('Die Anmeldung konnte nicht abgeschlossen werden. Bitte versuche es erneut.');
  setError('#notice');
  $('#auth').close();
  event.target.reset();
 } catch(error){setError('#auth-error',error.message);}
 finally{button.disabled=false;}
});

const reportLabels = {open:'Offen',acknowledged:'Quittiert',resolved:'Abgeschlossen'};
const reportDate = new Intl.DateTimeFormat('de-DE',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Berlin'});
let reportData;
let reportAccount;
let reportRequest=0;

function renderReports() {
 const list=$('#report-list');
 list.replaceChildren();
 const {admin,reports}=reportData;
 $('#report-heading').textContent=admin?'Admin-Postfach':'Meine Meldungen';
 $('#report-filter-label').hidden=!admin;
 $('#report-open').hidden=!admin;
 $('#report-open').textContent=reports.filter(item=>item.status==='open').length+' offen';
 const filter=admin?$('#report-filter').value:'all';
 const visible=reports.filter(item=>filter==='all'||item.status===filter);
 if(!visible.length){
  const empty=document.createElement('p');
  empty.textContent=filter==='all'?'Noch keine Meldungen.':'Keine Meldungen mit diesem Status.';
  list.append(empty);
 }
 for(const item of visible){
  const card=document.createElement('article');
  card.className='report-card';
  const heading=document.createElement('h4');
  heading.textContent=item.title;
  const meta=document.createElement('p');
  meta.className='report-meta';
  meta.textContent=[item.kind==='bug'?'Fehler':'Feedback',item.handle,reportDate.format(item.created),reportLabels[item.status]].filter(Boolean).join(' · ');
  const message=document.createElement('p');
  message.className='report-message';
  message.textContent=item.message;
  card.append(heading,meta,message);
  if(admin){
   const actions=document.createElement('div');
   actions.className='report-actions';
   const choices=item.status==='open'?[['acknowledged','Quittieren'],['resolved','Abschließen']]
    :item.status==='acknowledged'?[['resolved','Abschließen'],['open','Wieder öffnen']]:[['open','Wieder öffnen']];
   for(const [status,label] of choices){
    const button=document.createElement('button');
    button.type='button';
    button.className='outline';
    button.textContent=label;
    button.dataset.id=item.id;
    button.dataset.status=status;
    actions.append(button);
   }
   card.append(actions);
  }
  list.append(card);
 }
}

async function refreshReports() {
 const request=++reportRequest;
 const account=state?.user?.id;
 const data=await api('reports');
 if(request!==reportRequest || state?.user?.id!==account) return;
 reportData=data;
 renderReports();
}

function syncReportAccount() {
 const user=state?.user;
 $('#report-guest').hidden=Boolean(user);
 $('#report-area').hidden=!user;
 if(reportAccount===user?.id) return;
 reportAccount=user?.id;
 reportRequest++;
 reportData=undefined;
 $('#report-list').replaceChildren();
 $('#report-form').reset();
 $('#report-filter').value='all';
 $('#report-heading').textContent='Meine Meldungen';
 $('#report-filter-label').hidden=true;
 $('#report-open').hidden=true;
 setError('#report-status');
 if(user) refreshReports().catch(error=>setError('#report-status',error.message));
}

$('#report-login').addEventListener('click',showAuth);
$('#report-filter').addEventListener('change',()=>{if(reportData) renderReports();});
window.addEventListener('hashchange',()=>{
 if(location.hash==='#feedback' && state?.user) refreshReports().catch(error=>setError('#report-status',error.message));
});
$('#report-form').addEventListener('submit',async event=>{
 event.preventDefault();
 const form=event.target;
 const button=form.querySelector('button');
 button.disabled=true;
 setError('#report-status');
 try {
  await api('reports',Object.fromEntries(new FormData(form)));
  form.reset();
  setError('#report-status','Deine Meldung wurde gesendet.');
  await refreshReports();
 } catch(error){setError('#report-status',error.message);}
 finally{button.disabled=false;}
});
$('#report-list').addEventListener('click',async event=>{
 const button=event.target.closest('[data-status]');
 if(!button) return;
 const actions=button.parentElement.querySelectorAll('button');
 actions.forEach(action=>action.disabled=true);
 setError('#report-status');
 try {
  await api('reports/status',{id:Number(button.dataset.id),status:button.dataset.status});
  await refreshReports();
  setError('#report-status','Status aktualisiert.');
 } catch(error){setError('#report-status',error.message);}
 finally{actions.forEach(action=>action.disabled=false);}
});
if(location.protocol==='file:'){
 const notice=$('#notice');
 const link=document.createElement('a');
 link.href='http://127.0.0.1:3000/';
 link.textContent='Baywatch Bootcamp im lokalen Server öffnen';
 notice.append(link);
 notice.hidden=false;
} else {
 refresh().catch(error=>setError('#notice',error.message));
}
const coinForm=$('#coin-form');
const coinKinds={voice:'Sprachnachricht',symbol:'Symbol-Prank',exercise:'Extraübung',return:'Retourkutsche'};
const symbolNames=['Kackhaufen','Herz','Pfirsich','Aubergine','Mittelfinger'];
let coinOwner;
let recording;
let recorder;
let previewUrl;
let recordingPending=false;

function setOptions(select,options){
 const previous=select.value;
 select.replaceChildren(...options.map(([value,label])=>new Option(label,value)));
 if(options.some(([value])=>String(value)===previous)) select.value=previous;
}
function clearRecording(){
 recording=undefined;
 if(previewUrl) URL.revokeObjectURL(previewUrl);
 previewUrl=undefined;
 $('#coin-preview').removeAttribute('src');
 $('#coin-preview').hidden=true;
}
function coinControls(){
 const wallet=state.coins;
 const kind=coinForm.elements.kind.value;
 const rest=kind==='rest';
 $('#coin-target').hidden=rest;
 $('#coin-detail').hidden=!['symbol','exercise'].includes(kind);
 $('#coin-recording').hidden=kind!=='voice';
 $('#rest-info').hidden=!rest;
 $('#prank-limit').hidden=rest;
 $('#rest-info').textContent=state.workoutFinished?'Dein Workout ist für heute abgeschlossen.':wallet.rest?'Heute ist bereits ein freier Tag.':wallet.vouchers?wallet.vouchers+' Gutschein(e) verfügbar. Beim Einlösen wird ein Gutschein genutzt.':'Du bekommst die regulären Zielpunkte. Der Tag zählt zum Monatsziel.';
 $('#coin-submit').textContent=rest?(wallet.vouchers?'Gutschein für heute einlösen':'Heute freikaufen'):'Senden';
 setOptions(coinForm.elements.detail,kind==='symbol'?wallet.symbols.map((symbol,index)=>[symbol,symbol+' '+symbolNames[index]]):wallet.exercises.map(exercise=>[exercise,exercise]));
 $('#coin-submit').disabled=rest?state.workoutFinished||wallet.rest||(!wallet.vouchers&&wallet.balance<wallet.prices.rest):!wallet.friends.length||wallet.balance<wallet.prices[kind]||(kind==='voice'&&!recording);
}
function renderCoins(){
 const wallet=state.coins;
 const owner=state.user?.id;
 if(coinOwner!==owner){
  coinOwner=owner;
  if(recorder?.state==='recording') recorder.stop();
  clearRecording();
  coinForm.reset();
  setError('#coin-status');
 }
 $('#coin-area').hidden=!wallet;
 $('#coin-login').hidden=Boolean(wallet);
 $('#coin-balance').hidden=!wallet;
 $('#coin-history').replaceChildren();
 $('#coin-inbox').replaceChildren();
 if(!wallet) return;
 showCoins($('#coin-balance'),wallet.balance,wallet.vouchers?' · '+wallet.vouchers+' Gutschein(e)':'');
 setOptions(coinForm.elements.target,wallet.friends.map(friend=>[friend.id,friend.handle]));
 coinControls();
 for(const entry of wallet.history){
  const row=document.createElement('li');
  showCoins(row,signed(entry.amount),' · '+entry.label+' · '+entry.day);
  $('#coin-history').append(row);
 }
 const inbox=$('#coin-inbox');
 if(!wallet.items.length){
  const empty=document.createElement('p');
  empty.textContent='Hier erscheinen deine Nachrichten und Pranks.';
  inbox.append(empty);
 }
 for(const item of wallet.items){
  const incoming=item.recipient===owner;
  const card=document.createElement('article');
  card.className='report-card';
  const title=document.createElement('h4');
  title.textContent=coinKinds[item.kind]+' · '+(incoming?'von '+item.fromName:'an '+item.toName);
  card.append(title);
  if(item.kind==='voice'){
   const audio=document.createElement('audio');
   audio.controls=true;
   audio.preload='none';
   if(cloudUrl){
    const play=document.createElement('button');
    play.type='button';
    play.className='outline coin-inbox-action';
    play.textContent='Sprachnachricht abspielen';
    play.addEventListener('click',async ()=>{
     play.disabled=true;
     try{
      const {url}=await api('voice/'+item.id);
      audio.src=url;
      audio.hidden=false;
      await audio.play();
     } catch(error){setError('#coin-status',error.message);}
     finally{play.disabled=false;}
    });
    audio.hidden=true;
    card.append(play);
   } else {
    audio.src='/api/voice/'+item.id;
   }
   card.append(audio);
  } else {
   const detail=document.createElement('p');
   detail.textContent=item.detail+(item.kind==='symbol'?' · bis '+item.expires:'');
   card.append(detail);
  }
  const addButton=(label,action)=>{
   const button=document.createElement('button');
   button.className='outline coin-inbox-action';
   button.type='button';
   button.textContent=label;
   button.addEventListener('click',action);
   card.append(button);
  };
  if(['exercise','return'].includes(item.kind)){
   const status=document.createElement('p');
   const done=item.kind==='return'?item.sender_done&&item.recipient_done:item.recipient_done;
   status.textContent=done?'Erledigt':item.status==='accepted'?'Angenommen':item.status==='declined'?'Abgelehnt':'Antwort offen';
   if(item.kind==='return'&&item.status==='accepted') status.textContent+=' · '+(Number(item.sender_done)+Number(item.recipient_done))+' / 2 fertig';
   card.append(status);
   if(incoming&&item.status==='pending'){
    addButton('Annehmen',()=>sendCoin('respond',{id:item.id,action:'accept'}));
    addButton('Ablehnen',()=>sendCoin('respond',{id:item.id,action:'decline'}));
   }
   if(item.status==='accepted'&&(incoming?!item.recipient_done:item.kind==='return'&&!item.sender_done)){
    addButton('Erledigt',()=>sendCoin('respond',{id:item.id,action:'done'}));
   }
  }
  if(incoming&&item.kind!=='return'&&item.canReturn){
   const choices=document.createElement('select');
   choices.setAttribute('aria-label','Übung für die Retourkutsche');
   if(item.kind!=='exercise'){
    setOptions(choices,wallet.exercises.map(exercise=>[exercise,exercise]));
    card.append(choices);
   }
   addButton('Retourkutsche · 4 Münzen',()=>sendCoin('buy',{kind:'return',source:item.id,detail:choices.value}));
  }
  inbox.append(card);
 }
}
const voiceArchive=$('#voice-archive');
const archiveList=$('#voice-archive-list');
const archiveMore=$('#voice-archive-more');
let archiveScope;
let archiveRequest=0;
let archiveBefore=null;

function syncVoiceArchive(){
 const scope=state.user?state.user.id+':'+state.season.start:null;
 if(scope===archiveScope) return;
 archiveScope=scope;
 archiveRequest++;
 archiveBefore=null;
 archiveList.replaceChildren();
 archiveMore.hidden=true;
 setError('#voice-archive-status');
 if(!scope) voiceArchive.open=false;
 else if(voiceArchive.open) loadVoiceArchive();
}

function archiveCard(item){
 const card=document.createElement('article');
 card.className='report-card';
 const title=document.createElement('h4');
 title.textContent=item.fromName+' → '+item.toName;
 const date=document.createElement('p');
 date.textContent=dateFormat.format(new Date(item.day+'T00:00:00Z'));
 const play=document.createElement('button');
 play.type='button';
 play.className='outline coin-inbox-action';
 play.textContent='Anhören';
 const audio=document.createElement('audio');
 audio.controls=true;
 audio.preload='none';
 audio.hidden=true;
 play.addEventListener('click',async ()=>{
  play.disabled=true;
  setError('#voice-archive-status');
  try{
   const path='voice-archive/'+item.id;
   const url=cloudUrl?(await api(path)).url:'/api/'+path;
   if(!card.isConnected || !voiceArchive.open) return;
   for(const other of archiveList.querySelectorAll('audio')) if(other!==audio) other.pause();
   audio.src=url;
   audio.hidden=false;
   await audio.play().catch(()=>{
    if(card.isConnected) setError('#voice-archive-status','Starte die Aufnahme über die Wiedergabetaste.');
   });
  }catch(error){
   if(card.isConnected) setError('#voice-archive-status',error.message);
  }finally{play.disabled=false;}
 });
 card.append(title,date,play);
 card.append(audio);
 return card;
}

async function loadVoiceArchive(append=false){
 if(!archiveScope) return;
 const request=++archiveRequest;
 archiveMore.disabled=true;
 setError('#voice-archive-status','Archiv wird geladen …');
 try{
  const rows=await api(append?'voice-archive?before='+archiveBefore:'voice-archive');
  if(request!==archiveRequest) return;
  const page=rows.slice(0,30);
  if(!append) archiveList.replaceChildren();
  archiveList.append(...page.map(archiveCard));
  archiveBefore=rows.length>30?page.at(-1).id:null;
  archiveMore.hidden=archiveBefore===null;
  setError('#voice-archive-status',!append&&!page.length?'Es gibt noch keine Aufnahmen für dich.':'');
 }catch(error){
  if(request===archiveRequest) setError('#voice-archive-status',error.message);
 }finally{
  if(request===archiveRequest) archiveMore.disabled=false;
 }
}
voiceArchive.addEventListener('toggle',()=>{
 if(voiceArchive.open) loadVoiceArchive();
 else for(const audio of archiveList.querySelectorAll('audio')) audio.pause();
});
archiveMore.addEventListener('click',()=>loadVoiceArchive(true));

async function sendCoin(action,payload){
 if(busy) return false;
 busy=true;
 setError('#coin-status');
 try{
  await api('coins/'+action,{...payload,day:state.deck.day});
  await refresh();
  if(action==='buy' && payload.kind==='voice'){
   if(voiceArchive.open) loadVoiceArchive();
   setError('#coin-status','Gesendet. Die Aufnahme ist jetzt im Season-Archiv.');
  }else setError('#coin-status','Gespeichert.');
  return true;
 } catch(error){
  setError('#coin-status',error.message);
  return false;
 } finally {busy=false;}
}
$('#coin-login').addEventListener('click',showAuth);
coinForm.elements.kind.addEventListener('change',coinControls);
coinForm.addEventListener('submit',async event=>{
 event.preventDefault();
 const kind=coinForm.elements.kind.value;
 const target=coinForm.elements.target.value;
 const payload={kind,target:cloudUrl?target:Number(target),detail:coinForm.elements.detail.value};
 if(kind==='voice'){
  if(!recording) return;
  Object.assign(payload,recording);
 }
 if(await sendCoin('buy',payload)&&kind==='voice'){
  clearRecording();
  coinControls();
 }
});
$('#coin-record').addEventListener('click',async ()=>{
 const button=$('#coin-record');
 if(recorder?.state==='recording'){recorder.stop();return;}
 if(recordingPending) return;
 const owner=coinOwner;
 let stream;
 recordingPending=true;
 try{
  const types=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'];
  const mimeType=types.find(type=>globalThis.MediaRecorder?.isTypeSupported(type));
  if(!mimeType||!navigator.mediaDevices) throw Error('Für die Aufnahme brauchst du einen unterstützten Browser mit Mikrofonzugriff.');
  stream=await navigator.mediaDevices.getUserMedia({audio:true});
  if(coinOwner!==owner){stream.getTracks().forEach(track=>track.stop());return;}
  clearRecording();
  coinControls();
  const session=new MediaRecorder(stream,{mimeType,audioBitsPerSecond:64000});
  recorder=session;
  const chunks=[];
  session.ondataavailable=event=>{if(event.data.size) chunks.push(event.data);};
  session.onstop=async ()=>{
   clearTimeout(timer);
   stream.getTracks().forEach(track=>track.stop());
   button.textContent='Aufnehmen (max. 20 Sek.)';
   if(coinOwner!==owner) return;
   const detail=mimeType.split(';')[0];
   const blob=new Blob(chunks,{type:detail});
   if(!blob.size||blob.size>600000){setError('#coin-status','Die Aufnahme ist leer oder zu groß.');return;}
   const bytes=new Uint8Array(await blob.arrayBuffer());
   if(coinOwner!==owner||recorder!==session) return;
   recording={detail,audio:bytes.toBase64?bytes.toBase64():btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join(''))};
   previewUrl=URL.createObjectURL(blob);
   $('#coin-preview').src=previewUrl;
   $('#coin-preview').hidden=false;
   coinControls();
  };
  session.start();
  const timer=setTimeout(()=>{if(session.state==='recording') session.stop();},20000);
  button.textContent='Aufnahme stoppen';
  setError('#coin-status');
 } catch(error){
  stream?.getTracks().forEach(track=>track.stop());
  setError('#coin-status',error.message);
 } finally {recordingPending=false;}
});
const challengeEditor=$('#challenge-editor');
const challengeForm=$('#challenge-form');
let challengeEntries=[];
function showChallengeEntry(){
 const fields=challengeForm.elements;
 const daily=fields.kind.value==='daily';
 const entry=challengeEntries.find(item=>item.id===fields.entry.value);
 fields.name.value=entry?.name||'';
 fields.hint.value=entry?.hint||'';
 fields.enabled.checked=entry?.enabled??true;
 fields.unit.value=entry?.unit||'Wdh.';
 fields.target.value=entry?.target??10;
 fields.goalPoints.value=entry?.goalPoints??60;
 fields.step.value=entry?.step??1;
 fields.category.value=entry?.category||categories[0];
 fields.difficulty.value=entry?.difficulty||'Mittel';
 fields.points.readOnly=Boolean(cloudUrl);
 fields.points.value=cloudUrl?weeklyDifficulty[fields.difficulty.value].points:entry?.points??25;
 $('#challenge-daily').hidden=!daily;
 $('#challenge-daily').disabled=!daily;
 $('#challenge-weekly').hidden=daily;
 $('#challenge-weekly').disabled=daily;
 fields.hint.required=!daily;
 showChallengeRates();
}
function showChallengeRates(){
 const fields=challengeForm.elements;
 const target=fields.target.valueAsNumber;
 const goalPoints=fields.goalPoints.valueAsNumber;
 if(!Number.isInteger(target)||target<1||!Number.isInteger(goalPoints)||goalPoints<1||goalPoints>75){
  $('#challenge-rate').textContent='';
  return;
 }
 const card={target,goalPoints};
 const [normal,bonus]=rates(card);
 const unit=fields.unit.value==='Sek.'?'Sekunde':'Wiederholung';
 $('#challenge-rate').textContent=normal+' Punkte pro '+unit+' · '+bonus+' Bonus-Punkte pro '+unit+' · maximal '+estimatedPoints(card,target*2)+' Punkte';
}
function showChallengeOptions(){
 const fields=challengeForm.elements;
 const entries=challengeEntries.filter(item=>item.kind===fields.kind.value);
 setOptions(fields.entry,[['','Neue Aufgabe'],...entries.map(item=>[item.id,item.name+(item.enabled?'':' · inaktiv')])]);
 showChallengeEntry();
}
async function loadChallengeEditor(){
 const owner=state.user?.id;
 const {entries}=await api('admin/challenges');
 if(state.user?.id!==owner||!state.user?.admin) return;
 challengeEntries=entries;
 showChallengeOptions();
}
challengeEditor.addEventListener('toggle',()=>{
 if(challengeEditor.open&&state?.user?.admin) loadChallengeEditor().catch(error=>setError('#challenge-status',error.message));
});
challengeForm.elements.kind.addEventListener('change',showChallengeOptions);
challengeForm.elements.entry.addEventListener('change',showChallengeEntry);
challengeForm.elements.difficulty.addEventListener('change',event=>{
 if(cloudUrl) challengeForm.elements.points.value=weeklyDifficulty[event.target.value].points;
});
for(const name of ['target','goalPoints','unit']) challengeForm.elements[name].addEventListener('input',showChallengeRates);
challengeForm.addEventListener('submit',async event=>{
 event.preventDefault();
 const fields=challengeForm.elements;
 const button=challengeForm.querySelector('button');
 if(button.disabled) return;
 const kind=fields.kind.value;
 const entry={id:fields.entry.value,kind,name:fields.name.value,hint:fields.hint.value,enabled:fields.enabled.checked};
 if(kind==='daily') Object.assign(entry,{unit:fields.unit.value,target:fields.target.valueAsNumber,step:fields.step.valueAsNumber,goalPoints:fields.goalPoints.valueAsNumber});
 else Object.assign(entry,{category:fields.category.value,difficulty:fields.difficulty.value,points:fields.points.valueAsNumber});
 button.disabled=true;
 setError('#challenge-status');
 try{
  await api('admin/challenges',entry);
  await loadChallengeEditor();
  setError('#challenge-status','Gespeichert. Die Änderung gilt ab '+(kind==='daily'?'dem nächsten Tag.':'der nächsten Wochen-Auslosung.'));
 } catch(error){setError('#challenge-status',error.message);}
 finally{button.disabled=false;}
});
const berlinDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'});
async function refreshNewDay(){
 if(!state?.user || busy || document.hidden || berlinDay.format(new Date())===state.deck.day) return;
 busy=true;
 try{await refresh();}
 catch(error){setError('#notice',error.message);}
 finally{busy=false;}
}
if(location.protocol!=='file:'){
 setInterval(refreshNewDay,1000);
 document.addEventListener('visibilitychange',refreshNewDay);
}
$('#points-reset').addEventListener('submit',async event=>{
 event.preventDefault();
 if(busy) return;
 busy=true;
 const form=event.target;
 const button=form.querySelector('button');
 button.disabled=true;
 setError('#reset-status');
 try{
  await api('admin/reset-points',{...Object.fromEntries(new FormData(form)),day:state.deck.day});
  form.reset();
  await refresh();
  setError('#reset-status','Die Punktekonten wurden zurückgesetzt.');
 } catch(error){setError('#reset-status',error.message);}
 finally{
  form.elements.password.value='';
  button.disabled=false;
  busy=false;
 }
});
const memberAdminForm=$('#member-admin-form');
let memberAdminRetry;
memberAdminForm.elements.kind.addEventListener('change',()=>{
 const reset=memberAdminForm.elements.kind.value==='reset-pranks';
 $('#member-coin-fields').disabled=reset;
 $('#member-coin-fields').hidden=reset;
 $('#member-reset-info').hidden=!reset;
});
memberAdminForm.addEventListener('submit',async event=>{
 event.preventDefault();
 if(!state?.user?.admin||busy) return;
 const {member,kind,amount,reason}=memberAdminForm.elements;
 const reset=kind.value==='reset-pranks';
 const handle=member.selectedOptions[0]?.textContent;
 if(reset && !window.confirm('Alle gesendeten und empfangenen Pranks von '+handle+' zurücksetzen?')) return;
 const payload={member:member.value,kind:reset?'reset-pranks':'coins',
  delta:reset?null:amount.valueAsNumber*(kind.value==='take'?-1:1),reason:reset?null:reason.value.trim()};
 const signature=JSON.stringify(payload);
 if(memberAdminRetry?.signature!==signature) memberAdminRetry={signature,requestId:crypto.randomUUID()};
 busy=true;
 const button=memberAdminForm.querySelector('button');
 button.disabled=true;
 setError('#member-admin-status');
 try{
  const result=await api('admin/members',{...payload,requestId:memberAdminRetry.requestId});
  if(!result.audioCleanupPending) memberAdminRetry=undefined;
  const message=reset?handle+' · '+result.removed+' Pranks zurückgesetzt.'
   :handle+' · Neuer Kontostand '+result.balance+' Münzen.';
  setError('#member-admin-status',message+(result.audioCleanupPending?' Das Entfernen der Audiodateien kann erneut versucht werden.':''));
  await refresh().catch(error=>setError('#notice',error.message));
 }catch(error){setError('#member-admin-status',error.message);}
 finally{button.disabled=false;busy=false;}
});

const photoDialog=$('#workout-photo');
const photoForm=$('#workout-photo-form');
$('#close-workout-photo').addEventListener('click',()=>{if(!busy) photoDialog.close();});
photoDialog.addEventListener('cancel',event=>{if(busy) event.preventDefault();});
photoForm.addEventListener('submit',async event=>{
 event.preventDefault();
 if(busy || !state?.user || state.workoutFinished || quantityQueue.size) return;
 const file=photoForm.elements.photo.files[0];
 if(!file) return;
 busy=true;
 const submit=photoForm.querySelector('button');
 submit.disabled=true;
 setError('#workout-photo-status','Foto wird vorbereitet …');
 try{
  const day=state.deck.day;
  const {makeWorkoutPhoto}=await import('./season-media.mjs');
  const photo=await makeWorkoutPhoto(file);
  setError('#workout-photo-status','Foto wird hochgeladen …');
  await api('workout/finish',{day,photo});
  await refresh();
  photoDialog.close();
  photoForm.reset();
  if(galleryVisible) loadGallery();
 }catch(error){
  setError('#workout-photo-status',error.message);
 }finally{
  submit.disabled=false;
  busy=false;
 }
});

const gallery=$('#workout-gallery');
const galleryStatus=$('#gallery-status');
const galleryGrid=$('#gallery-grid');
const galleryControls=$('#gallery-controls');
const galleryLinks=new Map();
const galleryPageSize=6;
const photoPreview=$('#photo-preview');
const previewImage=$('#photo-preview-image');
let galleryKey;
let galleryPhotos;
let galleryVisible=false;
let galleryPaused=false;
let galleryIndex=0;
let galleryRequest=0;

$('#close-photo-preview').addEventListener('click',()=>photoPreview.close());
photoPreview.addEventListener('close',()=>previewImage.removeAttribute('src'));

function galleryLink(id){
 const saved=galleryLinks.get(id);
 if(saved && saved.expires>Date.now()) return saved.promise;
 const promise=api('gallery/'+id).then(result=>result.url).catch(error=>{
  if(galleryLinks.get(id)?.promise===promise) galleryLinks.delete(id);
  throw error;
 });
 galleryLinks.set(id,{promise,expires:Date.now()+540000});
 return promise;
}

function galleryTile({id,day,handle},showHandle=true){
 const button=document.createElement('button');
 button.type='button';
 button.className='gallery-tile';
 button.disabled=true;
 const label=handle+' · '+dateFormat.format(new Date(day+'T00:00:00Z'));
 button.setAttribute('aria-label','Workout-Foto öffnen: '+label);
 const photo=document.createElement('img');
 photo.alt='';
 const caption=document.createElement('span');
 caption.textContent=showHandle?handle:day.split('-').reverse().join('.');
 button.append(photo,caption);
 photo.addEventListener('load',()=>{button.disabled=false;});
 photo.addEventListener('error',()=>{caption.textContent='Foto nicht verfügbar';});
 galleryLink(id).then(url=>{
  if(button.isConnected) photo.src=url;
 }).catch(()=>{
  caption.textContent='Foto nicht verfügbar';
 });
 button.addEventListener('click',async ()=>{
  try{
   const url=await galleryLink(id);
   if(!button.isConnected || photoPreview.open) return;
   $('#photo-preview-title').textContent=label;
   previewImage.alt='Workout-Foto von '+handle;
   previewImage.src=url;
   photoPreview.showModal();
  }catch{caption.textContent='Foto nicht verfügbar';}
 });
 return button;
}

async function loadMemberGallery(id,isCurrent){
 const section=$('#member-gallery');
 const grid=$('#member-gallery-grid');
 const status=$('#member-gallery-status');
 const more=$('#member-gallery-more');
 section.hidden=!cloudUrl;
 if(!cloudUrl) return;
 grid.replaceChildren();
 more.hidden=true;
 status.textContent='Fotos werden geladen …';
 try{
  const photos=await api('gallery?member='+encodeURIComponent(id));
  if(!isCurrent()) return;
  const appendPhotos=()=>{
   const start=grid.childElementCount;
   grid.append(...photos.slice(start,start+galleryPageSize).map(photo=>galleryTile(photo,false)));
   more.hidden=grid.childElementCount>=photos.length;
  };
  more.onclick=appendPhotos;
  appendPhotos();
  status.textContent=photos.length?'':'Für diese Season gibt es noch keine Fotos.';
 }catch(error){
  if(isCurrent()) status.textContent=error.message;
 }
}

async function loadGallery(quiet=false){
 const request=++galleryRequest;
 if(!quiet) galleryStatus.textContent='Fotos werden geladen …';
 try{
  const photos=await api('gallery');
  if(request!==galleryRequest) return;
  if(quiet && galleryPhotos?.length===photos.length){
   const currentIds=new Set(galleryPhotos.map(photo=>photo.id));
   if(photos.every(photo=>currentIds.has(photo.id))) return;
  }
  for(let i=photos.length-1;i>0;i--){
   const j=Math.floor(Math.random()*(i+1));
   [photos[i],photos[j]]=[photos[j],photos[i]];
  }
  galleryPhotos=photos;
  galleryControls.hidden=photos.length<=galleryPageSize;
  if(photos.length) showGalleryPhotos(0);
  else{
   galleryGrid.replaceChildren();
   galleryStatus.textContent='Das erste Workout-Foto der Season erscheint hier.';
  }
 }catch(error){
  if(request===galleryRequest && !quiet) galleryStatus.textContent=error.message;
 }
}

function showGalleryPhotos(index){
 if(!galleryPhotos?.length) return;
 galleryIndex=(index+galleryPhotos.length)%galleryPhotos.length;
 const visible=Array.from({length:Math.min(galleryPageSize,galleryPhotos.length)},(_,i)=>
  galleryPhotos[(galleryIndex+i)%galleryPhotos.length]);
 galleryGrid.replaceChildren(...visible.map(photo=>galleryTile(photo)));
 galleryStatus.textContent='';
}

$('#gallery-prev').addEventListener('click',()=>showGalleryPhotos(galleryIndex-galleryPageSize));
$('#gallery-next').addEventListener('click',()=>showGalleryPhotos(galleryIndex+galleryPageSize));
$('#gallery-pause').addEventListener('click',event=>{
 galleryPaused=!galleryPaused;
 event.currentTarget.setAttribute('aria-pressed',String(galleryPaused));
 event.currentTarget.textContent=galleryPaused?'Fortsetzen':'Pausieren';
});
if(cloudUrl){
 if('IntersectionObserver' in window){
  new IntersectionObserver(([entry])=>{
   galleryVisible=entry.isIntersecting;
   if(galleryVisible && galleryKey && !galleryPhotos) loadGallery();
  }).observe(gallery);
 }else galleryVisible=true;
 setInterval(()=>{
  if(galleryVisible && !galleryPaused && !document.hidden && !photoPreview.open && !galleryGrid.contains(document.activeElement)
   && galleryPhotos?.length>galleryPageSize) showGalleryPhotos(galleryIndex+galleryPageSize);
 },20000);
 setInterval(()=>{if(galleryVisible && galleryKey && !document.hidden) loadGallery(true);},120000);
}

const mediaAdmin=$('#media-admin');
const mediaForm=$('#media-admin-form');
const mediaSelect=mediaForm.elements.season;
const mediaDownload=$('#media-download');
const mediaDeleteButtons=[...document.querySelectorAll('[data-delete-media]')];
let mediaOwner;
let mediaRequest=0;
let mediaBusy=false;
let mediaDownloaded=false;
let mediaZipUrl;
let mediaZipSeason;
let mediaBackupId;
const backedUpMedia=new Set();

function updateMediaDeleteButtons(){
 for(const button of mediaDeleteButtons){
  const kind=button.dataset.deleteMedia;
  button.disabled=mediaBusy||!mediaDownloaded||!(kind==='all'?backedUpMedia.size:backedUpMedia.has(kind));
 }
}

function clearMediaDownload(){
 if(mediaZipUrl) URL.revokeObjectURL(mediaZipUrl);
 mediaZipUrl=undefined;
 mediaZipSeason=undefined;
 mediaBackupId=undefined;
 backedUpMedia.clear();
 mediaDownload.removeAttribute('href');
 mediaDownload.hidden=true;
 mediaDownloaded=false;
 updateMediaDeleteButtons();
}

function syncSeasonMedia(){
 const key=cloudUrl&&state.user?state.user.id+':'+state.season.start:null;
 gallery.hidden=!key;
 if(key!==galleryKey){
  galleryKey=key;
  galleryRequest++;
  galleryPhotos=undefined;
  galleryGrid.replaceChildren();
  galleryControls.hidden=true;
  if(photoPreview.open) photoPreview.close();
  galleryLinks.clear();
  galleryStatus.textContent='';
  if(galleryKey&&galleryVisible) loadGallery();
 }
 const adminId=cloudUrl&&state.user?.admin?state.user.id:null;
 mediaAdmin.hidden=!adminId;
 if(adminId!==mediaOwner){
  mediaOwner=adminId;
  mediaRequest++;
  clearMediaDownload();
  mediaSelect.replaceChildren();
  if(adminId&&mediaAdmin.open) loadMediaSeasons().catch(error=>setError('#media-status',error.message));
 }
}

function mediaSize(bytes){
 return new Intl.NumberFormat('de-DE',{maximumFractionDigits:1}).format(bytes/1000000)+' MB';
}

async function loadMediaSeasons(){
 const request=++mediaRequest;
 const seasons=await api('admin/media');
 if(request!==mediaRequest) return;
 const current=state.season.start;
 const total=seasons.reduce((sum,season)=>sum+Number(season.bytes),0);
 $('#media-usage').textContent='Fotos und Aufnahmen aller Seasons: '+mediaSize(total)+'.';
 setOptions(mediaSelect,seasons.map(season=>{
  const start=new Date(season.start+'T00:00:00Z');
  const next=new Date(start);
  next.setUTCMonth(next.getUTCMonth()+1);
  return [season.start,monthFormat.format(start)+' – '+monthFormat.format(next)+
   (season.start===current?' (laufend)':'')+' · '+season.files+' Dateien · '+mediaSize(season.bytes)];
 }));
 $('#media-export').disabled=!seasons.length;
 if(!seasons.length) setError('#media-status','Es gibt noch keine Fotos oder Aufnahmen.');
}

mediaAdmin.addEventListener('toggle',()=>{
 if(mediaAdmin.open&&mediaOwner&&!mediaBusy){
  loadMediaSeasons().catch(error=>setError('#media-status',error.message));
 }
});
mediaSelect.addEventListener('change',()=>{
 clearMediaDownload();
 setError('#media-status');
});
mediaForm.addEventListener('submit',async event=>{
 event.preventDefault();
 if(!mediaOwner || mediaBusy || !mediaSelect.value) return;
 const season=mediaSelect.value;
 const owner=mediaOwner;
 mediaBusy=true;
 mediaSelect.disabled=true;
 $('#media-export').disabled=true;
 clearMediaDownload();
 setError('#media-status','ZIP wird vorbereitet …');
 try{
  const {backupId,files}=await api('admin/media/'+season);
  if(!files.length) throw new Error('Für diese Season sind keine Dateien vorhanden.');
  const {seasonZip}=await import('./season-media.mjs');
  for(let i=0;i<files.length;i+=4){
   await Promise.all(files.slice(i,i+4).map(async file=>{
    const response=await timedFetch(file.url);
    if(!response.ok) throw new Error('Eine Datei konnte nicht geladen werden. Das ZIP wurde nicht erstellt.');
    file.bytes=new Uint8Array(await response.arrayBuffer());
   }));
   if(owner!==mediaOwner) return;
   setError('#media-status',Math.min(i+4,files.length)+' / '+files.length+' Dateien geladen.');
  }
  mediaZipUrl=URL.createObjectURL(seasonZip(files));
  mediaZipSeason=season;
  mediaBackupId=backupId;
  for(const {filename} of files) backedUpMedia.add(filename.startsWith('Fotos/')?'photos':'voice');
  mediaDownload.href=mediaZipUrl;
  mediaDownload.download='Baywatch-Bootcamp-'+season+'-Medien.zip';
  mediaDownload.hidden=false;
  setError('#media-status','Das ZIP ist bereit. Prüfe die heruntergeladene Datei vor dem Löschen.');
 }catch(error){
  if(owner===mediaOwner) setError('#media-status',error.message);
 }finally{
  mediaBusy=false;
  mediaSelect.disabled=false;
  $('#media-export').disabled=!mediaSelect.value;
  updateMediaDeleteButtons();
 }
});
mediaDownload.addEventListener('click',()=>{
 mediaDownloaded=true;
 updateMediaDeleteButtons();
});
async function deleteBackedUpMedia(kind){
 const season=mediaSelect.value;
 if(!mediaOwner || mediaBusy || !mediaDownloaded || season!==mediaZipSeason) return;
 const label={photos:'Fotos',voice:'Sprachnachrichten',all:'Fotos und Sprachnachrichten'}[kind];
 if(!window.confirm('Hast du das ZIP gespeichert und geprüft? '+label+' aus dieser Sicherung endgültig löschen?')) return;
 mediaBusy=true;
 mediaSelect.disabled=true;
 updateMediaDeleteButtons();
 $('#media-export').disabled=true;
 setError('#media-status','Dateien werden gelöscht …');
 try{
  let result;
  do{
   result=await api('admin/media/delete',{backupId:mediaBackupId,kind,confirm:true});
  }while(result.more);
  if(kind==='all') backedUpMedia.clear();
  else backedUpMedia.delete(kind);
  await loadMediaSeasons();
  if(season!==mediaSelect.value) clearMediaDownload();
  if(season===state.season.start){
   if(kind!=='voice'){
    galleryLinks.clear();
    if(galleryVisible) loadGallery();
    else galleryPhotos=undefined;
   }
   if(kind!=='photos' && voiceArchive.open) loadVoiceArchive();
   await refresh();
  }
  setError('#media-status',label+' aus der Sicherung wurden gelöscht.');
 }catch(error){
  setError('#media-status',error.message);
 }finally{
  mediaBusy=false;
  mediaSelect.disabled=false;
  updateMediaDeleteButtons();
  $('#media-export').disabled=!mediaSelect.value;
 }
}
for(const button of mediaDeleteButtons){
 button.addEventListener('click',()=>deleteBackedUpMedia(button.dataset.deleteMedia));
}
